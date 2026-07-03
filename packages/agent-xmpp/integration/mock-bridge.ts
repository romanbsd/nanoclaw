/**
 * Minimal NanoClaw bridge mock for E2E: captures inbounds; optional ping→pong auto-reply.
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BridgeInboundPayload } from '@agent-xmpp/protocol';
import { agentMessageText } from '@agent-xmpp/protocol';

const SECRET = process.env.XMPP_BRIDGE_WEBHOOK_SECRET || 'dev-secret';

let pingSeen = false;
let pongSent = false;
const inbounds: BridgeInboundPayload[] = [];

export function resetMockBridge(): void {
  pingSeen = false;
  pongSent = false;
  inbounds.length = 0;
}

export function bridgeState(): { pingSeen: boolean; pongSent: boolean; inboundCount: number } {
  return { pingSeen, pongSent, inboundCount: inbounds.length };
}

export function lastInbound(): BridgeInboundPayload | undefined {
  return inbounds.at(-1);
}

export function waitForInbound(
  predicate: (p: BridgeInboundPayload) => boolean,
  timeoutMs = 30_000,
): Promise<BridgeInboundPayload> {
  const existing = inbounds.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const hit = inbounds.find(predicate);
      if (hit) {
        clearInterval(timer);
        resolve(hit);
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error('timeout waiting for inbound'));
      }
    }, 200);
  });
}

async function deliverPong(replyTo: string, threadId: string | null): Promise<void> {
  const gatewayUrl = process.env.XMPP_GATEWAY_URL || 'http://127.0.0.1:19220';
  const domain = process.env.XMPP_DOMAIN || 'example.org';
  const agentJid = process.env.XMPP_DEFAULT_AGENT_JID || `assistant@${domain}`;
  const pingerJid = process.env.XMPP_PINGER_JID || `john@${domain}`;
  const res = await fetch(`${gatewayUrl}/v1/outbound/deliver`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: agentJid,
      to: pingerJid,
      threadId,
      content: 'pong',
      inReplyTo: replyTo,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`gateway deliver failed: ${res.status} ${text}`);
  }
  pongSent = true;
  console.log('[mock-bridge] sent pong to', pingerJid);
}

async function handleInbound(payload: BridgeInboundPayload): Promise<void> {
  inbounds.push(payload);
  const text = agentMessageText(payload.envelope.message).trim();
  console.log('[mock-bridge] inbound:', text, 'from', payload.envelope.message.from);
  if (text !== 'ping') return;
  pingSeen = true;
  await deliverPong(payload.message.id, payload.threadId);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function startMockBridge(): Promise<http.Server> {
  const port = Number(process.env.XMPP_BRIDGE_WEBHOOK_PORT || '19221');
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...bridgeState() }));
      return;
    }
    if (req.url !== '/internal/xmpp/inbound' || req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${SECRET}`) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }
    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw) as BridgeInboundPayload;
      await handleInbound(payload);
      res.writeHead(200);
      res.end('ok');
    } catch (err) {
      console.error('[mock-bridge] error:', err);
      res.writeHead(500);
      res.end(String(err));
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', (err) => reject(err));
    server.listen(port, '0.0.0.0', () => {
      console.log(`[mock-bridge] listening on :${port}`);
      resolve(server);
    });
  });
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  void startMockBridge();
}
