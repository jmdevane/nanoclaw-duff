/**
 * SoloLedger onboarding web service.
 *
 * Runs on port 4000 (ONBOARDING_PORT). Handles:
 *   - Plaid Link widget (connect bank accounts)
 *   - HMAC-signed Telegram deep-link generation (15-min TTL, single-use)
 *   - /start validation → provision.py → audit task + recipe task
 *   - Stripe Checkout session creation (if STRIPE_PRICE_ID is configured)
 *
 * Security:
 *   - Plaid access_token stored in credential vault via provision.py (never logged)
 *   - HMAC token: SHA-256 with ONBOARDING_SECRET, 15-min TTL, single-use flag
 *   - Server binds to 0.0.0.0 (Tailscale-accessible); Provision API not exposed
 */
import crypto from 'crypto';
import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import type { RegisteredGroup } from './types.js';

import express, { Request, Response } from 'express';
import { CronExpressionParser } from 'cron-parser';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import Stripe from 'stripe';

import {
  ASSISTANT_NAME,
  GROUPS_DIR,
  ONBOARDING_PORT,
  PRODUCT_NAME,
  PRODUCT_URL,
  PUBLIC_URL,
  STRIPE_PAYMENT_LINK,
  TIMEZONE,
} from './config.js';
import {
  countActiveCustomers,
  createOnboardingSession,
  createTask,
  getAllRegisteredGroups,
  getCustomerProfileByFolder,
  getCustomerProfileByPlaidItemId,
  getCustomerProfileBySubscriptionId,
  getMainGroup,
  getOnboardingSession,
  getRegisteredGroupByFolder,
  getTasksForGroup,
  markSessionUsed,
  updateCustomerSubscription,
} from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);
const PROVISION_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Monthly close prompt — shared with slash-commands /close handler
// ---------------------------------------------------------------------------

export const MONTHLY_CLOSE_PROMPT = `Run the monthly close report for last month. Use the current date to determine last month's first and last day (YYYY-MM-DD format).

Delivery order matters — complete all steps in sequence:

1. Data gathering (run both, do not send yet):
   python3 /workspace/extra/kernel/report.py pnl --from FIRST --to LAST
   python3 /workspace/extra/kernel/report.py bs

2. Waterfall chart:
   python3 /workspace/extra/kernel/chart.py waterfall --from FIRST --to LAST
   The very next tool call must be: mcp__nanoclaw__send_file(file_path=<returned_path>, caption="[Month Year] Income & Expenses")

3. Narrative — send via mcp__nanoclaw__send_message:
   2–3 sentences in plain prose (no bullets, no markdown headings): net income or loss for the month, the top expense category and its amount, and ending cash balance from the balance sheet.

4. Month P&L — send the output from step 1 as a code block via mcp__nanoclaw__send_message.

5. YTD P&L (January 1st of the current year through the last day of last month):
   python3 /workspace/extra/kernel/report.py pnl --from YYYY-01-01 --to LAST
   Send as a code block via mcp__nanoclaw__send_message.

6. One data-driven follow-up suggestion based on what the numbers showed — send via mcp__nanoclaw__send_message.`;

// ---------------------------------------------------------------------------
// Secrets — read from .env each call (not cached — hot-reloadable)
// ---------------------------------------------------------------------------

function secrets() {
  return readEnvFile([
    'ONBOARDING_SECRET',
    'BOT_USERNAME',
    'PLAID_CLIENT_ID',
    'PLAID_API_KEY_TEST',
    'PLAID_API_KEY_PROD',
    'PLAID_ENV',
    'STRIPE_MODE',
    'STRIPE_TEST_SECRET_KEY',
    'STRIPE_LIVE_SECRET_KEY',
    'STRIPE_TEST_WEBHOOK_SECRET',
    'STRIPE_LIVE_WEBHOOK_SECRET',
    'STRIPE_TEST_PAYMENT_LINK_MONTHLY',
    'STRIPE_TEST_PAYMENT_LINK_ANNUAL',
    'STRIPE_LIVE_PAYMENT_LINK_MONTHLY',
    'STRIPE_LIVE_PAYMENT_LINK_ANNUAL',
    'SOLOLEDGER_KERNEL_PATH',
    'SOLOLEDGER_MASTER_KEY',
    'WAITLIST_MODE',
    'MAX_ACTIVE_CUSTOMERS',
  ]);
}

// ---------------------------------------------------------------------------
// Weekly sync prompt — folder interpolated at task creation time
// ---------------------------------------------------------------------------

export function makeWeeklySyncPrompt(folder: string): string {
  return `Run the weekly transaction sync for group ${folder}.

Steps in order:

1. Baseline — record the last transaction date before syncing (used for net cash period):
   Run: sqlite3 /workspace/group/ledger.db "SELECT COALESCE(MAX(transaction_date), date('now','-7 days')) FROM transactions WHERE status != 'uncategorized'"
   Store this as LAST_SYNC_DATE.

2. Sync new transactions:
   python3 /workspace/extra/kernel/ingest.py sync ${folder}

3. Get categorization suggestions (auto/review buckets):
   python3 /workspace/extra/kernel/categorize.py suggest
   Parse the JSON output.

4. Auto-post all transactions in the "auto" bucket:
   For each item: python3 /workspace/extra/kernel/categorize.py post {txn_id} {suggested_account} {credit_account}
   If the "auto" bucket is empty, skip this step.

5. Anomaly scan — check ALL transactions (both buckets) since LAST_SYNC_DATE for:
   - Amounts unusually large for their category compared to past history
   - First-time merchants that were auto-categorized (worth a mention)
   - Possible personal charges on business accounts (round numbers, lifestyle merchants, person-to-person)
   - Potential duplicates (same merchant, same amount within 7 days)
   Be graceful — if transaction history is sparse or nothing genuinely stands out, omit this section entirely.

6. Net cash since last sync:
   python3 /workspace/extra/kernel/report.py pnl --from LAST_SYNC_DATE --to TODAY
   Extract net cash movement for the summary.

7. Send the summary via mcp__nanoclaw__send_message.

   If new transactions were found:
   "Weekly sync complete.

   Synced X transactions — Y auto-categorized. *Net cash: ±$Z* (last sync: LAST_SYNC_DATE)
   [If anomalies: Notable: one-line anomaly note]"

   If the "review" bucket is non-empty, send a SECOND message immediately after:
   "X transactions need your input:
   1. MERCHANT — $X.XX
   2. MERCHANT — $X.XX

   Reply with categories, e.g. "1=supplies 2=meals 3=owner draw" — or just tell me what each one is."

   If no new transactions came in:
   "No new transactions since LAST_SYNC_DATE. Your books are current. *Last week's net cash: ±$Z.*"

Do not send any further messages after the summary and review list. No "Done" recap, no step-by-step log.`;
}

// ---------------------------------------------------------------------------
// Scheduled task seeder — called at provision AND at startup (backfill)
// ---------------------------------------------------------------------------

/**
 * Seed all standard recurring tasks for a customer group.
 * Idempotent — checks for existing tasks before inserting.
 * Add new task types here; they propagate to existing groups on next startup.
 */
export function seedScheduledTasks(folder: string, chatJid: string): void {
  const existingTasks = getTasksForGroup(folder);

  // Monthly close — 3rd of month, 9am CST
  const hasMonthlyClose = existingTasks.some(
    (t) => t.schedule_type === 'cron' && t.schedule_value === '0 9 3 * *',
  );
  if (!hasMonthlyClose) {
    const closeNextRun = CronExpressionParser.parse('0 9 3 * *', {
      tz: TIMEZONE,
    })
      .next()
      .toISOString();
    createTask({
      id: `monthly-close-${folder}`,
      group_folder: folder,
      chat_jid: chatJid,
      prompt: MONTHLY_CLOSE_PROMPT,
      schedule_type: 'cron',
      schedule_value: '0 9 3 * *',
      context_mode: 'isolated',
      next_run: closeNextRun,
      status: 'active',
      model: 'claude-sonnet-4-6',
      created_at: new Date().toISOString(),
    });
    logger.info({ folder, chatJid }, 'Seeded monthly-close task');
  }

  // Weekly sync — Monday 9am CST
  const hasWeeklySync = existingTasks.some(
    (t) => t.schedule_type === 'cron' && t.schedule_value === '0 9 * * 1',
  );
  if (!hasWeeklySync) {
    const syncNextRun = CronExpressionParser.parse('0 9 * * 1', {
      tz: TIMEZONE,
    })
      .next()
      .toISOString();
    createTask({
      id: `weekly-sync-${folder}`,
      group_folder: folder,
      chat_jid: chatJid,
      prompt: makeWeeklySyncPrompt(folder),
      schedule_type: 'cron',
      schedule_value: '0 9 * * 1',
      context_mode: 'isolated',
      next_run: syncNextRun,
      status: 'active',
      model: 'claude-sonnet-4-6',
      created_at: new Date().toISOString(),
    });
    logger.info({ folder, chatJid }, 'Seeded weekly-sync task');
  }

  // Daily nudge — 6pm CST, kernel_nudge (no container, no LLM)
  // Sends a review list only if uncategorized transactions exist; silent otherwise.
  const hasDailyNudge = existingTasks.some(
    (t) => t.schedule_type === 'cron' && t.schedule_value === '0 18 * * *',
  );
  if (!hasDailyNudge) {
    const nudgeNextRun = CronExpressionParser.parse('0 18 * * *', {
      tz: TIMEZONE,
    })
      .next()
      .toISOString();
    createTask({
      id: `daily-nudge-${folder}`,
      group_folder: folder,
      chat_jid: chatJid,
      prompt: 'daily_nudge',
      schedule_type: 'cron',
      schedule_value: '0 18 * * *',
      context_mode: 'isolated',
      next_run: nudgeNextRun,
      status: 'active',
      task_kind: 'kernel_nudge',
      created_at: new Date().toISOString(),
    });
    logger.info({ folder, chatJid }, 'Seeded daily-nudge task');
  }
}

/**
 * Backfill scheduled tasks for all existing customer groups at startup.
 * Safe to call every boot — seedScheduledTasks is idempotent.
 */
export function seedAllCustomerTasks(): void {
  const groups = getAllRegisteredGroups();
  let seeded = 0;
  for (const [jid, group] of Object.entries(groups)) {
    if (group.isMain) continue;
    const profile = getCustomerProfileByFolder(group.folder);
    if (!profile) continue; // Not a customer group
    seedScheduledTasks(group.folder, jid);
    seeded++;
  }
  if (seeded > 0) {
    logger.info({ count: seeded }, 'Startup task seed complete');
  }
}

// ---------------------------------------------------------------------------
// Plaid client
// ---------------------------------------------------------------------------

function makePlaidClient(): PlaidApi {
  const s = secrets();
  const env = s.PLAID_ENV || 'sandbox';
  const clientId = s.PLAID_CLIENT_ID || '';
  const secret =
    env === 'production' ? s.PLAID_API_KEY_PROD : s.PLAID_API_KEY_TEST;

  if (!clientId || !secret) {
    throw new Error(
      'Plaid credentials not configured (PLAID_CLIENT_ID, PLAID_API_KEY_TEST)',
    );
  }

  const basePath =
    PlaidEnvironments[env as keyof typeof PlaidEnvironments] ??
    PlaidEnvironments.sandbox;

  return new PlaidApi(
    new Configuration({
      basePath,
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': clientId,
          'PLAID-SECRET': secret,
        },
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Stripe client
// ---------------------------------------------------------------------------

function makeStripeClient(): Stripe | null {
  const s = secrets();
  const mode = s.STRIPE_MODE || 'test';
  const key =
    mode === 'live' ? s.STRIPE_LIVE_SECRET_KEY : s.STRIPE_TEST_SECRET_KEY;
  if (!key || key.length < 20) return null;
  return new Stripe(key);
}

// ---------------------------------------------------------------------------
// HMAC token management
// Format: {session_id_8hex}-{expires_unix_10d}-{hmac_16hex}  (36 chars total)
// All chars are alphanumeric + dashes — valid Telegram /start payload
// ---------------------------------------------------------------------------

function signToken(sessionId: string, expiresAt: Date): string {
  const s = secrets();
  const secret = s.ONBOARDING_SECRET;
  if (!secret) throw new Error('ONBOARDING_SECRET not configured');

  const expiry = Math.floor(expiresAt.getTime() / 1000).toString();
  const payload = `${sessionId}-${expiry}`;
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
    .slice(0, 16);
  return `${payload}-${hmac}`;
}

function verifyToken(
  token: string,
): { sessionId: string; expiresAt: Date } | null {
  const s = secrets();
  const secret = s.ONBOARDING_SECRET;
  if (!secret) return null;

  // Token: {8hex}-{10digits}-{16hex}
  const lastDash = token.lastIndexOf('-');
  const secondLastDash = token.lastIndexOf('-', lastDash - 1);
  if (lastDash === -1 || secondLastDash === -1) return null;

  const sessionId = token.slice(0, secondLastDash);
  const expiryStr = token.slice(secondLastDash + 1, lastDash);
  const hmac = token.slice(lastDash + 1);

  if (!sessionId || !expiryStr || hmac.length !== 16) return null;

  const payload = `${sessionId}-${expiryStr}`;
  const expectedHmac = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
    .slice(0, 16);

  // Constant-time comparison to prevent timing attacks
  try {
    if (
      !crypto.timingSafeEqual(
        Buffer.from(hmac, 'hex'),
        Buffer.from(expectedHmac, 'hex'),
      )
    ) {
      return null;
    }
  } catch {
    return null;
  }

  const expiresAt = new Date(parseInt(expiryStr, 10) * 1000);
  if (isNaN(expiresAt.getTime()) || expiresAt < new Date()) return null;

  return { sessionId, expiresAt };
}

// ---------------------------------------------------------------------------
// Telegram deep link helper
// ---------------------------------------------------------------------------

function telegramDeepLink(botUsername: string, token: string): string {
  return `https://t.me/${botUsername}?start=${token}`;
}

// ---------------------------------------------------------------------------
// provision.py subprocess
// ---------------------------------------------------------------------------

async function runProvision(
  folder: string,
  chatJid: string,
  groupName: string,
  plaidToken: string,
  plaidItemId: string,
): Promise<void> {
  const s = secrets();
  const kernelPath =
    s.SOLOLEDGER_KERNEL_PATH || path.resolve(process.cwd(), '..', 'kernel');
  const scriptPath = path.join(kernelPath, 'provision.py');

  const args = [
    scriptPath,
    folder,
    '--assistant-name',
    ASSISTANT_NAME,
    '--group-name',
    groupName,
    '--jid',
    chatJid,
    '--channel-type',
    'telegram',
    '--channel-identity',
    chatJid,
    '--plaid-token',
    plaidToken,
    '--plaid-item-id',
    plaidItemId,
  ];

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(s.SOLOLEDGER_MASTER_KEY
      ? { SOLOLEDGER_MASTER_KEY: s.SOLOLEDGER_MASTER_KEY }
      : {}),
  };

  const { stdout } = await execFileAsync('python3', args, {
    env,
    timeout: PROVISION_TIMEOUT_MS,
  });
  logger.info({ folder, output: stdout.trim() }, 'provision.py complete');
}

// ---------------------------------------------------------------------------
// Stripe — resolve checkout URL
// Payment Link checkout URLs — append client_reference_id per customer.
// No API call needed; links never expire.
// ---------------------------------------------------------------------------

function resolveCheckoutUrls(folder: string): {
  monthly: string;
  annual: string;
} {
  const s = secrets();
  const isLive = (s.STRIPE_MODE || 'test') === 'live';
  const monthlyLink = isLive
    ? s.STRIPE_LIVE_PAYMENT_LINK_MONTHLY || ''
    : s.STRIPE_TEST_PAYMENT_LINK_MONTHLY || '';
  const annualLink = isLive
    ? s.STRIPE_LIVE_PAYMENT_LINK_ANNUAL || ''
    : s.STRIPE_TEST_PAYMENT_LINK_ANNUAL || '';

  const withRef = (url: string): string => {
    if (!url) return '';
    try {
      const u = new URL(url);
      u.searchParams.set('client_reference_id', folder);
      return u.toString();
    } catch {
      return url;
    }
  };

  return { monthly: withRef(monthlyLink), annual: withRef(annualLink) };
}

// ---------------------------------------------------------------------------
// Stripe webhook event handler
// ---------------------------------------------------------------------------

async function handleStripeEvent(
  event: Stripe.Event,
  deps: OnboardingDeps,
): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;

      // Resolve folder from client_reference_id (set when building the checkout URL)
      // or metadata.folder (set by dynamic checkout session fallback).
      const folder =
        session.client_reference_id ?? session.metadata?.folder ?? null;
      if (!folder) {
        logger.warn(
          { eventId: event.id },
          'checkout.session.completed: no folder in client_reference_id or metadata — skipping',
        );
        return;
      }

      const profile = getCustomerProfileByFolder(folder);
      if (!profile) {
        logger.warn(
          { folder, eventId: event.id },
          'checkout.session.completed: no customer_profiles row found — skipping',
        );
        return;
      }

      const stripeCustomerId =
        typeof session.customer === 'string'
          ? session.customer
          : ((session.customer as Stripe.Customer | null)?.id ?? null);
      const stripeSubscriptionId =
        typeof session.subscription === 'string'
          ? session.subscription
          : ((session.subscription as Stripe.Subscription | null)?.id ?? null);
      const email = session.customer_details?.email ?? null;
      // company_name: try Stripe's built-in business name field (key varies),
      // then the old custom field key, then customer_details.name as fallback.
      const companyField = (session.custom_fields ?? []).find(
        (f) => f.key === 'business_name' || f.key === 'company_name',
      );
      const companyName =
        companyField?.text?.value ?? session.customer_details?.name ?? null;

      updateCustomerSubscription(folder, {
        stripe_customer_id: stripeCustomerId,
        stripe_subscription_id: stripeSubscriptionId,
        subscription_status: 'active',
        email,
        company_name: companyName,
        activated_at: new Date().toISOString(),
      });

      logger.info(
        { folder, stripeCustomerId, stripeSubscriptionId },
        'Subscription activated via checkout.session.completed',
      );

      // Confirmation message — direct send, never through agent
      await deps.sendMessage(
        profile.channel_identity,
        `You're all set. Your books are live.\n\nAsk me anything about your finances — or try: "What are my top 5 expenses this month?"`,
      );
      break;
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription;
      const profile = getCustomerProfileBySubscriptionId(subscription.id);
      if (!profile) {
        logger.debug(
          { subId: subscription.id },
          'customer.subscription.updated: no matching profile — skipping',
        );
        return;
      }

      // Map Stripe subscription statuses to our statuses.
      // Note: 'canceled' is intentionally excluded here — when a customer
      // cancels via the portal, Stripe sets cancel_at_period_end=true but
      // the status remains 'active' until the period ends. Access is preserved
      // until customer.subscription.deleted fires (end of billing period).
      // Immediate cancellations also emit customer.subscription.deleted,
      // so that handler covers both cases.
      const statusMap: Record<string, 'active' | 'past_due'> = {
        active: 'active',
        trialing: 'active',
        past_due: 'past_due',
        unpaid: 'past_due',
      };
      const newStatus = statusMap[subscription.status] ?? null;

      // Send a heads-up if cancellation is scheduled at period end
      const cancelAt = subscription.cancel_at
        ? new Date(subscription.cancel_at * 1000)
        : null;
      if (subscription.cancel_at_period_end && cancelAt) {
        const dateStr = cancelAt.toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        });
        deps
          .sendMessage(
            profile.channel_identity,
            `Your SoloLedger subscription is set to end on ${dateStr}. You'll have full access until then. Reply /billing any time to manage your subscription.`,
          )
          .catch((err) =>
            logger.error(
              { err, folder: profile.group_folder },
              'Failed to send cancellation notice',
            ),
          );
      }

      const item = subscription.items?.data?.[0];
      const interval = item?.price?.recurring?.interval;
      const plan: 'monthly' | 'annual' | null =
        interval === 'month'
          ? 'monthly'
          : interval === 'year'
            ? 'annual'
            : null;

      const periodEnd = new Date(
        subscription.current_period_end * 1000,
      ).toISOString();

      updateCustomerSubscription(profile.group_folder, {
        ...(newStatus ? { subscription_status: newStatus } : {}),
        ...(plan ? { plan } : {}),
        current_period_end: periodEnd,
      });

      logger.info(
        {
          folder: profile.group_folder,
          newStatus,
          plan,
          periodEnd,
        },
        'Subscription updated via customer.subscription.updated',
      );
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      const profile = getCustomerProfileBySubscriptionId(subscription.id);
      if (!profile) {
        logger.debug(
          { subId: subscription.id },
          'customer.subscription.deleted: no matching profile — skipping',
        );
        return;
      }

      updateCustomerSubscription(profile.group_folder, {
        subscription_status: 'cancelled',
        cancelled_at: new Date().toISOString(),
      });

      logger.info(
        { folder: profile.group_folder },
        'Subscription cancelled via customer.subscription.deleted',
      );

      await deps.sendMessage(
        profile.channel_identity,
        `Your SoloLedger subscription has ended. Your books and history are preserved — reply /billing any time to reactivate.`,
      );
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const subId =
        typeof invoice.subscription === 'string'
          ? invoice.subscription
          : ((invoice.subscription as Stripe.Subscription | null)?.id ?? null);

      if (!subId) {
        logger.debug(
          { invoiceId: invoice.id },
          'invoice.payment_failed: no subscription on invoice — skipping',
        );
        return;
      }

      const profile = getCustomerProfileBySubscriptionId(subId);
      if (!profile) {
        logger.debug(
          { subId },
          'invoice.payment_failed: no matching profile — skipping',
        );
        return;
      }

      updateCustomerSubscription(profile.group_folder, {
        subscription_status: 'past_due',
      });

      logger.info(
        { folder: profile.group_folder },
        'Subscription marked past_due via invoice.payment_failed',
      );

      await deps.sendMessage(
        profile.channel_identity,
        `There's an issue with your SoloLedger payment — the latest charge didn't go through. Please update your payment method to keep your books running. Reply /billing for a link to manage your subscription.`,
      );
      break;
    }

    default:
      logger.debug({ type: event.type }, 'Unhandled Stripe webhook event');
  }
}

// ---------------------------------------------------------------------------
// Deps interface (injected from index.ts)
// ---------------------------------------------------------------------------

export interface OnboardingDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  loadGroups: () => void;
  isRegistered: (jid: string) => boolean;
}

// ---------------------------------------------------------------------------
// Telegram /start handler — exported for telegram.ts to call
// ---------------------------------------------------------------------------

export async function handleTelegramStart(
  chatJid: string,
  token: string,
  deps: OnboardingDeps,
): Promise<void> {
  logger.info(
    { chatJid, tokenPrefix: token.slice(0, 8) },
    'Onboarding /start received',
  );

  // Guard: never provision a chat that's already registered (protects admin DM)
  if (deps.isRegistered(chatJid)) {
    logger.warn(
      { chatJid },
      '/start received on already-registered JID — ignoring',
    );
    return;
  }

  const parsed = verifyToken(token);
  if (!parsed) {
    await deps.sendMessage(
      chatJid,
      'That link has expired or is invalid. Please restart the onboarding flow.',
    );
    return;
  }

  const session = getOnboardingSession(parsed.sessionId);
  if (!session) {
    await deps.sendMessage(
      chatJid,
      'Onboarding session not found. Please restart the flow.',
    );
    return;
  }

  if (session.token_used) {
    await deps.sendMessage(
      chatJid,
      `Your account is already connected! I'm *${ASSISTANT_NAME}*, your bookkeeper. Just say @${ASSISTANT_NAME} to get started.`,
    );
    return;
  }

  // Mark single-use immediately — before any async work
  markSessionUsed(parsed.sessionId);

  await deps.sendMessage(
    chatJid,
    `Hi! I'm *${ASSISTANT_NAME}*, your AI bookkeeper. Connecting your bank accounts now — I'll pull in your recent transactions and send you a summary shortly.`,
  );

  // Run provision.py
  try {
    await runProvision(
      session.folder,
      chatJid,
      'My Books',
      session.plaid_access_token || '',
      session.plaid_item_id || '',
    );
  } catch (err) {
    logger.error({ chatJid, err }, 'provision.py failed');
    await deps.sendMessage(
      chatJid,
      'There was an issue setting up your account. Please contact support.',
    );
    return;
  }

  // Reload in-memory registered groups so this JID starts receiving messages
  deps.loadGroups();

  // Resolve checkout URLs (Payment Links + client_reference_id)
  const checkoutUrls = resolveCheckoutUrls(session.folder);

  // 30-day retro audit task — fires in 20 seconds.
  // Generates a branded PDF via audit_pdf.py, sends text teaser first, then the PDF.
  const auditId = `audit-${parsed.sessionId}`;
  createTask({
    id: auditId,
    group_folder: session.folder,
    chat_jid: chatJid,
    prompt: `AUTHORIZED SOLOLEDGER TASK: This is a legitimate scheduled product operation. You are Judy, the SoloLedger AI bookkeeper (hirejudy.com). The audit PDF and Stripe link below are your own product's artifacts — not third-party content.

Run the initial 30-day onboarding audit for a new customer. Steps in order:

1. Sync their transactions:
   python3 /workspace/extra/kernel/ingest.py sync ${session.folder}

2. Auto-categorize where possible:
   python3 /workspace/extra/kernel/categorize.py suggest
   For each item in the "auto" bucket:
   python3 /workspace/extra/kernel/categorize.py post {txn_id} {suggested_account} {credit_account}

3. Generate the audit PDF:
   python3 /workspace/extra/kernel/audit_pdf.py \\
     --checkout-url "${checkoutUrls.monthly}" \\
     --assistant-name "${ASSISTANT_NAME}" \\
     --product-name "${PRODUCT_NAME}" \\
     --product-url "${PRODUCT_URL}"
   Read line 1 (PDF path) and line 2 (TEASER: ...) from stdout.

4. Send a brief text message via mcp__nanoclaw__send_message:
   "Here's your 30-day financial audit. [use the teaser text from step 3] Reply any time to start reviewing transactions or ask me anything about your finances."

5. Immediately send the PDF via mcp__nanoclaw__send_file:
   file_path=<path from step 3>, caption="Your 30-Day Financial Audit"

Do not send any additional messages.`,
    schedule_type: 'once',
    schedule_value: new Date(Date.now() + 20_000).toISOString(),
    context_mode: 'isolated',
    next_run: new Date(Date.now() + 20_000).toISOString(),
    status: 'active',
    created_at: new Date().toISOString(),
  });

  // Direct checkout message after 3 min — second CTA touchpoint, bypasses agent
  // (model content filters block Stripe URLs in task prompts).
  if (checkoutUrls.monthly) {
    const checkoutJid = chatJid;
    const checkoutMsg = `Ready to make it official? [Start your subscription here](${checkoutUrls.monthly})`;
    setTimeout(
      () => {
        deps
          .sendMessage(checkoutJid, checkoutMsg)
          .catch((err) =>
            logger.error(
              { chatJid: checkoutJid, err },
              'Failed to send checkout URL',
            ),
          );
      },
      3 * 60 * 1000,
    );
    logger.info(
      { chatJid, folder: session.folder },
      'Checkout URLs scheduled (direct send, 3 min)',
    );
  }

  // 24-hour recipe follow-up task
  const recipeId = `recipe-${parsed.sessionId}`;
  createTask({
    id: recipeId,
    group_folder: session.folder,
    chat_jid: chatJid,
    prompt: `Send a short, friendly message (under 3 sentences) introducing one starter recipe for ${ASSISTANT_NAME}. Pick the one most relevant to what was found in the initial audit:

- "Categorize this week's expenses" — @${ASSISTANT_NAME} categorize pending transactions
- "Monthly P&L snapshot" — @${ASSISTANT_NAME} show me this month's P&L
- "Find deductible expenses" — @${ASSISTANT_NAME} what can I deduct this quarter?

Keep it conversational, not salesy. No bullet points — just a natural message.`,
    schedule_type: 'once',
    schedule_value: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    context_mode: 'isolated',
    next_run: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    status: 'active',
    created_at: new Date().toISOString(),
  });

  // Seed all standard recurring tasks (monthly close + weekly sync)
  seedScheduledTasks(session.folder, chatJid);

  logger.info(
    { chatJid, folder: session.folder, auditId, recipeId },
    'Onboarding complete — audit, recipe, and recurring tasks scheduled',
  );
}

// ---------------------------------------------------------------------------
// Landing page HTML
// ---------------------------------------------------------------------------

function landingPage(publicUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SoloLedger — Get started</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #f9fafb; min-height: 100vh; display: flex;
           align-items: center; justify-content: center; padding: 24px; }
    .card { background: #fff; border-radius: 12px; padding: 40px 32px;
            max-width: 480px; width: 100%; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
    h1 { font-size: 1.35rem; font-weight: 700; margin-bottom: 8px; color: #111; }
    .subtitle { color: #555; font-size: 0.95rem; margin-bottom: 28px; line-height: 1.55; }
    .steps { margin-bottom: 28px; }
    .step { display: flex; gap: 12px; margin-bottom: 14px; align-items: flex-start; }
    .step-num { background: #1a73e8; color: #fff; border-radius: 50%;
                width: 24px; height: 24px; min-width: 24px; display: flex;
                align-items: center; justify-content: center;
                font-size: 0.78rem; font-weight: 700; margin-top: 1px; }
    .step-text { font-size: 0.9rem; color: #374151; line-height: 1.45; }
    .btn { display: block; width: 100%; padding: 14px;
           font-size: 1rem; font-weight: 600; cursor: pointer;
           border: none; border-radius: 8px; background: #1a73e8;
           color: #fff; transition: background .15s; }
    .btn:hover { background: #1557b0; }
    .btn:disabled { background: #9ca3af; cursor: default; }
    /* Channel selector */
    .channel-grid { display: flex; gap: 12px; margin-bottom: 8px; }
    .channel-btn { flex: 1; display: flex; flex-direction: column; align-items: center;
                   gap: 8px; padding: 18px 12px; border: 2px solid #e5e7eb;
                   border-radius: 10px; background: #fff; cursor: pointer;
                   transition: border-color .15s, background .15s; font-size: 0.82rem;
                   font-weight: 600; color: #374151; }
    .channel-btn:hover { border-color: #1a73e8; background: #f0f7ff; }
    .channel-btn.selected { border-color: #1a73e8; background: #e8f0fe; color: #1a73e8; }
    .channel-btn svg { width: 36px; height: 36px; }
    .coming-soon { font-size: 0.72rem; color: #9ca3af; font-weight: 400; }
    /* Result log */
    #log { background: #f4f4f5; padding: 16px; margin-top: 20px; border-radius: 8px;
           font-size: 0.9rem; color: #374151; line-height: 1.5; display: none; }
    .link-box { background: #e8f5e9; padding: 14px; border-radius: 8px; margin-top: 10px; }
    .link-box a { color: #1a73e8; font-weight: 600; word-break: break-all; }
    .hint { margin-top: 8px; font-size: 0.82rem; color: #6b7280; }
    /* Page transitions */
    .page { display: none; }
    .page.active { display: block; }
  </style>
</head>
<body>
  <div class="card">

    <!-- Page 1: Channel selection -->
    <div id="page-channel" class="page active">
      <h1>Where would you like to receive your bookkeeping updates?</h1>
      <p class="subtitle" style="margin-bottom:24px">Your AI bookkeeper will live in your messaging app — no new software to install.</p>
      <div class="channel-grid">
        <button class="channel-btn" onclick="selectChannel('telegram')">
          <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="24" cy="24" r="24" fill="#29B6F6"/>
            <path d="M10.5 23.5L35.5 13.5L28 35.5L21.5 28.5L10.5 23.5Z" fill="white" opacity="0.3"/>
            <path d="M10.5 23.5L20 27L21.5 33.5L26 28.5L32.5 33.5L35.5 13.5L10.5 23.5Z" fill="white"/>
            <path d="M20 27L21.5 33.5L25 29" stroke="#29B6F6" stroke-width="1.5" stroke-linejoin="round"/>
          </svg>
          Telegram
        </button>
        <button class="channel-btn" style="cursor:default;opacity:0.5" disabled>
          <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="48" height="48" rx="10" fill="#4A154B"/>
            <path d="M14 24C14 18.477 18.477 14 24 14C29.523 14 34 18.477 34 24C34 29.523 29.523 34 24 34C18.477 34 14 29.523 14 24Z" fill="#4A154B"/>
            <text x="24" y="29" text-anchor="middle" font-size="14" fill="white" font-family="sans-serif" font-weight="700">#</text>
          </svg>
          Slack <span class="coming-soon">coming soon</span>
        </button>
      </div>
    </div>

    <!-- Page 2: Plaid connection -->
    <div id="page-plaid" class="page">
      <h1>Connect your business bank and credit card accounts</h1>
      <p class="subtitle">SoloLedger needs read-only access to pull your transactions. We use Plaid — the same bank-linking infrastructure trusted by thousands of financial apps.</p>
      <div class="steps">
        <div class="step">
          <div class="step-num">1</div>
          <div class="step-text">Click below to connect your accounts securely via Plaid.</div>
        </div>
        <div class="step">
          <div class="step-num">2</div>
          <div class="step-text">You'll get a private link — tap it on your phone to meet your AI bookkeeper on Telegram.</div>
        </div>
        <div class="step">
          <div class="step-num">3</div>
          <div class="step-text">Your bookkeeper pulls the last 30 days and sends you a summary within minutes.</div>
        </div>
      </div>
      <button class="btn" id="connectBtn" onclick="startLink()">Connect your accounts</button>
      <div id="log"></div>
    </div>

  </div>

  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <script>
    let selectedChannel = null;
    const userId = Math.random().toString(36).slice(2) + Date.now().toString(36);

    function selectChannel(channel) {
      selectedChannel = channel;
      document.querySelectorAll('.channel-btn').forEach(b => b.classList.remove('selected'));
      event.currentTarget.classList.add('selected');
      setTimeout(() => {
        document.getElementById('page-channel').classList.remove('active');
        document.getElementById('page-plaid').classList.add('active');
      }, 180);
    }

    async function startLink() {
      const btn = document.getElementById('connectBtn');
      const log = document.getElementById('log');
      btn.disabled = true;
      btn.textContent = 'Opening Plaid...';
      log.style.display = 'block';
      log.textContent = 'Connecting to Plaid...';

      try {
        const r = await fetch('/plaid/link-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId }),
        });
        const { link_token, error } = await r.json();
        if (error) {
          log.textContent = 'Error: ' + error;
          btn.disabled = false;
          btn.textContent = 'Try again';
          return;
        }

        const handler = Plaid.create({
          token: link_token,
          onSuccess: async (public_token, metadata) => {
            log.textContent = 'Linking ' + metadata.institution.name + '...';
            const ex = await fetch('/plaid/exchange', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ public_token, userId, institution: metadata.institution.name }),
            });
            const result = await ex.json();
            if (result.error) {
              log.textContent = 'Error: ' + result.error;
              btn.disabled = false;
              btn.textContent = 'Try again';
            } else {
              log.innerHTML =
                '<strong>' + metadata.institution.name + ' connected!</strong>' +
                '<p style="margin-top:8px">Tap the link below on your phone to meet your bookkeeper:</p>' +
                '<div class="link-box"><a href="' + result.telegramLink + '">' + result.telegramLink + '</a></div>' +
                '<p class="hint">This link expires in 15 minutes and can only be used once.</p>';
            }
          },
          onExit: (err) => {
            log.textContent = err ? 'Error: ' + (err.error_message || JSON.stringify(err)) : 'Cancelled.';
            btn.disabled = false;
            btn.textContent = 'Connect your accounts';
          },
        });

        handler.open();
      } catch (e) {
        log.textContent = 'Error: ' + e.message;
        btn.disabled = false;
        btn.textContent = 'Try again';
      }
    }
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Plaid webhook verification (JWT / ES256)
// ---------------------------------------------------------------------------

// Cache: kid → { key: CryptoKey (any — Web Crypto API), expiredAt: ms timestamp }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const plaidKeyCache = new Map<string, { key: any; expiredAt: number }>();

async function verifyPlaidWebhook(
  rawBody: Buffer,
  jwtToken: string | undefined,
  plaid: PlaidApi,
): Promise<boolean> {
  if (!jwtToken) return false;
  try {
    const parts = jwtToken.split('.');
    if (parts.length !== 3) return false;
    const [headerB64, payloadB64, sigB64] = parts;

    const header = JSON.parse(
      Buffer.from(headerB64, 'base64url').toString('utf8'),
    );
    const kid: string = header.kid;
    if (!kid || header.alg !== 'ES256') return false;

    // Fetch / cache the verification key
    const now = Date.now();
    let cached = plaidKeyCache.get(kid);
    if (!cached || cached.expiredAt < now) {
      const res = await plaid.webhookVerificationKeyGet({ key_id: kid });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jwk = res.data.key as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cryptoKey = await (crypto.webcrypto as any).subtle.importKey(
        'jwk',
        jwk,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
      const expiredAt = jwk.expired_at
        ? new Date(jwk.expired_at as string).getTime()
        : now + 5 * 60 * 1000;
      cached = { key: cryptoKey, expiredAt };
      plaidKeyCache.set(kid, cached);
    }

    // Verify ES256 signature over "headerB64.payloadB64"
    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isValid = await (crypto.webcrypto as any).subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      cached.key,
      Buffer.from(sigB64, 'base64url'),
      signingInput,
    );
    if (!isValid) return false;

    // Verify body hash matches JWT claim
    const payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8'),
    );
    const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
    return payload.request_body_sha256 === bodyHash;
  } catch (err) {
    logger.warn({ err }, 'Plaid webhook JWT verification error');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Plaid webhook — silent background ingest
// ---------------------------------------------------------------------------

const KERNEL_EXEC_TIMEOUT_MS = 60_000;

async function runKernelSilent(
  script: string,
  args: string[],
  group: RegisteredGroup & { jid: string },
): Promise<string> {
  const s = secrets();
  const kernelDir =
    s.SOLOLEDGER_KERNEL_PATH || path.resolve(process.cwd(), '..', 'kernel');
  const ledger = path.join(GROUPS_DIR, group.folder, 'ledger.db');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LEDGER_DB: ledger,
    ...(s.SOLOLEDGER_MASTER_KEY
      ? { SOLOLEDGER_MASTER_KEY: s.SOLOLEDGER_MASTER_KEY }
      : {}),
  };
  const { stdout } = await execFileAsync(
    'python3',
    [path.join(kernelDir, script), ...args],
    { env, timeout: KERNEL_EXEC_TIMEOUT_MS },
  );
  return stdout.trim();
}

async function handlePlaidTransactionSync(itemId: string): Promise<void> {
  const profile = getCustomerProfileByPlaidItemId(itemId);
  if (!profile) {
    logger.warn(
      { itemId },
      'Plaid SYNC_UPDATES_AVAILABLE: no customer for item_id',
    );
    return;
  }
  const group = getRegisteredGroupByFolder(profile.group_folder);
  if (!group) {
    logger.warn(
      { itemId, folder: profile.group_folder },
      'Plaid SYNC_UPDATES_AVAILABLE: group not found',
    );
    return;
  }

  logger.info(
    { folder: profile.group_folder, itemId },
    'Plaid SYNC_UPDATES_AVAILABLE — running silent ingest',
  );

  try {
    await runKernelSilent('ingest.py', ['sync', profile.group_folder], group);

    const suggestRaw = await runKernelSilent(
      'categorize.py',
      ['suggest'],
      group,
    );
    const suggestions = JSON.parse(suggestRaw) as {
      auto: Array<{
        txn_id: string;
        suggested_account: string;
        credit_account: string;
      }>;
      review: unknown[];
      total: number;
      auto_count: number;
      review_count: number;
    };

    let autoPosted = 0;
    for (const item of suggestions.auto ?? []) {
      try {
        await runKernelSilent(
          'categorize.py',
          ['post', item.txn_id, item.suggested_account, item.credit_account],
          group,
        );
        autoPosted++;
      } catch (err) {
        logger.warn({ err, txnId: item.txn_id }, 'Silent auto-post failed');
      }
    }

    logger.info(
      {
        folder: profile.group_folder,
        total: suggestions.total,
        autoPosted,
        review: suggestions.review_count,
      },
      'Plaid silent ingest complete',
    );
  } catch (err) {
    logger.error(
      { err, folder: profile.group_folder },
      'Plaid silent ingest failed',
    );
  }
}

async function notifyAdminPlaidItemIssue(
  itemId: string,
  code: string,
  error: unknown,
  deps: OnboardingDeps,
): Promise<void> {
  const admin = getMainGroup();
  if (!admin) return;
  const profile = getCustomerProfileByPlaidItemId(itemId);
  const folder = profile?.group_folder ?? `unknown (item: ${itemId})`;
  const msg = `Plaid ITEM ${code} for *${folder}*${error ? `\n\`${JSON.stringify(error)}\`` : ''}`;
  await deps.sendMessage(admin.jid, msg);
}

// ---------------------------------------------------------------------------
// Express server
// ---------------------------------------------------------------------------

export function startOnboardingServer(deps: OnboardingDeps): void {
  const publicUrl = PUBLIC_URL || `http://localhost:${ONBOARDING_PORT}`;
  const app = express();

  // Stripe webhook — raw body MUST be registered BEFORE express.json() middleware.
  // Stripe's signature verification requires the raw unparsed request body.
  app.post(
    '/webhooks/stripe',
    express.raw({ type: 'application/json' }),
    async (req: Request, res: Response) => {
      const s = secrets();
      const mode = s.STRIPE_MODE || 'test';
      const webhookSecret =
        mode === 'live'
          ? s.STRIPE_LIVE_WEBHOOK_SECRET
          : s.STRIPE_TEST_WEBHOOK_SECRET;

      if (!webhookSecret) {
        logger.warn('Stripe webhook secret not configured — rejecting request');
        res.status(400).send('Webhook secret not configured');
        return;
      }

      const stripe = makeStripeClient();
      if (!stripe) {
        res.status(500).send('Stripe not configured');
        return;
      }

      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(
          req.body as Buffer,
          req.headers['stripe-signature'] as string,
          webhookSecret,
        );
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Stripe webhook signature verification failed',
        );
        res.status(400).send('Invalid signature');
        return;
      }

      // Acknowledge immediately — Stripe retries on non-2xx or timeout
      res.json({ received: true });

      handleStripeEvent(event, deps).catch((err) =>
        logger.error(
          { err, eventType: event.type },
          'Stripe webhook handler error',
        ),
      );
    },
  );

  // Plaid webhook — raw body MUST be registered BEFORE express.json() middleware.
  app.post(
    '/webhooks/plaid',
    express.raw({ type: 'application/json' }),
    async (req: Request, res: Response) => {
      const plaid = makePlaidClient();
      const jwtToken = req.headers['plaid-verification'] as string | undefined;
      const isValid = await verifyPlaidWebhook(
        req.body as Buffer,
        jwtToken,
        plaid,
      );
      if (!isValid) {
        logger.warn('Plaid webhook JWT verification failed');
        res.status(400).send('Invalid signature');
        return;
      }

      // Acknowledge immediately — Plaid retries on non-2xx or timeout
      res.json({ received: true });

      const body = JSON.parse((req.body as Buffer).toString('utf8')) as {
        webhook_type: string;
        webhook_code: string;
        item_id: string;
        error?: unknown;
      };

      logger.info(
        {
          type: body.webhook_type,
          code: body.webhook_code,
          itemId: body.item_id,
        },
        'Plaid webhook received',
      );

      if (
        body.webhook_type === 'TRANSACTIONS' &&
        body.webhook_code === 'SYNC_UPDATES_AVAILABLE'
      ) {
        handlePlaidTransactionSync(body.item_id).catch((err) =>
          logger.error({ err }, 'Plaid transaction sync handler error'),
        );
      } else if (
        body.webhook_type === 'ITEM' &&
        (body.webhook_code === 'ERROR' ||
          body.webhook_code === 'PENDING_EXPIRATION')
      ) {
        notifyAdminPlaidItemIssue(
          body.item_id,
          body.webhook_code,
          body.error,
          deps,
        ).catch((err) => logger.error({ err }, 'Plaid item alert error'));
      }
    },
  );

  app.use(express.json());

  // Landing page
  app.get('/', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(landingPage(publicUrl));
  });

  // Create Plaid link token
  app.post('/plaid/link-token', async (req: Request, res: Response) => {
    const { userId } = req.body as { userId?: string };
    if (!userId) {
      res.status(400).json({ error: 'userId required' });
      return;
    }
    try {
      const plaid = makePlaidClient();
      const response = await plaid.linkTokenCreate({
        user: { client_user_id: userId },
        client_name: 'SoloLedger',
        products: ['transactions'] as Parameters<
          PlaidApi['linkTokenCreate']
        >[0]['products'],
        country_codes: ['US'] as Parameters<
          PlaidApi['linkTokenCreate']
        >[0]['country_codes'],
        language: 'en',
      });
      res.json({ link_token: response.data.link_token });
    } catch (err) {
      logger.error({ err }, 'Plaid link-token creation failed');
      res.status(500).json({ error: String(err) });
    }
  });

  // Exchange public token → create session → return Telegram deep link
  app.post('/plaid/exchange', async (req: Request, res: Response) => {
    const { public_token, userId, institution } = req.body as {
      public_token?: string;
      userId?: string;
      institution?: string;
    };
    if (!public_token || !userId) {
      res.status(400).json({ error: 'public_token and userId required' });
      return;
    }

    // Capacity / waitlist check — enforce before provisioning
    const s = secrets();
    if (s.WAITLIST_MODE === 'true') {
      logger.info({ userId }, 'Onboarding blocked: WAITLIST_MODE=true');
      res.json({
        waitlisted: true,
        message:
          "We're currently at capacity. We've added you to the waitlist and will reach out as soon as a spot opens up.",
      });
      return;
    }
    const maxCustomers = s.MAX_ACTIVE_CUSTOMERS
      ? parseInt(s.MAX_ACTIVE_CUSTOMERS, 10)
      : null;
    if (maxCustomers !== null && !isNaN(maxCustomers)) {
      const activeCount = countActiveCustomers();
      if (activeCount >= maxCustomers) {
        logger.info(
          { userId, activeCount, maxCustomers },
          'Onboarding blocked: MAX_ACTIVE_CUSTOMERS reached',
        );
        res.json({
          waitlisted: true,
          message:
            "We're currently at capacity. We've added you to the waitlist and will reach out as soon as a spot opens up.",
        });
        return;
      }
    }

    try {
      const plaid = makePlaidClient();
      const exchange = await plaid.itemPublicTokenExchange({ public_token });
      const accessToken = exchange.data.access_token;
      const itemId = exchange.data.item_id;

      // Generate session (8-hex session ID → 36-char total token)
      const sessionId = crypto.randomBytes(4).toString('hex');
      const folder = `telegram_cus_${sessionId}`;
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
      const token = signToken(sessionId, expiresAt);

      createOnboardingSession({
        id: sessionId,
        folder,
        plaid_access_token: accessToken,
        plaid_item_id: itemId,
        expires_at: expiresAt.toISOString(),
      });

      // Register webhook URL on the Plaid Item so we receive SYNC_UPDATES_AVAILABLE
      const webhookUrl = `${PUBLIC_URL}/webhooks/plaid`;
      try {
        await plaid.itemWebhookUpdate({
          access_token: accessToken,
          webhook: webhookUrl,
        });
        logger.info(
          { sessionId, folder, itemId },
          'Plaid webhook URL registered',
        );
      } catch (err) {
        logger.warn(
          { err, webhookUrl },
          'Failed to register Plaid webhook URL — continuing',
        );
      }

      const s = secrets();
      const botUsername = s.BOT_USERNAME || '';
      const telegramLink = botUsername
        ? telegramDeepLink(botUsername, token)
        : `[Set BOT_USERNAME in .env — token: ${token}]`;

      logger.info(
        { sessionId, folder, institution, hasBot: !!botUsername },
        'Onboarding session created',
      );

      res.json({ telegramLink, folder, sessionId });
    } catch (err) {
      logger.error({ err }, 'Plaid exchange failed');
      res.status(500).json({ error: String(err) });
    }
  });

  // Stripe checkout result pages
  app.get('/checkout/success', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Subscribed</title>
      <style>body{font-family:sans-serif;text-align:center;padding:60px 20px}h1{color:#16a34a}</style></head>
      <body><h1>You're subscribed!</h1><p>Head back to Telegram — your bookkeeper is ready.</p></body></html>`,
    );
  });

  app.get('/checkout/cancel', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Cancelled</title>
      <style>body{font-family:sans-serif;text-align:center;padding:60px 20px}</style></head>
      <body><h1>No problem</h1><p>You can subscribe any time by asking your bookkeeper for a payment link.</p></body></html>`,
    );
  });

  app.listen(ONBOARDING_PORT, '0.0.0.0', () => {
    logger.info(
      { port: ONBOARDING_PORT, publicUrl },
      'Onboarding server started',
    );
    console.log(`\n  Onboarding: ${publicUrl}\n`);
  });
}
