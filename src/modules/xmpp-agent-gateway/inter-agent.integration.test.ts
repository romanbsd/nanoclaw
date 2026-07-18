import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentApiManifest, GatewayMailboxRequest } from '@agent-xmpp/protocol';

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder, openInboundDb } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { createXmppAgentIdentity } from './identity.js';
import { createOrchestratorAgent } from './orchestrator-store.js';
import { XmppAgentGatewayService } from './service.js';
import { XmppAgentGatewayStore } from './store.js';

const TEST_DIR = '/tmp/nanoclaw-test-xmpp-inter-agent';
const wakeContainer = vi.hoisted(() => vi.fn().mockResolvedValue(true));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-xmpp-inter-agent' };
});

vi.mock('../../container-runner.js', () => ({
  wakeContainer,
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const manifest: AgentApiManifest = {
  specVersion: 'urn:solstice:agent-api:1',
  agent: { jid: 'mike@agents.test', name: 'mike', version: '1.0.0' },
  capabilities: { structuredOutput: true },
  operations: [
    {
      name: 'echo',
      description: 'Echo a marker.',
      inputSchema: {
        type: 'object',
        properties: { marker: { type: 'string' } },
        required: ['marker'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { response: { type: 'string' } },
        required: ['response'],
        additionalProperties: false,
      },
    },
  ],
};

function installAgent(id: string, jid: string): void {
  createAgentGroup({
    id,
    name: id,
    folder: id,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  createXmppAgentIdentity({ agent_group_id: id, jid, created_at: new Date().toISOString() });
  createOrchestratorAgent({
    id: `orch-${id}`,
    agent_group_id: id,
    tenant_id: 'acme',
    mock_scenario: null,
    spawn_env: '{}',
    created_at: new Date().toISOString(),
  });
}

function request(action: GatewayMailboxRequest['action'], requestId: string, payload: Record<string, unknown>) {
  return { action, requestId, payload } as GatewayMailboxRequest;
}

describe('local inter-agent mailbox integration', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    initTestDb();
    runMigrations(getDb());
    installAgent('ag-jane', 'jane@agents.test');
    installAgent('ag-mike', 'mike@agents.test');
    wakeContainer.mockClear();
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('carries call_tool from caller outbox semantics to target task inbox and completion back to caller inbox', async () => {
    const callerSession: Session = {
      id: 'sess-jane',
      agent_group_id: 'ag-jane',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'idle',
      last_active: null,
      created_at: new Date().toISOString(),
    };
    createSession(callerSession);
    initSessionFolder('ag-jane', callerSession.id);

    const store = new XmppAgentGatewayStore();
    store.registerManifest(manifest, 'acme');
    const service = new XmppAgentGatewayService(store);
    await service.handle(
      request('agents.call_tool', 'call-roundtrip', {
        endpointId: 'xmpp+mcp://mike@agents.test',
        tool: 'echo',
        arguments: { marker: 'MIKE_REMOTE_OK' },
      }),
      callerSession,
    );

    const taskSession = getDb().prepare("SELECT * FROM sessions WHERE agent_group_id = 'ag-mike'").get() as Session;
    expect(taskSession.thread_id).toMatch(/^system:tasks:task-/);
    const targetInbound = openInboundDb('ag-mike', taskSession.id);
    let taskId: string;
    try {
      const invocation = targetInbound.prepare("SELECT content FROM messages_in WHERE kind = 'agent-task'").get() as {
        content: string;
      };
      const content = JSON.parse(invocation.content) as {
        task: { taskId: string; callerJid: string; targetJid: string };
        event: string;
        payload: { arguments: { marker: string } };
      };
      taskId = content.task.taskId;
      expect(content).toMatchObject({
        task: { callerJid: 'jane@agents.test', targetJid: 'mike@agents.test' },
        event: 'task_invoke',
        payload: { arguments: { marker: 'MIKE_REMOTE_OK' } },
      });
    } finally {
      targetInbound.close();
    }

    await service.handle(
      request('task.complete', 'complete-ack', {
        taskId,
        result: { response: 'MIKE_REMOTE_OK' },
      }),
      taskSession,
    );

    const callerInbound = openInboundDb('ag-jane', callerSession.id);
    try {
      const responseRow = callerInbound
        .prepare("SELECT content FROM messages_in WHERE content LIKE '%call-roundtrip%'")
        .get() as { content: string };
      expect(JSON.parse(responseRow.content)).toEqual({
        action: 'xmpp_agent_gateway_response',
        requestId: 'call-roundtrip',
        response: {
          requestId: 'call-roundtrip',
          ok: true,
          result: {
            taskId,
            status: 'completed',
            structuredContent: { response: 'MIKE_REMOTE_OK' },
          },
        },
      });
    } finally {
      callerInbound.close();
    }
    expect(store.getTask(taskId)).toMatchObject({ state: 'completed', result: { response: 'MIKE_REMOTE_OK' } });
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });
});
