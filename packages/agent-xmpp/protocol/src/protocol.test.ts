import { describe, expect, it } from 'vitest';
import type { InboundMessage } from './agent-message.js';
import { createProtocolNamespaces, DEFAULT_PROTOCOL_NAMESPACES, DEFAULT_PROTOCOL_PROFILE } from './namespaces.js';

describe('protocol profile', () => {
  it('uses Solstice identifiers by default', () => {
    expect(DEFAULT_PROTOCOL_PROFILE).toEqual({ namespaceRoot: 'urn:solstice', mediaVendor: 'solstice' });
    expect(DEFAULT_PROTOCOL_NAMESPACES.api).toBe('urn:solstice:agent-api:1');
    expect(DEFAULT_PROTOCOL_NAMESPACES.taskMediaType).toBe('application/vnd.solstice.agent-task+json');
  });

  it('derives every vendor identifier from an explicit custom profile', () => {
    expect(createProtocolNamespaces({ namespaceRoot: 'urn:example:', mediaVendor: 'example' })).toEqual({
      directory: 'urn:example:agent-directory:1',
      api: 'urn:example:agent-api:1',
      operation: 'urn:example:agent-operation:1',
      endpoint: 'urn:example:mcp-endpoint:1',
      endpointInfo: 'urn:example:mcp-endpoint-info:1',
      toolInfo: 'urn:example:mcp-tool-info:1',
      task: 'urn:example:agent-task:1',
      taskMediaType: 'application/vnd.example.agent-task+json',
      fileMediaType: 'application/vnd.example.file-message+json',
    });
  });
});

describe('protocol examples', () => {
  it('matches human text message shape from API Surface §6.1', () => {
    const msg: InboundMessage = {
      type: 'inbound.message',
      message: {
        id: 'msg_01JZ9X2P3ABCD',
        from: 'roman@example.com',
        to: 'planner@agents.example',
        threadId: 'thread_01JZ9X',
        kind: 'text',
        contentType: 'text/plain',
        body: 'Ask the researcher agent to summarize XEP-0432.',
      },
      delivery: {
        receivedAt: '2026-07-03T20:10:00Z',
        gatewayId: 'gw-1',
        deliveryId: 'del_01JZ9X2P3',
      },
      xmpp: {
        stanzaType: 'chat',
        stableId: 'msg_01JZ9X2P3ABCD',
      },
    };
    expect(msg.message.kind).toBe('text');
    expect(msg.message.body).toContain('XEP-0432');
  });
});
