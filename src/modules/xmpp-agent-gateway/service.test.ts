import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentApiManifest, GatewayMailboxRequest } from '@agent-xmpp/protocol';

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import type { Session } from '../../types.js';
import { createXmppAgentIdentity } from './identity.js';
import { createOrchestratorAgent } from './orchestrator-store.js';
import { XmppAgentGatewayService } from './service.js';
import { XmppAgentGatewayStore } from './store.js';
import type { AgentTaskTransport } from './task-transport.js';

const deliverAgentInbound = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../agent-inbound/index.js', () => ({ deliverAgentInbound }));

const manifest: AgentApiManifest = {
  specVersion: 'urn:solstice:agent-api:1',
  agent: { jid: 'mike@agents.test', name: 'mike', title: 'Mike', version: '1.0.0' },
  capabilities: { progress: true, structuredOutput: true },
  operations: [
    {
      name: 'echo',
      description: 'Return the supplied marker.',
      inputSchema: {
        type: 'object',
        properties: { marker: { type: 'string', minLength: 1 } },
        required: ['marker'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { response: { type: 'string', minLength: 1 } },
        required: ['response'],
        additionalProperties: false,
      },
    },
  ],
};

const callerSession = session('sess-jane', 'ag-jane');
const targetSession = session('sess-mike', 'ag-mike');

function session(id: string, agentGroupId: string): Session {
  return {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

function request(action: GatewayMailboxRequest['action'], requestId: string, payload: Record<string, unknown>) {
  return { action, requestId, payload } as GatewayMailboxRequest;
}

function responseCalls() {
  return deliverAgentInbound.mock.calls.map(([input]) => {
    const envelope = JSON.parse(input.message.content) as {
      requestId: string;
      response: { ok: boolean; result?: unknown; error?: { code: string; message: string } };
    };
    return { sessionId: input.session.id as string, ...envelope };
  });
}

function installAgent(agentGroupId: string, jid: string, tenantId = 'acme'): void {
  createAgentGroup({
    id: agentGroupId,
    name: jid.split('@')[0]!,
    folder: agentGroupId,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  createXmppAgentIdentity({ agent_group_id: agentGroupId, jid, created_at: new Date().toISOString() });
  createOrchestratorAgent({
    id: `orch-${agentGroupId}`,
    agent_group_id: agentGroupId,
    tenant_id: tenantId,
    mock_scenario: null,
    spawn_env: '{}',
    created_at: new Date().toISOString(),
  });
}

describe('XmppAgentGatewayService inter-agent lifecycle', () => {
  let store: XmppAgentGatewayStore;
  let transport: AgentTaskTransport;
  let service: XmppAgentGatewayService;

  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
    installAgent('ag-jane', 'jane@agents.test');
    installAgent('ag-mike', 'mike@agents.test');
    store = new XmppAgentGatewayStore();
    store.registerManifest(manifest, 'acme');
    transport = { deliver: vi.fn().mockResolvedValue(undefined), emit: vi.fn().mockResolvedValue(undefined) };
    service = new XmppAgentGatewayService(store, transport);
    deliverAgentInbound.mockClear();
  });

  afterEach(() => closeDb());

  it('discovers only same-tenant endpoints and responds through the caller mailbox', async () => {
    installAgent('ag-other', 'other@agents.test', 'other-tenant');
    store.registerManifest({ ...manifest, agent: { ...manifest.agent, jid: 'other@agents.test' } }, 'other-tenant');

    await service.handle(request('agents.discover_endpoints', 'discover-1', { query: 'echo' }), callerSession);

    expect(responseCalls()).toEqual([
      expect.objectContaining({
        sessionId: 'sess-jane',
        requestId: 'discover-1',
        response: expect.objectContaining({
          ok: true,
          result: expect.objectContaining({
            endpoints: [expect.objectContaining({ endpointId: 'xmpp+mcp://mike@agents.test' })],
          }),
        }),
      }),
    ]);
  });

  it('routes a blocking call to the target and correlates completion back to the caller', async () => {
    await service.handle(
      request('agents.call_tool', 'call-1', {
        endpointId: 'xmpp+mcp://mike@agents.test',
        tool: 'echo',
        arguments: { marker: 'MIKE_REMOTE_OK' },
      }),
      callerSession,
    );

    expect(deliverAgentInbound).not.toHaveBeenCalled();
    expect(transport.deliver).toHaveBeenCalledOnce();
    const [task, event, payload] = vi.mocked(transport.deliver).mock.calls[0]!;
    expect(event).toBe('task_invoke');
    expect(payload).toMatchObject({ arguments: { marker: 'MIKE_REMOTE_OK' } });
    expect(store.getTask(task.taskId)).toMatchObject({ state: 'running', callerSessionId: 'sess-jane' });

    await service.handle(
      request('task.complete', 'target-ack-1', {
        taskId: task.taskId,
        result: { response: 'MIKE_REMOTE_OK' },
        summary: 'done',
      }),
      targetSession,
    );

    expect(responseCalls()).toEqual([
      expect.objectContaining({
        sessionId: 'sess-jane',
        requestId: 'call-1',
        response: expect.objectContaining({
          ok: true,
          result: expect.objectContaining({
            taskId: task.taskId,
            status: 'completed',
            structuredContent: { response: 'MIKE_REMOTE_OK' },
          }),
        }),
      }),
      expect.objectContaining({
        sessionId: 'sess-mike',
        requestId: 'target-ack-1',
        response: expect.objectContaining({
          ok: true,
          result: { taskId: task.taskId, status: 'completed' },
        }),
      }),
    ]);
    expect(store.getTask(task.taskId)).toMatchObject({ state: 'completed', result: { response: 'MIKE_REMOTE_OK' } });
    expect(transport.emit).not.toHaveBeenCalled();
  });

  it('propagates target failure to the waiting caller without emitting a remote duplicate', async () => {
    await service.handle(
      request('agents.call_tool', 'call-fail', {
        endpointId: 'xmpp+mcp://mike@agents.test',
        tool: 'echo',
        arguments: { marker: 'fail' },
      }),
      callerSession,
    );
    const task = vi.mocked(transport.deliver).mock.calls[0]![0];

    await service.handle(
      request('task.fail', 'target-ack-fail', {
        taskId: task.taskId,
        code: 'remote-failed',
        message: 'Mike could not finish',
        retryable: false,
      }),
      targetSession,
    );

    expect(responseCalls()[0]).toMatchObject({
      sessionId: 'sess-jane',
      requestId: 'call-fail',
      response: { ok: false, error: { code: 'remote-failed', message: 'Mike could not finish' } },
    });
    expect(store.getTask(task.taskId)).toMatchObject({ state: 'failed' });
    expect(transport.emit).not.toHaveBeenCalled();
  });

  it('rejects invalid arguments before delivery and classifies the mailbox error', async () => {
    await service.handle(
      request('agents.call_tool', 'call-invalid', {
        endpointId: 'xmpp+mcp://mike@agents.test',
        tool: 'echo',
        arguments: { marker: '', extra: true },
      }),
      callerSession,
    );

    expect(transport.deliver).not.toHaveBeenCalled();
    expect(responseCalls()).toEqual([
      expect.objectContaining({
        requestId: 'call-invalid',
        response: expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'invalid-arguments' }) }),
      }),
    ]);
  });

  it('deduplicates start requests by idempotency key without redelivering work', async () => {
    const payload = {
      endpointId: 'xmpp+mcp://mike@agents.test',
      tool: 'echo',
      arguments: { marker: 'once' },
      idempotencyKey: 'stable-request',
    };
    await service.handle(request('agents.start_tool', 'start-1', payload), callerSession);
    await service.handle(request('agents.start_tool', 'start-2', payload), callerSession);

    expect(transport.deliver).toHaveBeenCalledOnce();
    const results = responseCalls().map((item) => item.response.result as { taskId: string });
    expect(results[0]!.taskId).toBe(results[1]!.taskId);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM xmpp_agent_tasks').get()).toEqual({ count: 1 });
  });

  it('marks overdue tasks timed out when the caller reads their state', async () => {
    await service.handle(
      request('agents.start_tool', 'start-timeout', {
        endpointId: 'xmpp+mcp://mike@agents.test',
        tool: 'echo',
        arguments: { marker: 'slow' },
        timeoutSeconds: 60,
      }),
      callerSession,
    );
    const taskId = (responseCalls()[0]!.response.result as { taskId: string }).taskId;
    getDb()
      .prepare('UPDATE xmpp_agent_tasks SET deadline = ? WHERE task_id = ?')
      .run('2000-01-01T00:00:00.000Z', taskId);
    deliverAgentInbound.mockClear();

    await service.handle(request('agents.get_task', 'get-timeout', { taskId }), callerSession);

    expect(responseCalls()[0]).toMatchObject({
      requestId: 'get-timeout',
      response: { ok: true, result: expect.objectContaining({ state: 'timed_out' }) },
    });
  });

  it('routes input-required and validated caller input through the same task', async () => {
    await service.handle(
      request('agents.call_tool', 'call-input', {
        endpointId: 'xmpp+mcp://mike@agents.test',
        tool: 'echo',
        arguments: { marker: 'needs-input' },
      }),
      callerSession,
    );
    const task = vi.mocked(transport.deliver).mock.calls[0]![0];

    await service.handle(
      request('task.request_input', 'target-input-ack', {
        taskId: task.taskId,
        requestId: 'input-1',
        question: 'Confirm marker?',
        inputSchema: {
          type: 'object',
          properties: { confirmed: { type: 'boolean' } },
          required: ['confirmed'],
          additionalProperties: false,
        },
      }),
      targetSession,
    );
    expect(responseCalls()[0]).toMatchObject({
      sessionId: 'sess-jane',
      requestId: 'call-input',
      response: {
        ok: true,
        result: expect.objectContaining({ status: 'input_required', requestId: 'input-1' }),
      },
    });

    await service.handle(
      request('agents.answer_input', 'answer-1', {
        taskId: task.taskId,
        requestId: 'input-1',
        input: { confirmed: true },
      }),
      callerSession,
    );
    expect(transport.deliver).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: task.taskId }), 'task_input', {
      requestId: 'input-1',
      input: { confirmed: true },
    });
    expect(store.getTask(task.taskId)).toMatchObject({ state: 'running' });
  });

  it('accepts a same-tenant remote task and rejects forged terminal events', async () => {
    const operation = store.getAgent('mike@agents.test')!.operations[0]!;
    await service.acceptRemoteInvocation({
      taskId: 'remote-task-ok',
      correlationId: 'remote-correlation',
      callerJid: 'external@agents.test',
      toJid: 'mike@agents.test',
      tenantId: 'acme',
      operation: 'echo',
      apiVersion: '1.0.0',
      inputSchemaDigest: operation.inputSchemaDigest,
      outputSchemaDigest: operation.outputSchemaDigest,
      arguments: { marker: 'remote' },
    });
    expect(store.getTask('remote-task-ok')).toMatchObject({ state: 'running' });

    await expect(
      service.acceptRemoteEvent({
        taskId: 'remote-task-ok',
        type: 'completed',
        from: 'attacker@agents.test/resource',
        to: 'external@agents.test',
        payload: { result: { response: 'forged' } },
      }),
    ).rejects.toThrow('task event sender mismatch');
    expect(store.getTask('remote-task-ok')).toMatchObject({ state: 'running' });

    await service.acceptRemoteEvent({
      taskId: 'remote-task-ok',
      type: 'completed',
      from: 'mike@agents.test/worker',
      to: 'external@agents.test',
      payload: { result: { response: 'remote-ok' } },
    });
    expect(store.getTask('remote-task-ok')).toMatchObject({ state: 'completed' });
    expect(transport.emit).not.toHaveBeenCalled();
  });

  it('rejects cross-tenant remote invocation before creating or delivering a task', async () => {
    await expect(
      service.acceptRemoteInvocation({
        taskId: 'remote-task',
        correlationId: 'remote-correlation',
        callerJid: 'external@agents.test',
        toJid: 'mike@agents.test',
        tenantId: 'wrong-tenant',
        operation: 'echo',
        apiVersion: '1.0.0',
        inputSchemaDigest: store.getAgent('mike@agents.test')!.operations[0]!.inputSchemaDigest,
        outputSchemaDigest: store.getAgent('mike@agents.test')!.operations[0]!.outputSchemaDigest,
        arguments: { marker: 'blocked' },
      }),
    ).rejects.toThrow('cross-tenant task invocation rejected');
    expect(store.getTask('remote-task')).toBeNull();
    expect(transport.deliver).not.toHaveBeenCalled();
  });
});
