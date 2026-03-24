/**
 * Slack channel.
 *
 * Inbound: Slack Events API posts to /webhooks/slack (onboarding.ts).
 *          The webhook calls deliverSlackEvent() to push events into
 *          NanoClaw's message pipeline.
 *
 * Outbound: chat.postMessage via Slack Web API (native fetch, no SDK dep).
 *
 * JID format: slack_{channelId}
 *   DM channel IDs start with 'D' (e.g. slack_D1234567890).
 *
 * Group registration: groups must be registered before messages are processed.
 * On first DM from an unregistered channel, NanoClaw logs the channel ID so
 * the operator can register it from the admin group.
 */

import fs from 'fs';
import path from 'path';

import { registerChannel, ChannelOpts } from './registry.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata } from '../types.js';

// ---------------------------------------------------------------------------
// Module-level state — set by connect(), used by deliverSlackEvent()
// ---------------------------------------------------------------------------

let _onMessage: OnInboundMessage | null = null;
let _onChatMetadata: OnChatMetadata | null = null;
let _botToken: string | null = null;
let _connected = false;

// Display name cache — user ID → display name (resolved via users.info)
const _userNameCache = new Map<string, string>();

async function resolveUserName(userId: string): Promise<string> {
  const cached = _userNameCache.get(userId);
  if (cached) return cached;
  try {
    const info = await slackApi('users.info', { user: userId });
    const user = info.user as Record<string, unknown>;
    const profile = user.profile as Record<string, unknown>;
    const name =
      (profile.display_name as string) || (user.real_name as string) || userId;
    _userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

// Activation handler — injected from index.ts after onboarding server starts
let _activationHandler:
  | ((chatJid: string, token: string) => Promise<void>)
  | null = null;

export function setSlackActivationHandler(
  handler: (chatJid: string, token: string) => Promise<void>,
): void {
  _activationHandler = handler;
}

// ---------------------------------------------------------------------------
// Slack Web API helper
// ---------------------------------------------------------------------------

async function slackApi(
  method: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const token = _botToken;
  if (!token) throw new Error('Slack bot token not set');

  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as Record<string, unknown>;
  if (!data.ok) {
    throw new Error(`Slack API ${method} error: ${String(data.error)}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Markdown → Slack mrkdwn
// Claude outputs standard markdown; Slack needs mrkdwn.
// Bold (*text*) and italic (_text_) are the same. Links differ.
// ---------------------------------------------------------------------------

function toMrkdwn(text: string): string {
  // [label](url) → <url|label>
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');
}

// ---------------------------------------------------------------------------
// Inbound event delivery — called from /webhooks/slack in onboarding.ts
// ---------------------------------------------------------------------------

export async function deliverSlackEvent(
  body: Record<string, unknown>,
): Promise<void> {
  if (!_onMessage || !_onChatMetadata) {
    logger.warn(
      'Slack event received but channel not yet connected — is SLACK_BOT_TOKEN set?',
    );
    return;
  }

  const event = body.event as Record<string, unknown> | undefined;
  if (!event) return;

  // Only route direct messages for now
  if (event.type !== 'message') return;

  // Skip bot messages (including our own replies) and message edits/deletes
  if (event.bot_id || event.subtype) return;

  const channelId = event.channel as string;
  const userId = event.user as string;
  const text = (event.text as string) ?? '';
  const ts = event.ts as string; // Slack format: "1234567890.123456"

  if (!channelId || !userId || !ts) return;

  // Only handle DMs (channel ID starts with D)
  if (!channelId.startsWith('D')) {
    logger.debug({ channelId }, 'Slack: ignoring non-DM channel message');
    return;
  }

  const jid = `slack_${channelId}`;
  const timestamp = new Date(parseFloat(ts) * 1000).toISOString();

  // Register chat metadata so the channel appears in getAvailableGroups()
  // and can be registered from the admin group.
  const chatName = await resolveUserName(userId);
  _onChatMetadata(jid, timestamp, `Slack: ${chatName}`, 'slack', false);

  // Activation message — intercept before normal message routing.
  // Slack may wrap pasted code in backticks (`activate ...`) — strip them.
  const trimmed = text
    .trim()
    .replace(/^`+|`+$/g, '')
    .trim();
  const activationMatch = trimmed.match(/^activate\s+(\S+)/i);
  if (activationMatch) {
    logger.info({ jid }, 'Slack activation message received');
    if (_activationHandler) {
      _activationHandler(jid, activationMatch[1]).catch((err) =>
        logger.error({ jid, err }, 'Slack activation handler error'),
      );
    } else {
      logger.warn(
        { jid },
        'Slack activation message received but no handler set',
      );
    }
    return;
  }

  logger.info(
    { jid, userId, textPreview: text.slice(0, 80) },
    'Slack DM received — if unregistered, register group with JID: ' + jid,
  );

  const displayName = await resolveUserName(userId);

  _onMessage(jid, {
    id: `slack_${ts.replace('.', '')}`,
    chat_jid: jid,
    sender: userId,
    sender_name: displayName,
    content: text,
    timestamp,
    is_from_me: false,
    is_bot_message: false,
  });
}

// ---------------------------------------------------------------------------
// Channel factory
// ---------------------------------------------------------------------------

registerChannel('slack', (opts: ChannelOpts): Channel | null => {
  const env = readEnvFile(['SLACK_BOT_TOKEN']);
  if (!env.SLACK_BOT_TOKEN) {
    logger.info('Slack channel: SLACK_BOT_TOKEN not set — channel inactive');
    return null;
  }

  _botToken = env.SLACK_BOT_TOKEN;

  return {
    name: 'slack',

    async connect(): Promise<void> {
      _onMessage = opts.onMessage;
      _onChatMetadata = opts.onChatMetadata;

      try {
        const me = await slackApi('auth.test', {});
        _connected = true;
        logger.info(
          { botUser: me.user, team: me.team },
          'Slack channel connected',
        );
      } catch (err) {
        logger.error({ err }, 'Slack auth.test failed — check SLACK_BOT_TOKEN');
        _connected = false;
      }
    },

    async sendMessage(jid: string, text: string): Promise<void> {
      const channelId = jid.replace(/^slack_/, '');
      const mrkdwn = toMrkdwn(text);
      const MAX_LEN = 3000;

      if (mrkdwn.length <= MAX_LEN) {
        await slackApi('chat.postMessage', {
          channel: channelId,
          text: mrkdwn,
          mrkdwn: true,
        });
      } else {
        // Chunk long messages at paragraph boundaries where possible
        for (let i = 0; i < mrkdwn.length; i += MAX_LEN) {
          await slackApi('chat.postMessage', {
            channel: channelId,
            text: mrkdwn.slice(i, i + MAX_LEN),
            mrkdwn: true,
          });
        }
      }
    },

    async sendFile(
      jid: string,
      filePath: string,
      caption?: string,
    ): Promise<void> {
      const channelId = jid.replace(/^slack_/, '');
      const fileName = path.basename(filePath);
      const fileData = fs.readFileSync(filePath);
      const token = _botToken!;

      // Step 1: Get upload URL (uses application/x-www-form-urlencoded, not JSON)
      const params = new URLSearchParams({
        filename: fileName,
        length: String(fileData.length),
      });
      const step1Res = await fetch(
        `https://slack.com/api/files.getUploadURLExternal?${params}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      const step1 = (await step1Res.json()) as Record<string, unknown>;
      if (!step1.ok) {
        throw new Error(
          `Slack files.getUploadURLExternal error: ${String(step1.error)}`,
        );
      }
      const uploadUrl = step1.upload_url as string;
      const fileId = step1.file_id as string;

      // Step 2: Upload the file bytes
      const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: fileData,
      });
      if (!uploadRes.ok) {
        throw new Error(
          `Slack file upload failed: ${uploadRes.status} ${uploadRes.statusText}`,
        );
      }

      // Step 3: Complete the upload and share to the channel
      await slackApi('files.completeUploadExternal', {
        files: [{ id: fileId, title: caption || fileName }],
        channel_id: channelId,
        initial_comment: caption ? toMrkdwn(caption) : undefined,
      });

      logger.info({ jid, fileName }, 'Slack file sent');
    },

    isConnected(): boolean {
      return _connected;
    },

    ownsJid(jid: string): boolean {
      return jid.startsWith('slack_');
    },

    async disconnect(): Promise<void> {
      _onMessage = null;
      _onChatMetadata = null;
      _connected = false;
      logger.info('Slack channel disconnected');
    },
  };
});
