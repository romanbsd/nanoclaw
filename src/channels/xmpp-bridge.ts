/**
 * XMPP channel bridge — thin ChannelAdapter that forwards to agent-xmpp-gateway.
 *
 * Gateway pushes inbound stanzas via webhook; bridge calls host onInboundEvent()
 * with recipient agent JID in `instance`. Outbound deliver() posts to gateway HTTP API.
 */
import http from 'http';

import { getAskQuestionRender } from '../db/sessions.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerChannelAdapter } from './channel-registry.js';
import { resolveAskQuestionSelection } from './ask-question.js';
import {
  isBridgeFormResponsePayload,
  nanoclawInboundFromBridge,
  type BridgeWebhookPayload,
} from '@agent-xmpp/protocol';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';

const DEFAULT_GATEWAY = 'http://127.0.0.1:9220';
const DEFAULT_WEBHOOK_PORT = 9221;

const XMPP_ENV_KEYS = [
  'XMPP_GATEWAY_URL',
  'XMPP_BRIDGE_WEBHOOK_SECRET',
  'XMPP_BRIDGE_WEBHOOK_PORT',
  'XMPP_DEFAULT_AGENT_JID',
] as const;

function xmppEnv(): Record<string, string> {
  return readEnvFile([...XMPP_ENV_KEYS]);
}

function gatewayUrl(): string {
  return process.env.XMPP_GATEWAY_URL || xmppEnv().XMPP_GATEWAY_URL || DEFAULT_GATEWAY;
}

function webhookSecret(): string {
  return process.env.XMPP_BRIDGE_WEBHOOK_SECRET || xmppEnv().XMPP_BRIDGE_WEBHOOK_SECRET || 'dev-secret';
}

function webhookPort(): number {
  const raw =
    process.env.XMPP_BRIDGE_WEBHOOK_PORT || xmppEnv().XMPP_BRIDGE_WEBHOOK_PORT || String(DEFAULT_WEBHOOK_PORT);
  return Number(raw);
}

async function gatewayPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${gatewayUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`XMPP gateway ${path} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

async function sendTypingToGateway(platformId: string, threadId: string | null, fromJid: string): Promise<void> {
  await gatewayPost('/v1/outbound/typing', {
    from: fromJid,
    to: platformId,
    threadId,
  });
}

async function deliverToGateway(
  platformId: string,
  threadId: string | null,
  message: OutboundMessage,
  fromJid: string,
): Promise<string | undefined> {
  const content =
    typeof message.content === 'string'
      ? message.content
      : (message.content as { text?: string })?.text || message.content;

  const files = message.files?.map((f) => ({
    filename: f.filename,
    dataBase64: f.data.toString('base64'),
    mediaType: 'application/octet-stream',
  }));

  const json = await gatewayPost<{ messageId?: string }>('/v1/outbound/deliver', {
    from: fromJid,
    to: platformId,
    threadId,
    content,
    files,
  });
  return json.messageId;
}

function createAdapter(): ChannelAdapter | null {
  const secret = webhookSecret();
  const fallbackFromJid = process.env.XMPP_DEFAULT_AGENT_JID || xmppEnv().XMPP_DEFAULT_AGENT_JID || '';

  let hostOnInboundEvent: ChannelSetup['onInboundEvent'] | null = null;
  let hostOnAction: ChannelSetup['onAction'] | null = null;
  let server: http.Server | null = null;
  let connected = false;

  async function handleFormResponse(payload: Extract<BridgeWebhookPayload, { type: 'form_response' }>): Promise<void> {
    const render = getAskQuestionRender(payload.questionId);
    const selectedOption = resolveAskQuestionSelection(render, payload.selectedIndex);
    const title = render?.title ?? 'Question';
    const matched = render?.options[payload.selectedIndex];
    const selectedLabel = matched?.selectedLabel ?? selectedOption;

    try {
      await gatewayPost('/v1/outbound/deliver', {
        from: payload.agentJid,
        to: payload.platformId,
        threadId: payload.threadId,
        content: `${title}\n\n${selectedLabel}`,
      });
    } catch (err) {
      log.warn('Failed to send XMPP form selection confirmation', { questionId: payload.questionId, err });
    }

    hostOnAction!(payload.questionId, selectedOption, payload.userId);
  }

  return {
    name: 'XMPP',
    channelType: 'xmpp',
    supportsThreads: true,

    async setup(config) {
      hostOnInboundEvent = config.onInboundEvent;
      hostOnAction = config.onAction;

      server = http.createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/internal/xmpp/inbound') {
          res.writeHead(404);
          res.end();
          return;
        }

        const auth = req.headers.authorization || '';
        if (auth !== `Bearer ${secret}`) {
          res.writeHead(401);
          res.end('Unauthorized');
          return;
        }

        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          void (async () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as BridgeWebhookPayload;

              if (isBridgeFormResponsePayload(body)) {
                await handleFormResponse(body);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
                return;
              }

              const inbound = nanoclawInboundFromBridge(body);
              await hostOnInboundEvent!({
                channelType: 'xmpp',
                instance: body.agentJid,
                platformId: body.platformId,
                threadId: body.threadId,
                message: {
                  id: inbound.id,
                  kind: inbound.kind,
                  content: JSON.stringify(inbound.content),
                  timestamp: inbound.timestamp,
                  isMention: inbound.isMention ?? true,
                  isGroup: inbound.isGroup,
                },
              });
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } catch (err) {
              log.error('XMPP bridge inbound error', { err });
              res.writeHead(500);
              res.end('Internal error');
            }
          })();
        });
      });

      await new Promise<void>((resolve, reject) => {
        server!.listen(webhookPort(), '127.0.0.1', () => resolve());
        server!.on('error', reject);
      });

      connected = true;
      log.info('XMPP bridge listening', { port: webhookPort(), gateway: gatewayUrl() });
    },

    async teardown() {
      connected = false;
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
    },

    isConnected() {
      return connected;
    },

    async setTyping(platformId: string, threadId: string | null, fromJid?: string) {
      const senderJid = fromJid || fallbackFromJid;
      if (!senderJid) {
        log.debug('XMPP setTyping skipped — no fromJid');
        return;
      }
      try {
        await sendTypingToGateway(platformId, threadId, senderJid);
      } catch (err) {
        log.debug('XMPP typing indicator failed (best-effort)', { platformId, threadId, err });
      }
    },

    async deliver(platformId, threadId, message, options) {
      const fromJid = options?.fromJid || fallbackFromJid;
      if (!fromJid) {
        throw new Error('XMPP deliver requires fromJid (set XMPP_DEFAULT_AGENT_JID or provision agent xmpp_jid)');
      }
      return deliverToGateway(platformId, threadId, message, fromJid);
    },

    async resolveChannelName(platformId) {
      return platformId.split('@')[0] || platformId;
    },
  };
}

registerChannelAdapter('xmpp', {
  factory: createAdapter,
  containerConfig: {
    env: {
      XMPP_GATEWAY_URL: process.env.XMPP_GATEWAY_URL || 'http://host.docker.internal:9220',
    },
  },
});
