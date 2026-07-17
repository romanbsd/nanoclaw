import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { digestJson, validateJson, validateManifest } from './schema.js';
import { XmppAgentGatewayService } from './service.js';
import { XmppAgentGatewayStore } from './store.js';
import { createProtocolNamespaces } from '@agent-xmpp/protocol';

const manifest = {
  specVersion: 'urn:solstice:agent-api:1' as const,
  agent: { jid: 'reviewer@agents.test', name: 'reviewer', title: 'Reviewer', version: '1.0.0' },
  capabilities: { progress: true, structuredOutput: true },
  operations: [
    {
      name: 'review_branch',
      description: 'Review a branch.',
      inputSchema: {
        type: 'object',
        properties: { branch: { type: 'string', minLength: 1 } },
        required: ['branch'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
        additionalProperties: false,
      },
      tags: ['git', 'review'],
    },
  ],
};

describe('XMPP agent gateway store', () => {
  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
  });

  afterEach(() => closeDb());

  it('registers versioned manifests and returns complete endpoint descriptors', () => {
    const store = new XmppAgentGatewayStore();
    const registered = store.registerManifest(manifest, 'acme');
    expect(registered.manifestDigest).toBe(digestJson(manifest));
    expect(registered.operations[0]?.inputSchemaDigest).toMatch(/^sha-256:/);

    const [endpoint] = store.discover('acme', 'git review');
    expect(endpoint?.endpointId).toBe('xmpp+mcp://reviewer@agents.test');
    expect(endpoint?.tools[0]?.name).toBe('review_branch');
    expect(store.discover('other', 'git')).toEqual([]);
  });

  it('deduplicates task creation by caller and idempotency scope', () => {
    const store = new XmppAgentGatewayStore();
    const registered = store.registerManifest(manifest, 'acme');
    const operation = registered.operations[0]!;
    const base = {
      rootTaskId: 'task-1',
      callerJid: 'caller@agents.test',
      targetJid: manifest.agent.jid,
      tenantId: 'acme',
      endpointId: `xmpp+mcp://${manifest.agent.jid}`,
      operation: operation.name,
      apiVersion: manifest.agent.version,
      inputSchemaDigest: operation.inputSchemaDigest,
      outputSchemaDigest: operation.outputSchemaDigest,
      arguments: { branch: 'main' },
      state: 'accepted' as const,
      attempt: 1,
      idempotencyKey: 'same',
      correlationId: 'request-1',
      createdAt: new Date().toISOString(),
    };
    expect(store.createTask({ ...base, taskId: 'task-1' }).taskId).toBe('task-1');
    expect(store.createTask({ ...base, taskId: 'task-2', rootTaskId: 'task-2' }).taskId).toBe('task-1');
    store.addTaskWaiter('task-1', 'request-1', 'ag-1', 'session-1');
    store.addTaskWaiter('task-1', 'request-2', 'ag-1', 'session-1');
    expect(store.takeTaskWaiters('task-1').map((waiter) => waiter.requestId)).toEqual(['request-1', 'request-2']);
    expect(store.takeTaskWaiters('task-1')).toEqual([]);
    expect(store.transition('task-1', 'completed', { result: { summary: 'ok' } }).state).toBe('completed');
    expect(() => store.transition('task-1', 'failed')).toThrow(/terminal/);
  });

  it('persists lifecycle events and state transitions atomically', () => {
    const store = new XmppAgentGatewayStore();
    const operation = store.registerManifest(manifest, 'acme').operations[0]!;
    const now = new Date().toISOString();
    store.createTask({
      taskId: 'task-atomic',
      rootTaskId: 'task-atomic',
      callerJid: 'caller@agents.test',
      targetJid: manifest.agent.jid,
      tenantId: 'acme',
      endpointId: `xmpp+mcp://${manifest.agent.jid}`,
      operation: operation.name,
      apiVersion: manifest.agent.version,
      inputSchemaDigest: operation.inputSchemaDigest,
      outputSchemaDigest: operation.outputSchemaDigest,
      arguments: { branch: 'main' },
      state: 'running',
      attempt: 1,
      correlationId: 'request-atomic',
      createdAt: now,
      acceptedAt: now,
      startedAt: now,
    });

    const completed = store.applyEvent(
      { type: 'completed', taskId: 'task-atomic', result: { summary: 'ok' } },
      'completed',
      { result: { summary: 'ok' } },
    );
    expect(completed).toMatchObject({ state: 'completed', result: { summary: 'ok' } });
    expect(getDb().prepare('SELECT type FROM xmpp_agent_task_events WHERE task_id = ?').all('task-atomic')).toEqual([
      { type: 'completed' },
    ]);

    expect(() =>
      store.applyEvent(
        {
          type: 'failed',
          taskId: 'task-atomic',
          error: { code: 'late', message: 'too late', retryable: false },
        },
        'failed',
      ),
    ).toThrow(/terminal/);
    expect(getDb().prepare('SELECT type FROM xmpp_agent_task_events WHERE task_id = ?').all('task-atomic')).toEqual([
      { type: 'completed' },
    ]);
  });

  it('records remote terminal events through the shared lifecycle path', async () => {
    const store = new XmppAgentGatewayStore();
    const operation = store.registerManifest(manifest, 'acme').operations[0]!;
    const now = new Date().toISOString();
    store.createTask({
      taskId: 'task-remote',
      rootTaskId: 'task-remote',
      callerJid: 'caller@agents.test',
      targetJid: manifest.agent.jid,
      tenantId: 'acme',
      endpointId: `xmpp+mcp://${manifest.agent.jid}`,
      operation: operation.name,
      apiVersion: manifest.agent.version,
      inputSchemaDigest: operation.inputSchemaDigest,
      outputSchemaDigest: operation.outputSchemaDigest,
      arguments: { branch: 'main' },
      state: 'running',
      attempt: 1,
      correlationId: 'request-remote',
      createdAt: now,
      acceptedAt: now,
      startedAt: now,
    });

    await new XmppAgentGatewayService(store).acceptRemoteEvent({
      taskId: 'task-remote',
      type: 'completed',
      from: `${manifest.agent.jid}/worker`,
      to: 'caller@agents.test',
      payload: { result: { summary: 'remote ok' } },
    });

    expect(store.getTask('task-remote')).toMatchObject({ state: 'completed', result: { summary: 'remote ok' } });
    expect(getDb().prepare('SELECT type FROM xmpp_agent_task_events WHERE task_id = ?').all('task-remote')).toEqual([
      { type: 'completed' },
    ]);
  });

  it('validates manifests and discovery descriptors against an injected profile', () => {
    const namespaces = createProtocolNamespaces({ namespaceRoot: 'urn:example', mediaVendor: 'example' });
    const store = new XmppAgentGatewayStore(namespaces);
    const customManifest = { ...manifest, specVersion: namespaces.api };
    expect(store.registerManifest(customManifest, 'acme').manifest.specVersion).toBe('urn:example:agent-api:1');
    expect(store.discover('acme', 'reviewer')[0]?.xmpp).toMatchObject({
      endpointNode: namespaces.endpoint,
      toolsNode: namespaces.api,
      features: [namespaces.task],
    });
    expect(() => store.registerManifest(manifest, 'acme')).toThrow(/unsupported specVersion/);
  });
});

describe('agent API validation', () => {
  it('rejects unsafe manifests and validates common JSON Schema constraints', () => {
    expect(validateManifest(manifest).agent.jid).toBe(manifest.agent.jid);
    expect(() =>
      validateManifest({ ...manifest, operations: [...manifest.operations, manifest.operations[0]] }),
    ).toThrow(/duplicate/);
    expect(validateJson(manifest.operations[0]!.inputSchema, { branch: '' })).toContain('$.branch is too short');
    expect(validateJson(manifest.operations[0]!.inputSchema, { branch: 'main', surprise: true })).toContain(
      '$.surprise is not allowed',
    );
  });
});
