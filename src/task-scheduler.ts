import { ChildProcess, execFile } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import {
  ASSISTANT_NAME,
  GROUPS_DIR,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';

const execFileAsync = promisify(execFile);
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getCustomerProfileByFolder,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Subscription gate — skip scheduled tasks for non-active customer groups.
  // Groups without a customer_profiles row (e.g. operator group) always proceed.
  // Onboarding tasks (audit + recipe) bypass — they're part of the free trial.
  const isOnboardingTask = task.schedule_type === 'once' &&
    (task.id.startsWith('audit-') || task.id.startsWith('recipe-'));
  const profile = getCustomerProfileByFolder(task.group_folder);
  if (profile && profile.subscription_status !== 'active' && !isOnboardingTask) {
    logger.info(
      {
        taskId: task.id,
        folder: task.group_folder,
        status: profile.subscription_status,
      },
      'Skipping scheduled task — subscription not active',
    );
    const nextRun = computeNextRun(task);
    updateTaskAfterRun(
      task.id,
      nextRun,
      `Skipped: subscription_status=${profile.subscription_status}`,
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // kernel_nudge: direct kernel call — no container, no LLM.
  // Checks for uncategorized transactions; sends a review list only if any exist.
  // ---------------------------------------------------------------------------
  if (task.task_kind === 'kernel_nudge') {
    try {
      const env = readEnvFile([
        'SOLOLEDGER_MASTER_KEY',
        'SOLOLEDGER_KERNEL_PATH',
      ]);
      const kernelDir =
        env.SOLOLEDGER_KERNEL_PATH ||
        path.resolve(process.cwd(), '..', 'kernel');
      const ledger = path.join(GROUPS_DIR, task.group_folder, 'ledger.db');
      const execEnv: NodeJS.ProcessEnv = {
        ...process.env,
        LEDGER_DB: ledger,
        ...(env.SOLOLEDGER_MASTER_KEY
          ? { SOLOLEDGER_MASTER_KEY: env.SOLOLEDGER_MASTER_KEY }
          : {}),
      };

      const { stdout } = await execFileAsync(
        'python3',
        [path.join(kernelDir, 'categorize.py'), 'pending', '--json'],
        { env: execEnv, timeout: 30_000 },
      );

      const raw = stdout.trim();
      let rows: Array<{
        id: string;
        transaction_date: string;
        amount_cents: number;
        raw_description: string;
      }> = [];
      try {
        rows = JSON.parse(raw);
      } catch {
        rows = [];
      }

      const nextRun = computeNextRun(task);
      if (rows.length === 0) {
        // Nothing pending — advance silently, no message
        updateTaskAfterRun(task.id, nextRun, 'Silent: no pending transactions');
        logTaskRun({
          task_id: task.id,
          run_at: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
          status: 'success',
          result: null,
          error: null,
        });
        return;
      }

      // Format and send review list
      const lines = [
        `*${rows.length} transaction${rows.length === 1 ? '' : 's'} need your input:*`,
        '',
      ];
      rows.slice(0, 20).forEach((r, i) => {
        const amount = Math.abs(r.amount_cents) / 100;
        const sign = r.amount_cents > 0 ? '-' : '+';
        const desc = (r.raw_description || r.id).slice(0, 40);
        lines.push(`${i + 1}. ${desc} — ${sign}$${amount.toFixed(2)}`);
      });
      if (rows.length > 20) lines.push(`…and ${rows.length - 20} more.`);
      lines.push('');
      lines.push(
        'Reply with categories, e.g. "1=supplies 2=meals 3=owner draw" — or just tell me what each one is.',
      );
      const msg = lines.join('\n');

      await deps.sendMessage(task.chat_jid, msg);
      updateTaskAfterRun(
        task.id,
        nextRun,
        `Nudge sent: ${rows.length} pending`,
      );
      logTaskRun({
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        status: 'success',
        result: msg.slice(0, 200),
        error: null,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ taskId: task.id, error }, 'kernel_nudge task failed');
      logTaskRun({
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        status: 'error',
        result: null,
        error,
      });
      updateTaskAfterRun(task.id, computeNextRun(task), `Error: ${error}`);
    }
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        ...(task.model && { model: task.model }),
        ...(task.max_turns && { maxTurns: task.max_turns }),
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
