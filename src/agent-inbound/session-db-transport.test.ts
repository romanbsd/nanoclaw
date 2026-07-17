import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';

import { initTestDb, closeDb, getDb, runMigrations, createAgentGroup } from '../db/index.js';
import { createSession } from '../db/sessions.js';
import type { Session } from '../types.js';
import { initSessionFolder, openInboundDb, writeSessionRouting } from '../session-manager.js';
import { deliverAgentInbound } from './index.js';

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

describe('deliverAgentInbound', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    initTestDb();
    runMigrations(getDb());
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('writes to inbound.db', async () => {
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

    await deliverAgentInbound({
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

  it('updates session routing from every addressed inbound message', async () => {
    createAgentGroup({
      id: 'ag-xmpp',
      name: 'Spark',
      folder: 'spark',
      agent_provider: null,
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

    await deliverAgentInbound({
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
    } finally {
      db.close();
    }
  });

  it('does not overwrite an authoritative existing route during wake seeding', async () => {
    createAgentGroup({
      id: 'ag-routing',
      name: 'Routing',
      folder: 'routing',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const { createMessagingGroup } = await import('../db/messaging-groups.js');
    createMessagingGroup({
      id: 'mg-routing',
      channel_type: 'xmpp',
      platform_id: 'configured@example.org',
      instance: 'xmpp',
      name: 'Configured',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: new Date().toISOString(),
    });
    createSession({
      id: 'sess-routing',
      agent_group_id: 'ag-routing',
      messaging_group_id: 'mg-routing',
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'idle',
      last_active: null,
      created_at: new Date().toISOString(),
    });
    initSessionFolder('ag-routing', 'sess-routing');

    const db = openInboundDb('ag-routing', 'sess-routing');
    db.prepare(
      `INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
       VALUES (1, 'xmpp', 'actual-peer@example.org', NULL)`,
    ).run();
    db.close();

    writeSessionRouting('ag-routing', 'sess-routing');

    const check = openInboundDb('ag-routing', 'sess-routing');
    try {
      expect(check.prepare('SELECT platform_id FROM session_routing WHERE id = 1').get()).toEqual({
        platform_id: 'actual-peer@example.org',
      });
    } finally {
      check.close();
    }
  });
});
