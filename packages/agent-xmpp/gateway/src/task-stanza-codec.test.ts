import { describe, expect, it } from 'vitest';

import { buildTaskEvent, buildTaskInvocation, parseTaskEvent, parseTaskInvocation } from './task-stanza-codec.js';

describe('agent task stanza codec', () => {
  it('round-trips the durable invocation contract', () => {
    const stanza = buildTaskInvocation({
      taskId: 'task-1', rootTaskId: 'task-1', callerJid: 'caller@agents.test', targetJid: 'target@agents.test',
      tenantId: 'acme', workspaceId: 'engineering', endpointId: 'xmpp+mcp://target@agents.test',
      operation: 'review', apiVersion: '1.0.0', inputSchemaDigest: 'sha-256:input',
      outputSchemaDigest: 'sha-256:output', arguments: { branch: 'main' }, state: 'accepted', attempt: 1,
      correlationId: 'mcp-1', createdAt: '2026-07-13T00:00:00.000Z', deadline: '2026-07-13T00:10:00.000Z',
    });
    expect(parseTaskInvocation(stanza)).toEqual({
      taskId: 'task-1', correlationId: 'mcp-1', operation: 'review', apiVersion: '1.0.0',
      inputSchemaDigest: 'sha-256:input', outputSchemaDigest: 'sha-256:output',
      callerJid: 'caller@agents.test', tenantId: 'acme', workspaceId: 'engineering',
      toJid: 'target@agents.test',
      arguments: { branch: 'main' }, deadline: '2026-07-13T00:10:00.000Z',
    });
  });

  it('does NOT request a delivery receipt (side-effecting; no blind resend)', () => {
    // Task invocations rely on their own lifecycle-event acks + idempotency, not XEP-0184,
    // so a lost receipt can never trigger a duplicate (re-executing) invocation.
    const stanza = buildTaskInvocation({
      taskId: 'task-1', rootTaskId: 'task-1', callerJid: 'caller@agents.test', targetJid: 'target@agents.test',
      tenantId: 'acme', endpointId: 'xmpp+mcp://target@agents.test',
      operation: 'review', apiVersion: '1.0.0', inputSchemaDigest: 'sha-256:input',
      arguments: { branch: 'main' }, state: 'accepted', attempt: 1,
      correlationId: 'mcp-1', createdAt: '2026-07-13T00:00:00.000Z',
    });
    expect(stanza.getChild('request', 'urn:xmpp:receipts')).toBeUndefined();
  });

  it('round-trips task lifecycle events', () => {
    const event = {
      taskId: 'task-1',
      type: 'completed' as const,
      from: 'target@agents.test',
      to: 'caller@agents.test',
      payload: { result: { summary: 'ok' } },
    };
    expect(parseTaskEvent(buildTaskEvent(event))).toEqual(event);
  });
});
