import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'TELEGRAM_BOT_POOL',
  'PUBLIC_URL',
  'ONBOARDING_SECRET',
  'PLAID_ENV',
  'STRIPE_MODE',
  'STRIPE_TEST_PAYMENT_LINK_MONTHLY',
  'STRIPE_TEST_PAYMENT_LINK_ANNUAL',
  'STRIPE_LIVE_PAYMENT_LINK_MONTHLY',
  'STRIPE_LIVE_PAYMENT_LINK_ANNUAL',
  'PRODUCT_NAME',
  'PRODUCT_URL',
  'TZ',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '600000', 10); // 10min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

export const ONBOARDING_PORT = parseInt(
  process.env.ONBOARDING_PORT || '4000',
  10,
);
export const PUBLIC_URL = process.env.PUBLIC_URL || envConfig.PUBLIC_URL || '';
export const ONBOARDING_SECRET =
  process.env.ONBOARDING_SECRET || envConfig.ONBOARDING_SECRET || '';
export const PLAID_ENV =
  process.env.PLAID_ENV || envConfig.PLAID_ENV || 'sandbox';
export const STRIPE_MODE =
  process.env.STRIPE_MODE || envConfig.STRIPE_MODE || 'test';

// Mode-aware payment links — resolved at startup based on STRIPE_MODE
const _isLive = STRIPE_MODE === 'live';
export const STRIPE_PAYMENT_LINK_MONTHLY = _isLive
  ? (process.env.STRIPE_LIVE_PAYMENT_LINK_MONTHLY || envConfig.STRIPE_LIVE_PAYMENT_LINK_MONTHLY || '')
  : (process.env.STRIPE_TEST_PAYMENT_LINK_MONTHLY || envConfig.STRIPE_TEST_PAYMENT_LINK_MONTHLY || '');
export const STRIPE_PAYMENT_LINK_ANNUAL = _isLive
  ? (process.env.STRIPE_LIVE_PAYMENT_LINK_ANNUAL || envConfig.STRIPE_LIVE_PAYMENT_LINK_ANNUAL || '')
  : (process.env.STRIPE_TEST_PAYMENT_LINK_ANNUAL || envConfig.STRIPE_TEST_PAYMENT_LINK_ANNUAL || '');
// Alias for backwards compat — used in re-subscribe gating messages
export const STRIPE_PAYMENT_LINK = STRIPE_PAYMENT_LINK_MONTHLY;
export const PRODUCT_NAME =
  process.env.PRODUCT_NAME || envConfig.PRODUCT_NAME || 'Judy';
export const PRODUCT_URL =
  process.env.PRODUCT_URL || envConfig.PRODUCT_URL || 'hirejudy.com';

// Timezone for scheduled tasks (cron expressions, etc.)
// Reads TZ from .env so the value doesn't require a service file change.
// Setting process.env.TZ here ensures Node's date functions also respect it.
const _tz = process.env.TZ || envConfig.TZ;
if (_tz) process.env.TZ = _tz;
export const TIMEZONE = _tz || Intl.DateTimeFormat().resolvedOptions().timeZone;

export const TELEGRAM_BOT_POOL = (
  process.env.TELEGRAM_BOT_POOL ||
  envConfig.TELEGRAM_BOT_POOL ||
  ''
)
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
