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

import express, { Request, Response } from 'express';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import Stripe from 'stripe';

import {
  ASSISTANT_NAME,
  ONBOARDING_PORT,
  PUBLIC_URL,
  STRIPE_PAYMENT_LINK,
} from './config.js';
import {
  createOnboardingSession,
  createTask,
  getCustomerProfileByFolder,
  getOnboardingSession,
  markSessionUsed,
  updateCustomerSubscription,
} from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);
const PROVISION_TIMEOUT_MS = 30_000;

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
    'STRIPE_PRICE_ID',
    'SOLOLEDGER_KERNEL_PATH',
    'SOLOLEDGER_MASTER_KEY',
  ]);
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
// Prefers static STRIPE_PAYMENT_LINK (set once in Stripe dashboard, never expires).
// Falls back to dynamic Checkout session if only STRIPE_PRICE_ID is configured.
// ---------------------------------------------------------------------------

async function resolveCheckoutUrl(
  chatJid: string,
  folder: string,
): Promise<string | null> {
  // Always prefer a dynamic session for the onboarding checkout — it guarantees
  // client_reference_id and metadata are set on the session so the webhook can
  // reliably match back to this customer's folder.
  // Static STRIPE_PAYMENT_LINK is used only for re-subscribe gating messages
  // (see index.ts) where per-customer metadata isn't needed.
  return tryCreateStripeCheckout(chatJid, folder);
}

async function tryCreateStripeCheckout(
  chatJid: string,
  folder: string,
): Promise<string | null> {
  const s = secrets();
  const priceId = s.STRIPE_PRICE_ID;
  if (!priceId) return null;

  const stripe = makeStripeClient();
  if (!stripe) return null;

  const publicUrl = PUBLIC_URL || `http://localhost:${ONBOARDING_PORT}`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${publicUrl}/checkout/success`,
      cancel_url: `${publicUrl}/checkout/cancel`,
      client_reference_id: folder,
      metadata: { folder, chatJid },
    });
    return session.url;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Stripe checkout session creation failed',
    );
    return null;
  }
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
          : (session.customer as Stripe.Customer | null)?.id ?? null;
      const stripeSubscriptionId =
        typeof session.subscription === 'string'
          ? session.subscription
          : (session.subscription as Stripe.Subscription | null)?.id ?? null;
      const email = session.customer_details?.email ?? null;
      // company_name from Stripe custom_fields (configured on the Payment Link
      // in the Stripe dashboard as a custom field with key "company_name")
      const companyField = (session.custom_fields ?? []).find(
        (f) => f.key === 'company_name',
      );
      const companyName = companyField?.text?.value ?? null;

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

  // 30-day retro audit task — fires in 20 seconds
  const auditId = `audit-${parsed.sessionId}`;
  createTask({
    id: auditId,
    group_folder: session.folder,
    chat_jid: chatJid,
    prompt: `You are running the initial 30-day onboarding audit for a new customer. Run these steps:

1. Sync their transactions:
   python3 /workspace/extra/kernel/ingest.py sync ${session.folder}

2. Generate a financial summary:
   python3 /workspace/extra/kernel/report.py summary

3. List pending categorizations:
   python3 /workspace/extra/kernel/categorize.py pending

4. Send ONE welcoming message that includes: how many transactions were synced, which accounts are connected, how many transactions need categorization, and 2-3 plain-English observations about their spending patterns. End with: "Reply any time to start reviewing transactions, or ask me anything about your finances."`,
    schedule_type: 'once',
    schedule_value: new Date(Date.now() + 20_000).toISOString(),
    context_mode: 'isolated',
    next_run: new Date(Date.now() + 20_000).toISOString(),
    status: 'active',
    created_at: new Date().toISOString(),
  });

  // Stripe checkout — sent directly by the host process after 3 minutes.
  // Bypasses the agent entirely: model content filters block Stripe URLs
  // when delivered via task prompts, treating them as unsolicited commercial links.
  // Prefers STRIPE_PAYMENT_LINK (static, reusable, no API call) over a dynamic
  // Checkout session. Falls back to dynamic session if only STRIPE_PRICE_ID is set.
  const checkoutUrl = await resolveCheckoutUrl(chatJid, session.folder);
  if (checkoutUrl) {
    const checkoutJid = chatJid;
    const checkoutMsg = `Ready to make it official? [Start your SoloLedger subscription here](${checkoutUrl})`;
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
      'Checkout URL scheduled (direct send, 3 min)',
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

  logger.info(
    { chatJid, folder: session.folder, auditId, recipeId },
    'Onboarding complete — audit and recipe tasks scheduled',
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
        mode === 'live' ? s.STRIPE_LIVE_WEBHOOK_SECRET : s.STRIPE_TEST_WEBHOOK_SECRET;

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
