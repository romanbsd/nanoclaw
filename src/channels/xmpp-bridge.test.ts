import { describe, expect, it } from 'vitest';

import type { BridgeInboundPayload, InboundMessage } from '@agent-xmpp/protocol';
import { nanoclawInboundFromBridge } from '@agent-xmpp/protocol';

const envelope: InboundMessage = {
  type: 'inbound.message',
  message: {
    id: 'msg_01',
    from: 'roman@example.com',
    to: 'assistant@agents.test',
    kind: 'text',
    contentType: 'text/plain',
    body: 'hello via xmpp',
  },
  delivery: {
    receivedAt: '2026-07-03T20:10:00Z',
    gatewayId: 'gw-1',
    deliveryId: 'del_01',
  },
};

const payload: BridgeInboundPayload = {
  platformId: 'roman@example.com',
  threadId: null,
  agentJid: 'assistant@agents.test',
  envelope,
};

describe('xmpp bridge inbound mapping', () => {
  it('maps gateway payload to inbound with normative envelope', () => {
    const inbound = nanoclawInboundFromBridge(payload);
    expect(inbound.content.envelope.message.body).toBe('hello via xmpp');
    expect(inbound.kind).toBe('chat');
  });
});
