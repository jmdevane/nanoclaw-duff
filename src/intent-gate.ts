/**
 * Pre-container intent gate for SoloLedger customer groups.
 *
 * Classifies an incoming message with a single lightweight Anthropic API call
 * (Haiku, ~$0.000016) before deciding whether to spawn a container.
 *
 *   A — financial or bookkeeping query  → spawn container
 *   B — slash command or status request → slash command parser (already handled upstream)
 *   C — unrelated to bookkeeping        → fixed deflection, no container
 *
 * If the API key is unavailable, defaults to 'A' (safe fallback — spawns container
 * as if no gate existed rather than silently dropping real queries).
 *
 * Only called for non-main groups. Caller handles isMain bypass.
 */
import { request } from 'https';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type IntentClass = 'A' | 'B' | 'C';

const MODEL = 'claude-haiku-4-5-20251001';
const SYSTEM_PROMPT =
  'You are a classifier. Reply with exactly one letter.\n' +
  'A = financial or bookkeeping query\n' +
  'B = slash command or status request (starts with /)\n' +
  'C = unrelated to bookkeeping';

export const DEFLECTION_MESSAGE =
  "I'm your bookkeeping assistant — I can help with transactions, reports, and categorizations. Type /help to see available commands.";

function callAnthropicApi(
  apiKey: string,
  userContent: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 5,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    };

    const req = request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text: string =
            parsed?.content?.[0]?.text?.trim().toUpperCase() ?? '';
          resolve(text);
        } catch (err) {
          reject(new Error(`Failed to parse Anthropic response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error('Intent gate request timed out'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Classify the intent of a message.
 * Returns 'A' | 'B' | 'C', defaulting to 'A' on any error.
 */
export async function classifyIntent(
  messageContent: string,
): Promise<IntentClass> {
  const env = readEnvFile(['ANTHROPIC_API_KEY']);
  const apiKey = env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    logger.debug(
      'Intent gate: no ANTHROPIC_API_KEY found, defaulting to A (safe fallback)',
    );
    return 'A';
  }

  try {
    const result = await callAnthropicApi(apiKey, messageContent);
    if (result === 'A' || result === 'B' || result === 'C') {
      logger.debug({ intent: result }, 'Intent gate classification');
      return result;
    }
    // Unexpected response — safe fallback
    logger.warn({ result }, 'Intent gate: unexpected response, defaulting to A');
    return 'A';
  } catch (err) {
    // Network error or timeout — safe fallback, don't drop real queries
    logger.warn({ err }, 'Intent gate error, defaulting to A');
    return 'A';
  }
}
