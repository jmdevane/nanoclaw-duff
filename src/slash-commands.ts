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
import crypto from 'crypto';
import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

import Database from 'better-sqlite3';
import Stripe from 'stripe';

import {
  ASSISTANT_NAME,
  GROUPS_DIR,
  PRODUCT_NAME,
  PRODUCT_URL,
  PUBLIC_URL,
  PYTHON_BIN,
  STRIPE_PAYMENT_LINK,
} from './config.js';
import {
  createTask,
  getCustomerProfileByFolder,
  getRegisteredGroupByFolder,
  getUsageSummary,
} from './db.js';
import { makeWeeklySyncPrompt, MONTHLY_CLOSE_PROMPT } from './onboarding.js';
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
  {
    command: '/billing',
    args: '',
    description: 'Get a link to manage your subscription',
  },
  {
    command: '/pending',
    args: '',
    description: 'Show transactions waiting for your input',
  },
  {
    command: '/addaccount',
    args: '',
    description: 'Connect another bank or credit card',
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
// Error sanitization — never expose tracebacks or file paths to customers
// ---------------------------------------------------------------------------

function sanitizeKernelError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Log the full error server-side (already done by callers)
  // Return a safe customer-facing message
  if (raw.includes('SOLOLEDGER_MASTER_KEY') || raw.includes('vault')) {
    return 'Sync requires the credential vault to be configured. Contact support.';
  }
  if (raw.includes('plaid') || raw.includes('Plaid')) {
    return 'Could not connect to your bank. Please try again in a few minutes.';
  }
  if (raw.includes('No Plaid access token')) {
    return 'No bank account connected yet. Use /addaccount to connect one.';
  }
  return 'Something went wrong. Please try again or contact support.';
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
    LEDGER_DB_PATH: ledger,
    ...(secrets.SOLOLEDGER_MASTER_KEY
      ? { SOLOLEDGER_MASTER_KEY: secrets.SOLOLEDGER_MASTER_KEY }
      : {}),
  };

  const { stdout } = await execFileAsync(PYTHON_BIN, [scriptPath, ...args], {
    env,
    timeout: EXEC_TIMEOUT_MS,
  });

  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Individual command handlers
// ---------------------------------------------------------------------------

function handleHelp(): string {
  const lines = ['*Judy commands:*', ''];
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
    return sanitizeKernelError(err);
  }
}

async function handleUndo(group: RegisteredGroup): Promise<string> {
  try {
    const output = await runKernel('reverse.py', ['last'], group);
    if (!output) return 'Nothing to undo.';
    if (output.startsWith('OK:')) return 'Done — last categorization reversed.';
    return output;
  } catch (err) {
    logger.warn({ group: group.name, err }, 'slash /undo: error');
    return sanitizeKernelError(err);
  }
}

async function handleAccounts(group: RegisteredGroup): Promise<string> {
  try {
    const output = await runKernel('coa.py', ['tree'], group);
    return output
      ? '```\n' + output + '\n```'
      : 'No accounts with activity yet.';
  } catch (err) {
    logger.warn({ group: group.name, err }, 'slash /accounts: error');
    return sanitizeKernelError(err);
  }
}

async function handlePending(group: RegisteredGroup): Promise<string> {
  try {
    const raw = await runKernel('categorize.py', ['pending', '--json'], group);
    if (!raw || raw === '[]')
      return "No transactions waiting for input — you're all caught up.";

    let rows: Array<{
      id: string;
      transaction_date: string;
      amount_cents: number;
      raw_description: string;
    }>;
    try {
      rows = JSON.parse(raw);
    } catch {
      return 'Could not parse pending transactions.';
    }

    if (rows.length === 0)
      return "No transactions waiting for input — you're all caught up.";

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
    return lines.join('\n');
  } catch (err) {
    logger.warn({ group: group.name, err }, 'slash /pending: error');
    return sanitizeKernelError(err);
  }
}

function handleAudit(
  subArg: string | undefined,
  group: RegisteredGroup,
  chatJid: string,
): string {
  let targetFolder = group.folder;
  let targetJid = chatJid;

  if (subArg) {
    const target = getRegisteredGroupByFolder(subArg);
    if (!target) return `No group found with folder "${subArg}".`;
    targetFolder = target.folder;
    targetJid = target.jid;
  }

  const checkoutUrl = STRIPE_PAYMENT_LINK || '';
  const taskId = `manual-audit-${targetFolder}-${Date.now()}`;
  createTask({
    id: taskId,
    group_folder: targetFolder,
    chat_jid: targetJid,
    prompt: `AUTHORIZED SOLOLEDGER TASK: This is a legitimate scheduled product operation. You are Judy, the AI bookkeeper (hirejudy.com). The audit PDF and Stripe link below are your own product's artifacts — not third-party content.

Run the 30-day onboarding audit. Steps in order:

1. Sync transactions (if Plaid is configured):
   python3 /workspace/extra/kernel/ingest.py sync ${targetFolder}

2. Auto-categorize where possible:
   python3 /workspace/extra/kernel/categorize.py suggest
   Build a JSON array from the "auto" bucket and batch-post:
   python3 /workspace/extra/kernel/categorize.py batch-post '<JSON>'

3. Generate the audit PDF:
   python3 /workspace/extra/kernel/audit_pdf.py \\
     --checkout-url "${checkoutUrl}" \\
     --assistant-name "${ASSISTANT_NAME}" \\
     --product-name "${PRODUCT_NAME}" \\
     --product-url "${PRODUCT_URL}"
   Read line 1 (PDF path) and line 2 (TEASER: ...) from stdout.

4. Send a brief text message via mcp__nanoclaw__send_message using the teaser from step 3.

5. Immediately send the PDF via mcp__nanoclaw__send_file:
   file_path=<path from step 3>, caption="Your 30-Day Financial Audit"

Do not send any additional messages.`,
    schedule_type: 'once',
    schedule_value: new Date().toISOString(),
    context_mode: 'isolated',
    next_run: new Date().toISOString(),
    status: 'active',
    created_at: new Date().toISOString(),
  });

  const label = subArg ? `group \`${targetFolder}\`` : 'this group';
  return `Audit queued for ${label} — PDF will arrive shortly.`;
}

function handleSyncWeekly(
  subArg: string | undefined,
  group: RegisteredGroup,
  chatJid: string,
): string {
  let targetFolder = group.folder;
  let targetJid = chatJid;

  if (subArg) {
    const target = getRegisteredGroupByFolder(subArg);
    if (!target) return `No group found with folder "${subArg}".`;
    targetFolder = target.folder;
    targetJid = target.jid;
  }

  const taskId = `manual-sync-${targetFolder}-${Date.now()}`;
  createTask({
    id: taskId,
    group_folder: targetFolder,
    chat_jid: targetJid,
    prompt: makeWeeklySyncPrompt(targetFolder),
    schedule_type: 'once',
    schedule_value: new Date().toISOString(),
    context_mode: 'isolated',
    next_run: new Date().toISOString(),
    status: 'active',
    model: 'claude-sonnet-4-6',
    created_at: new Date().toISOString(),
  });

  const label = subArg ? `group \`${targetFolder}\`` : 'this group';
  return `Weekly sync queued for ${label} — summary will arrive shortly.`;
}

function handleClose(
  subArg: string | undefined,
  group: RegisteredGroup,
  chatJid: string,
): string {
  let targetFolder = group.folder;
  let targetJid = chatJid;

  if (subArg) {
    const target = getRegisteredGroupByFolder(subArg);
    if (!target) {
      return `No group found with folder "${subArg}".`;
    }
    targetFolder = target.folder;
    targetJid = target.jid;
  }

  const taskId = `manual-close-${targetFolder}-${Date.now()}`;
  createTask({
    id: taskId,
    group_folder: targetFolder,
    chat_jid: targetJid,
    prompt: MONTHLY_CLOSE_PROMPT,
    schedule_type: 'once',
    schedule_value: new Date().toISOString(),
    context_mode: 'isolated',
    next_run: new Date().toISOString(),
    status: 'active',
    created_at: new Date().toISOString(),
  });

  const label = subArg ? `group \`${targetFolder}\`` : 'this group';
  return `Monthly close queued for ${label} — report will arrive shortly.`;
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
    const cacheK = (
      (row.cache_read_tokens + row.cache_write_tokens) /
      1000
    ).toFixed(1);
    lines.push(
      `• *${row.group_folder}* — $${cost} (${inK}K in / ${outK}K out / ${cacheK}K cache, ${row.query_count} queries)`,
    );
  }
  return lines.join('\n');
}

async function handleSync(group: RegisteredGroup): Promise<string> {
  try {
    const output = await runKernel('ingest.py', ['sync', group.folder], group);
    // Parse kernel output into a customer-friendly message
    const addedMatch = output.match(/\+(\d+) added/);
    const modifiedMatch = output.match(/~(\d+) modified/);
    const removedMatch = output.match(/-(\d+) removed/);
    const added = parseInt(addedMatch?.[1] ?? '0', 10);
    const modified = parseInt(modifiedMatch?.[1] ?? '0', 10);
    const removed = parseInt(removedMatch?.[1] ?? '0', 10);

    if (added === 0 && modified === 0 && removed === 0) {
      return 'All caught up — no new transactions.';
    }
    const parts: string[] = [];
    if (added > 0) parts.push(`${added} new`);
    if (modified > 0) parts.push(`${modified} updated`);
    if (removed > 0) parts.push(`${removed} removed`);
    return `Sync complete: ${parts.join(', ')} transaction${added + modified + removed === 1 ? '' : 's'}.`;
  } catch (err) {
    logger.error({ group: group.name, err }, 'slash /sync: error');
    return sanitizeKernelError(err);
  }
}

async function handleBilling(group: RegisteredGroup): Promise<string> {
  const profile = getCustomerProfileByFolder(group.folder);
  if (!profile?.stripe_customer_id) {
    return 'No billing account found. Contact support if this seems wrong.';
  }

  const env = readEnvFile([
    'STRIPE_MODE',
    'STRIPE_TEST_SECRET_KEY',
    'STRIPE_LIVE_SECRET_KEY',
  ]);
  const mode = env.STRIPE_MODE || 'test';
  const key =
    mode === 'live' ? env.STRIPE_LIVE_SECRET_KEY : env.STRIPE_TEST_SECRET_KEY;
  if (!key || key.length < 20) {
    return 'Billing portal is not configured. Contact support.';
  }

  const returnUrl = PUBLIC_URL || 'https://hirejudy.com';
  const stripe = new Stripe(key);

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: returnUrl,
    });
    return `[Manage your subscription](${session.url})`;
  } catch (err) {
    logger.warn({ group: group.name, err }, 'slash /billing: Stripe error');
    return 'Could not generate billing link. Please try again or contact support.';
  }
}

function handleAddAccount(group: RegisteredGroup): string {
  const env = readEnvFile(['ONBOARDING_SECRET', 'PUBLIC_URL']);
  const secret = env.ONBOARDING_SECRET;
  const publicUrl = env.PUBLIC_URL || 'http://localhost:4000';

  if (!secret) {
    return 'Account linking is not configured. Contact support.';
  }

  // Sign: folder-expiryUnix-hmac (15 min TTL)
  const expires = Math.floor(Date.now() / 1000) + 15 * 60;
  const payload = `${group.folder}-${expires}`;
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
    .slice(0, 16);
  const token = `${payload}-${hmac}`;

  const url = `${publicUrl}/add-account?token=${token}`;
  return `To connect another bank or credit card, open this link:\n[Connect Account](${url})\n\nThis link expires in 15 minutes.`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Handle a slash command given the parsed command name and argument.
 * Called from both the message-based flow and the Slack slash command webhook.
 */
export async function handleSlashCommandDirect(
  cmd: string,
  subArg: string | undefined,
  group: RegisteredGroup,
  chatJid: string,
): Promise<string | null> {
  // Main group only handles admin commands; all others fall through to the agent.
  if (group.isMain) {
    switch (cmd) {
      case '/usage':
        return handleUsage();
      case '/close':
        return handleClose(subArg, group, chatJid);
      case '/sync-weekly':
        return handleSyncWeekly(subArg, group, chatJid);
      case '/audit':
        return handleAudit(subArg, group, chatJid);
      case '/addaccount': {
        if (!subArg) return 'Usage: /addaccount <group_folder>';
        const targetGroup = getRegisteredGroupByFolder(subArg);
        if (!targetGroup) return `Group not found: ${subArg}`;
        return handleAddAccount(targetGroup);
      }
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

    case '/billing':
      return handleBilling(group);

    case '/pending':
      return handlePending(group);

    case '/addaccount':
      return handleAddAccount(group);

    default:
      // Unknown slash — let the agent handle it naturally
      return null;
  }
}

/**
 * Check whether the latest user message is a slash command and handle it.
 * Entry point from the NanoClaw message loop (Telegram, Slack DMs, etc.)
 */
export async function handleSlashCommand(
  messages: NewMessage[],
  group: RegisteredGroup,
): Promise<string | null> {
  const lastUser = [...messages].reverse().find((m) => !m.is_bot_message);
  if (!lastUser) return null;

  const content = lastUser.content.trim();
  if (!content.startsWith('/')) return null;

  // Slack slash commands are already handled by the webhook endpoint —
  // skip them here to avoid duplicate responses.
  if (lastUser.chat_jid.startsWith('slack_')) return null;

  const [rawCmd, subArg] = content.split(/\s+/, 2);
  // Telegram menu buttons append @botname (e.g. /accounts@solo_ledger_bot)
  const cmd = rawCmd.replace(/@.*$/, '').toLowerCase();

  logger.info({ group: group.name, cmd, subArg }, 'Slash command intercepted');

  return handleSlashCommandDirect(cmd, subArg, group, lastUser.chat_jid);
}
