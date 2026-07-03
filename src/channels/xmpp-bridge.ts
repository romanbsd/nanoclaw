/**
 * XMPP channel bridge — thin ChannelAdapter that forwards to agent-xmpp-gateway.
 *
 * Gateway pushes inbound stanzas via webhook; bridge calls host onInbound().
 * Outbound deliver() posts to gateway HTTP API.
 */
import http from 'http';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerChannelAdapter } from './channel-registry.js';
import { nanoclawInboundFromBridge, type BridgeInboundPayload } from '@agent-xmpp/protocol';
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

async function deliverToGateway(
  platformId: string,
  threadId: string | null,
  message: OutboundMessage,
  defaultAgentJid: string,
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

  const res = await fetch(`${gatewayUrl()}/v1/outbound/deliver`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: defaultAgentJid,
      to: platformId,
      threadId,
      content,
      files,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`XMPP gateway deliver failed: ${res.status} ${text}`);
  }

  const json = (await res.json()) as { messageId?: string };
  return json.messageId;
}

function createAdapter(): ChannelAdapter | null {
  const secret = webhookSecret();
  const defaultAgentJid = process.env.XMPP_DEFAULT_AGENT_JID || xmppEnv().XMPP_DEFAULT_AGENT_JID || '';

  if (!defaultAgentJid) {
    log.info('XMPP bridge disabled: XMPP_DEFAULT_AGENT_JID not set');
    return null;
  }

  let hostOnInbound: ChannelSetup['onInbound'] | null = null;
  let server: http.Server | null = null;
  let connected = false;

  return {
    name: 'XMPP',
    channelType: 'xmpp',
    supportsThreads: true,

    async setup(config) {
      hostOnInbound = config.onInbound;

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
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as BridgeInboundPayload;
              const inbound = nanoclawInboundFromBridge(body);
              await hostOnInbound!(body.platformId, body.threadId, inbound);
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

    async deliver(platformId, threadId, message) {
      return deliverToGateway(platformId, threadId, message, defaultAgentJid);
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
