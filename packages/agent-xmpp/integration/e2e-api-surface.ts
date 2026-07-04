#!/usr/bin/env tsx
/**
 * End-to-end tests for the full agent-xmpp-gateway HTTP API surface.
 */
import { agentMessageText } from '@agent-xmpp/protocol';

import { GatewayClient } from './gateway-client.js';
import { e2eConfig, startE2eStack, stopE2eStack } from './e2e-stack.js';
import { bridgeState, lastInbound, waitForInbound } from './mock-bridge.js';
import { runPingTest } from './ping-client.js';
import { XmppSession } from './xmpp-session.js';

type TestFn = (ctx: TestContext) => Promise<void>;

interface TestContext {
  api: GatewayClient;
  config: ReturnType<typeof e2eConfig>;
  john: XmppSession;
  mucRoom?: string;
  uploadedFile?: { name: string; url: string; mediaType: string; sizeBytes: number; sha256: string };
}

interface TestCase {
  name: string;
  fn: TestFn;
  optional?: boolean;
}

const results: { name: string; status: 'pass' | 'fail' | 'skip'; error?: string }[] = [];

async function runTest(ctx: TestContext, tc: TestCase): Promise<void> {
  process.stdout.write(`[e2e-api] ${tc.name}... `);
  try {
    await tc.fn(ctx);
    results.push({ name: tc.name, status: 'pass' });
    console.log('ok');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (tc.optional) {
      results.push({ name: tc.name, status: 'skip', error: msg });
      console.log(`skip (${msg})`);
      return;
    }
    results.push({ name: tc.name, status: 'fail', error: msg });
    console.log('FAIL');
    throw err;
  }
}

const tests: TestCase[] = [
  {
    name: 'GET /health',
    fn: async ({ api }) => {
      const h = await api.health();
      if (!h.ok) throw new Error('health not ok');
    },
  },
  {
    name: 'POST /v1/outbound/deliver',
    fn: async ({ api, config, john }) => {
      const wait = john.waitForBody('deliver-e2e');
      const { status, json } = await api.deliver({
        to: config.pingerJid,
        content: 'deliver-e2e',
      });
      if (status !== 200 || !json.messageId) throw new Error(`deliver failed: ${status}`);
      await wait;
    },
  },
  {
    name: 'POST /v1/tools/xmpp.send_message',
    fn: async ({ api, config, john }) => {
      const wait = john.waitForBody('send-message-e2e');
      const { status, json } = await api.sendMessage({
        to: config.pingerJid,
        kind: 'text',
        contentType: 'text/plain',
        body: 'send-message-e2e',
      });
      if (status !== 200 || !json.messageId) throw new Error(`send_message failed: ${status}`);
      await wait;
    },
  },
  {
    name: 'POST /v1/tools/xmpp.set_presence',
    fn: async ({ api }) => {
      const { status, json } = await api.setPresence({ status: 'available', message: 'e2e online' });
      if (status !== 200 || !json.ok) throw new Error(`set_presence failed: ${status}`);
    },
  },
  {
    name: 'POST /v1/tools/xmpp.discover_agents',
    fn: async ({ api, config }) => {
      const { status, json } = await api.discoverAgents({ capabilities: ['chat'] });
      if (status !== 200) throw new Error(`discover_agents failed: ${status}`);
      if (!json.agents.some((a) => a.jid === config.agentJid)) {
        throw new Error(`default agent ${config.agentJid} not in discovery`);
      }
    },
  },
  {
    name: 'inbound webhook + POST /v1/tools/xmpp.reply',
    fn: async ({ api, config, john }) => {
      const wait = john.waitForBody('reply-e2e');
      await john.sendChat(config.gatewayJid, 'inbound-for-reply');
      const inbound = await waitForInbound(
        (p) => agentMessageText(p.envelope.message).includes('inbound-for-reply'),
      );
      const { status, json } = await api.reply({
        inReplyTo: inbound.envelope.message.id,
        body: 'reply-e2e',
      });
      if (status !== 200 || !json.messageId) throw new Error(`reply failed: ${status}`);
      await wait;
    },
  },
  {
    name: 'POST /v1/tools/xmpp.ack',
    fn: async ({ api, config, john }) => {
      await john.sendChat(config.gatewayJid, 'inbound-for-ack');
      const inbound = await waitForInbound((p) =>
        agentMessageText(p.envelope.message).includes('inbound-for-ack'),
      );
      const { status, json } = await api.ack({
        messageId: inbound.envelope.message.id,
        status: 'received',
        to: inbound.envelope.message.from.split('/')[0],
      });
      if (status !== 200 || !json.ok) throw new Error(`ack failed: ${status}`);
    },
  },
  {
    name: 'POST /v1/tools/xmpp.join_room',
    fn: async (ctx) => {
      const room = `e2e@conference.${ctx.config.xmppDomain}`;
      const { status, json } = await ctx.api.joinRoom({ roomJid: room, nickname: 'assistant' });
      if (status !== 200 || !json.ok) throw new Error(`join_room failed: ${status}`);
      ctx.mucRoom = room;
    },
  },
  {
    name: 'POST /v1/tools/xmpp.send_room_message',
    fn: async (ctx) => {
      const room = ctx.mucRoom || `e2e@conference.${ctx.config.xmppDomain}`;
      const { status, json } = await ctx.api.sendRoomMessage({
        roomJid: room,
        body: 'room-message-e2e',
        contentType: 'text/plain',
      });
      if (status !== 200 || !json.messageId) throw new Error(`send_room_message failed: ${status}`);
    },
  },
  {
    name: 'POST /v1/tools/xmpp.leave_room',
    fn: async (ctx) => {
      const room = ctx.mucRoom || `e2e@conference.${ctx.config.xmppDomain}`;
      const { status, json } = await ctx.api.leaveRoom({ roomJid: room, reason: 'e2e done' });
      if (status !== 200 || !json.ok) throw new Error(`leave_room failed: ${status}`);
    },
  },
  {
    name: 'POST /v1/tools/xmpp.publish_event',
    optional: true,
    fn: async ({ api }) => {
      const { status, json } = await api.publishEvent({
        node: 'e2e-events',
        eventType: 'test.event',
        body: { hello: 'world' },
      });
      if (status !== 200 || !json.ok) throw new Error(`publish_event failed: ${status}`);
    },
  },
  {
    name: 'POST /v1/tools/xmpp.get_archive',
    optional: true,
    fn: async ({ api, config }) => {
      const { status, json } = await api.getArchive({
        with: config.pingerJid,
        limit: 10,
      });
      if (status !== 200) throw new Error(`get_archive failed: ${status}`);
      if (!Array.isArray(json.messages)) throw new Error('get_archive missing messages array');
    },
  },
  {
    name: 'POST /v1/tools/xmpp.upload_file',
    fn: async (ctx) => {
      const bytes = Buffer.from('e2e upload payload', 'utf8');
      const { status, json } = await ctx.api.uploadFile({
        bytesBase64: bytes.toString('base64'),
        name: 'e2e.txt',
        mediaType: 'text/plain',
        uploadService: `httpfileupload.${ctx.config.xmppDomain}`,
      });
      if (status !== 200 || !json.file?.url) {
        throw new Error(`upload_file failed (${status}): ${JSON.stringify(json)}`);
      }
      ctx.uploadedFile = json.file;
    },
  },
  {
    name: 'POST /v1/tools/xmpp.share_file',
    fn: async (ctx) => {
      const file = ctx.uploadedFile ?? {
        name: 'e2e-fake.txt',
        url: 'https://example.org/e2e-fake.txt',
        mediaType: 'text/plain',
        sizeBytes: 4,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      };
      const wait = ctx.john.waitForBody('share-file-e2e');
      const { status, json } = await ctx.api.shareFile({
        to: ctx.config.pingerJid,
        file,
        note: 'share-file-e2e',
      });
      if (status !== 200 || !json.messageId) throw new Error(`share_file failed: ${status}`);
      await wait;
    },
  },
  {
    name: 'POST /v1/agents/publish_descriptor',
    fn: async ({ api, config }) => {
      const { status } = await api.publishDescriptor({
        jid: config.agentJid,
        tools: [{ name: 'send_message', description: 'Send message', inputSchema: { type: 'object' } }],
        model: 'e2e-test',
        provider: 'claude',
        softwareVersion: '2.0.0',
        health: 'healthy',
        availability: 'idle',
        supportedProtocols: ['xmpp', 'mcp'],
        publishedAt: new Date().toISOString(),
      });
      if (status !== 200) throw new Error(`publish_descriptor failed: ${status}`);
      const { status: dStatus, json } = await api.discoverAgents({ capabilities: ['send_message'] });
      if (dStatus !== 200) throw new Error(`discover_agents failed: ${dStatus}`);
      if (!json.agents.some((a) => a.jid === config.agentJid)) {
        throw new Error('published agent not discoverable');
      }
    },
  },
  {
    name: 'ping/pong flow (component path)',
    fn: async () => {
      await runPingTest();
      const state = bridgeState();
      if (!state.pingSeen || !state.pongSent) {
        throw new Error(`ping flow invalid: ${JSON.stringify(state)}`);
      }
      if (!lastInbound()) throw new Error('no inbound recorded for ping');
    },
  },
];

async function main(): Promise<void> {
  const config = e2eConfig();
  process.env.XMPP_DOMAIN = config.xmppDomain;
  process.env.XMPP_SERVICE = config.xmppService;
  process.env.XMPP_PINGER_JID = config.pingerJid;
  process.env.XMPP_GATEWAY_JID = config.gatewayJid;

  let stack: Awaited<ReturnType<typeof startE2eStack>> | null = null;
  let john: XmppSession | null = null;

  try {
    stack = await startE2eStack();
    const api = new GatewayClient(stack.config.gatewayUrl);
    john = new XmppSession({
      service: stack.config.xmppService,
      domain: stack.config.xmppDomain,
      username: stack.config.pingerJid.split('@')[0],
      password: process.env.XMPP_PINGER_PASS || 'secret',
    });
    await john.start();

    const ctx: TestContext = {
      api,
      config: stack.config,
      john,
    };
    for (const tc of tests) {
      await runTest(ctx, tc);
    }

    const failed = results.filter((r) => r.status === 'fail');
    const skipped = results.filter((r) => r.status === 'skip');
    console.log(`[e2e-api] done: ${results.length - failed.length - skipped.length} passed, ${skipped.length} skipped, ${failed.length} failed`);
    if (failed.length) {
      for (const f of failed) console.error(`  FAIL ${f.name}: ${f.error}`);
      process.exit(1);
    }
  } finally {
    await john?.stop().catch(() => undefined);
    if (stack) await stopE2eStack(stack);
  }
}

main().catch((err) => {
  console.error('[e2e-api] fatal:', err);
  process.exit(1);
});
