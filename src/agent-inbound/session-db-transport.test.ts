import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';

import { initTestDb, closeDb, getDb, runMigrations, createAgentGroup } from '../db/index.js';
import { createSession } from '../db/sessions.js';
import type { Session } from '../types.js';
import { initSessionFolder, openInboundDb } from '../session-manager.js';
import {
  getAgentInboundTransport,
  registerAgentInboundTransport,
  resetAgentInboundTransportForTests,
  type AgentInboundTransport,
} from './index.js';

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-agent-inbound' };
});

const TEST_DIR = '/tmp/nanoclaw-test-agent-inbound';

describe('SessionDbAgentInboundTransport', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    initTestDb();
    runMigrations(getDb());
    resetAgentInboundTransportForTests();
  });

  afterEach(() => {
    closeDb();
    resetAgentInboundTransportForTests();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('uses session_db by default and writes to inbound.db', async () => {
    const transport = getAgentInboundTransport();
    expect(transport.kind).toBe('session_db');

    createAgentGroup({
      id: 'ag-test',
      name: 'Test',
      folder: 'test',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });

    const session: Session = {
      id: 'sess-test',
      agent_group_id: 'ag-test',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'idle',
      last_active: null,
      created_at: new Date().toISOString(),
    };
    createSession(session);
    initSessionFolder('ag-test', 'sess-test');

    await transport.deliver({
      session,
      message: {
        id: 'msg-1',
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: 'john@example.org',
        channelType: 'xmpp',
        threadId: null,
        content: JSON.stringify({ text: 'hello' }),
        trigger: 1,
      },
      wake: false,
    });

    const db = openInboundDb('ag-test', 'sess-test');
    try {
      const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get('msg-1') as
        | { content: string }
        | undefined;
      expect(row?.content).toContain('hello');
    } finally {
      db.close();
    }
  });

  it('updates session_routing for XMPP agent inbox sessions', async () => {
    const transport = getAgentInboundTransport();

    createAgentGroup({
      id: 'ag-xmpp',
      name: 'Spark',
      folder: 'spark',
      agent_provider: null,
      xmpp_jid: 'spark@example.org',
      created_at: new Date().toISOString(),
    });

    const { createMessagingGroup } = await import('../db/messaging-groups.js');
    createMessagingGroup({
      id: 'mg-spark',
      channel_type: 'xmpp',
      platform_id: 'spark@example.org',
      instance: 'xmpp',
      name: 'Spark',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: new Date().toISOString(),
    });

    const session: Session = {
      id: 'sess-spark',
      agent_group_id: 'ag-xmpp',
      messaging_group_id: 'mg-spark',
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'idle',
      last_active: null,
      created_at: new Date().toISOString(),
    };
    createSession(session);
    initSessionFolder('ag-xmpp', 'sess-spark');

    await transport.deliver({
      session,
      message: {
        id: 'msg-dm',
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: 'john@example.org',
        channelType: 'xmpp',
        threadId: null,
        content: JSON.stringify({ text: 'ping' }),
        trigger: 1,
      },
      wake: false,
    });

    const db = openInboundDb('ag-xmpp', 'sess-spark');
    try {
      const routing = db.prepare('SELECT channel_type, platform_id FROM session_routing WHERE id = 1').get() as {
        channel_type: string;
        platform_id: string;
      };
      expect(routing.channel_type).toBe('xmpp');
      expect(routing.platform_id).toBe('john@example.org');

      const dest = db.prepare('SELECT name, platform_id FROM destinations').get() as {
        name: string;
        platform_id: string;
      };
      expect(dest.name).toBe('john');
      expect(dest.platform_id).toBe('john@example.org');
    } finally {
      db.close();
    }
  });

  it('can swap implementations via registerAgentInboundTransport', async () => {
    const deliver = vi.fn(async () => undefined);
    const mock: AgentInboundTransport = { kind: 'mock', deliver };
    registerAgentInboundTransport('mock', () => mock);
    process.env.AGENT_INBOUND_TRANSPORT = 'mock';

    const transport = getAgentInboundTransport();
    expect(transport.kind).toBe('mock');

    await transport.deliver({
      session: {
        id: 'sess-mock',
        agent_group_id: 'ag-mock',
        messaging_group_id: null,
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'idle',
        last_active: null,
        created_at: new Date().toISOString(),
      },
      message: {
        id: 'msg-mock',
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: 'a@b',
        channelType: 'xmpp',
        threadId: null,
        content: '{}',
      },
      wake: false,
    });

    expect(deliver).toHaveBeenCalledOnce();
    delete process.env.AGENT_INBOUND_TRANSPORT;
  });
});
