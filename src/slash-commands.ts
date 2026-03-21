/**
 * SoloLedger slash command short-circuits.
 *
 * Handles a pareto set of zero/simple-argument commands at zero LLM cost,
 * before the intent gate or container spawn. Complex operations (recategorize,
 * bulk correction, natural language queries) fall through to the agent.
 *
 * Returns a response string when a command is handled, null otherwise.
 * Caller is responsible for sending the string via channel.sendMessage().
 */
import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

import Database from 'better-sqlite3';

import { GROUPS_DIR } from './config.js';
import { getUsageSummary } from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { NewMessage, RegisteredGroup } from './types.js';

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Command catalog — exported for /help and future docs tooling
// ---------------------------------------------------------------------------

export interface SlashCommandMeta {
  command: string;
  args: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommandMeta[] = [
  {
    command: '/help',
    args: '',
    description: 'Show this command list',
  },
  {
    command: '/status',
    args: '',
    description: 'Pending transaction count + last activity date',
  },
  {
    command: '/report',
    args: 'p&l | bs | cashflow',
    description: 'Financial report — YTD by default',
  },
  {
    command: '/undo',
    args: '',
    description: 'Reverse the last categorization',
  },
  {
    command: '/accounts',
    args: '',
    description: 'List your active chart of accounts',
  },
  {
    command: '/sync',
    args: '',
    description: 'Pull latest transactions from Plaid',
  },
  {
    command: '/usage',
    args: '',
    description: 'Token usage + cost by customer (last 30 days) — admin only',
  },
];

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function ledgerPath(group: RegisteredGroup): string {
  return path.join(GROUPS_DIR, group.folder, 'ledger.db');
}

function kernelPath(): string {
  const env = readEnvFile(['SOLOLEDGER_KERNEL_PATH']);
  return (
    env.SOLOLEDGER_KERNEL_PATH || path.resolve(process.cwd(), '..', 'kernel')
  );
}

// ---------------------------------------------------------------------------
// Python runner — executes a kernel script, returns stdout as trimmed string
// ---------------------------------------------------------------------------

async function runKernel(
  script: string,
  args: string[],
  group: RegisteredGroup,
): Promise<string> {
  const scriptPath = path.join(kernelPath(), script);
  const ledger = ledgerPath(group);

  // SOLOLEDGER_MASTER_KEY needed for vault-backed operations (e.g. sync)
  const secrets = readEnvFile(['SOLOLEDGER_MASTER_KEY']);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LEDGER_DB: ledger,
    ...(secrets.SOLOLEDGER_MASTER_KEY
      ? { SOLOLEDGER_MASTER_KEY: secrets.SOLOLEDGER_MASTER_KEY }
      : {}),
  };

  const { stdout } = await execFileAsync('python3', [scriptPath, ...args], {
    env,
    timeout: EXEC_TIMEOUT_MS,
  });

  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Individual command handlers
// ---------------------------------------------------------------------------

function handleHelp(): string {
  const lines = ['*SoloLedger commands:*', ''];
  for (const cmd of SLASH_COMMANDS) {
    const usage = cmd.args ? `${cmd.command} ${cmd.args}` : cmd.command;
    lines.push(`• \`${usage}\` — ${cmd.description}`);
  }
  lines.push('');
  lines.push('For anything else, just ask in plain language.');
  return lines.join('\n');
}

function handleStatus(group: RegisteredGroup): string {
  const dbFile = ledgerPath(group);
  let db: ReturnType<typeof Database> | null = null;
  try {
    db = new Database(dbFile, { readonly: true });
    const { cnt } = db
      .prepare<
        [],
        { cnt: number }
      >("SELECT COUNT(*) AS cnt FROM transactions WHERE status = 'uncategorized'")
      .get()!;
    const row = db
      .prepare<
        [],
        { last_date: string | null }
      >('SELECT MAX(transaction_date) AS last_date FROM transactions')
      .get()!;
    const lastDate = row.last_date ?? 'no transactions yet';
    if (cnt === 0) {
      return `✓ All caught up. Last transaction: ${lastDate}`;
    }
    return `*${cnt}* transaction${cnt === 1 ? '' : 's'} pending categorization.\nLast transaction: ${lastDate}`;
  } catch (err) {
    logger.warn({ group: group.name, err }, 'slash /status: DB error');
    return 'Could not read ledger — is the database provisioned?';
  } finally {
    db?.close();
  }
}

async function handleReport(
  subcommand: string | undefined,
  group: RegisteredGroup,
): Promise<string> {
  const subMap: Record<string, string> = {
    'p&l': 'pnl',
    pnl: 'pnl',
    bs: 'bs',
    'balance-sheet': 'bs',
    cashflow: 'cashflow',
    cf: 'cashflow',
  };
  const sub = subMap[subcommand?.toLowerCase() ?? ''] ?? 'pnl';
  try {
    const output = await runKernel('report.py', [sub], group);
    return output ? '```\n' + output + '\n```' : 'No data for this period.';
  } catch (err) {
    logger.warn({ group: group.name, err }, `slash /report ${sub}: error`);
    return `Report failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleUndo(group: RegisteredGroup): Promise<string> {
  try {
    const output = await runKernel('reverse.py', ['last'], group);
    return output || 'Nothing to undo.';
  } catch (err) {
    logger.warn({ group: group.name, err }, 'slash /undo: error');
    return `Undo failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleAccounts(group: RegisteredGroup): Promise<string> {
  try {
    const output = await runKernel('coa.py', ['list'], group);
    return output ? '```\n' + output + '\n```' : 'No accounts found.';
  } catch (err) {
    logger.warn({ group: group.name, err }, 'slash /accounts: error');
    return `Could not list accounts: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function handleUsage(): string {
  const rows = getUsageSummary(30);
  if (rows.length === 0) {
    return 'No usage recorded in the last 30 days.';
  }
  const lines = ['*Token usage — last 30 days*', ''];
  for (const row of rows) {
    const cost = row.cost_usd.toFixed(4);
    const inK = (row.input_tokens / 1000).toFixed(1);
    const outK = (row.output_tokens / 1000).toFixed(1);
    const cacheK = ((row.cache_read_tokens + row.cache_write_tokens) / 1000).toFixed(1);
    lines.push(
      `• *${row.group_folder}* — $${cost} (${inK}K in / ${outK}K out / ${cacheK}K cache, ${row.query_count} queries)`,
    );
  }
  return lines.join('\n');
}

async function handleSync(group: RegisteredGroup): Promise<string> {
  try {
    const output = await runKernel('ingest.py', ['sync', group.folder], group);
    return output || 'Sync complete.';
  } catch (err) {
    logger.warn({ group: group.name, err }, 'slash /sync: error');
    const msg = err instanceof Error ? err.message : String(err);
    // Vault not yet configured is the most likely failure mode in early setup
    if (msg.includes('SOLOLEDGER_MASTER_KEY') || msg.includes('vault')) {
      return 'Sync requires the credential vault to be configured. Ask your admin to generate SOLOLEDGER_MASTER_KEY.';
    }
    return `Sync failed: ${msg}`;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Check whether the latest user message is a slash command and handle it.
 *
 * @param messages  Raw messages since last agent timestamp
 * @param group     The registered group being processed
 * @returns         Response string if handled, null if not a slash command
 */
export async function handleSlashCommand(
  messages: NewMessage[],
  group: RegisteredGroup,
): Promise<string | null> {
  // Find the last non-bot message
  const lastUser = [...messages].reverse().find((m) => !m.is_bot_message);

  if (!lastUser) return null;

  const content = lastUser.content.trim();
  if (!content.startsWith('/')) return null;

  // Parse command and optional subcommand
  const [rawCmd, subArg] = content.split(/\s+/, 2);
  const cmd = rawCmd.toLowerCase();

  logger.info({ group: group.name, cmd, subArg }, 'Slash command intercepted');

  // Main group only handles admin commands; all others fall through to the agent.
  if (group.isMain) {
    switch (cmd) {
      case '/usage':
        return handleUsage();
      default:
        return null;
    }
  }

  switch (cmd) {
    case '/help':
      return handleHelp();

    case '/status':
      return handleStatus(group);

    case '/report':
      return handleReport(subArg, group);

    case '/undo':
      return handleUndo(group);

    case '/accounts':
      return handleAccounts(group);

    case '/sync':
      return handleSync(group);

    default:
      // Unknown slash — let the agent handle it naturally
      return null;
  }
}
