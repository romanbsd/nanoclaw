import { describe, expect, it } from 'vitest';
import type { InboundMessage } from './agent-message.js';

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
