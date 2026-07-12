import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { digestJson, validateJson, validateManifest } from './schema.js';
import { XmppAgentGatewayStore } from './store.js';

const manifest = {
  specVersion: 'urn:businessos:agent-api:1' as const,
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
    expect(store.transition('task-1', 'completed', { result: { summary: 'ok' } }).state).toBe('completed');
    expect(() => store.transition('task-1', 'failed')).toThrow(/terminal/);
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
