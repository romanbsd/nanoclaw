import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentTaskRecord } from '@agent-xmpp/protocol';

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { openInboundDb } from '../../session-manager.js';
import { createXmppAgentIdentity } from './identity.js';
import { XmppAgentTaskTransport } from './task-transport.js';

const TEST_DIR = '/tmp/nanoclaw-test-xmpp-task-transport';
const wakeContainer = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const deliver = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const getDeliveryAdapter = vi.hoisted(() => vi.fn(() => ({ deliver })));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-xmpp-task-transport' };
});

vi.mock('../../container-runner.js', () => ({
  wakeContainer,
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../delivery.js', () => ({ getDeliveryAdapter }));

function task(overrides: Partial<AgentTaskRecord> = {}): AgentTaskRecord {
  const now = new Date().toISOString();
  return {
    taskId: 'task-1',
    rootTaskId: 'task-1',
    callerJid: 'jane@agents.test',
    targetJid: 'mike@agents.test',
    tenantId: 'acme',
    endpointId: 'xmpp+mcp://mike@agents.test',
    operation: 'echo',
    apiVersion: '1.0.0',
    inputSchemaDigest: 'sha-256:input',
    arguments: { marker: 'MIKE_REMOTE_OK' },
    state: 'running',
    attempt: 1,
    correlationId: 'call-1',
    createdAt: now,
    acceptedAt: now,
    startedAt: now,
    ...overrides,
  };
}

function installLocalAgent(id: string, jid: string): void {
  createAgentGroup({
    id,
    name: id,
    folder: id,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  createXmppAgentIdentity({ agent_group_id: id, jid, created_at: new Date().toISOString() });
}

describe('XmppAgentTaskTransport', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    initTestDb();
    runMigrations(getDb());
    wakeContainer.mockClear();
    deliver.mockClear();
    getDeliveryAdapter.mockClear();
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('delivers a local invocation into a dedicated task session and wakes the target', async () => {
    installLocalAgent('ag-mike', 'mike@agents.test');

    await new XmppAgentTaskTransport().deliver(task(), 'task_invoke', {
      operation: { name: 'echo' },
      arguments: { marker: 'MIKE_REMOTE_OK' },
    });

    const session = getDb().prepare('SELECT id, thread_id FROM sessions WHERE agent_group_id = ?').get('ag-mike') as {
      id: string;
      thread_id: string;
    };
    expect(session.thread_id).toBe('system:tasks:task-1');
    const inbound = openInboundDb('ag-mike', session.id);
    try {
      const row = inbound
        .prepare('SELECT kind, platform_id, channel_type, thread_id, content FROM messages_in')
        .get() as Record<string, string>;
      expect(row).toMatchObject({
        kind: 'agent-task',
        platform_id: 'jane@agents.test',
        channel_type: 'xmpp',
        thread_id: 'task-1',
      });
      expect(JSON.parse(row.content)).toMatchObject({
        task: { taskId: 'task-1', operation: 'echo' },
        event: 'task_invoke',
        payload: { arguments: { marker: 'MIKE_REMOTE_OK' } },
      });
    } finally {
      inbound.close();
    }
    expect(wakeContainer).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('falls back to XMPP wire delivery for a remote target and maps control events', async () => {
    const transport = new XmppAgentTaskTransport();
    await transport.deliver(task({ targetJid: 'remote@example.net' }), 'task_invoke', { arguments: { marker: 'x' } });
    await transport.deliver(task({ targetJid: 'remote@example.net' }), 'task_cancel', { reason: 'stop' });

    expect(deliver).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channelType: 'xmpp',
        platformId: 'remote@example.net',
        threadId: 'task-1',
        kind: 'agent-task',
        senderIdentity: 'jane@agents.test',
      }),
    );
    expect(JSON.parse(deliver.mock.calls[1]![0].content)).toEqual({
      agentTaskEvent: {
        taskId: 'task-1',
        type: 'cancel_requested',
        from: 'jane@agents.test',
        to: 'remote@example.net',
        payload: { reason: 'stop' },
      },
    });
  });

  it('emits terminal events to remote callers but not to local callers', async () => {
    const transport = new XmppAgentTaskTransport();
    await transport.emit(task({ callerJid: 'remote@example.net' }), 'completed', {
      result: { response: 'ok' },
    });
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        platformId: 'remote@example.net',
        kind: 'agent-task-event',
        senderIdentity: 'mike@agents.test',
      }),
    );

    deliver.mockClear();
    installLocalAgent('ag-jane', 'jane@agents.test');
    await transport.emit(task(), 'completed', { result: { response: 'ok' } });
    expect(deliver).not.toHaveBeenCalled();
  });
});
