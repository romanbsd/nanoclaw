import { describe, expect, it } from 'vitest';

import type { BridgeInboundPayload, InboundMessage } from './agent-message.js';
import {
  agentMessageFromNanoclawContent,
  agentMessageText,
  isXmppAgentEnvelope,
  nanoclawInboundFromBridge,
} from './bridge.js';

const envelope: InboundMessage = {
  type: 'inbound.message',
  message: {
    id: 'msg_01',
    from: 'roman@example.com',
    to: 'planner@agents.example',
    threadId: 'thread_1',
    kind: 'task',
    contentType: 'application/vnd.businessos.agent-task+json',
    body: { task: 'Summarize XEP-0432' },
    replyTo: 'msg_parent',
  },
  delivery: {
    receivedAt: '2026-07-03T20:10:00Z',
    gatewayId: 'gw-1',
    deliveryId: 'del_01',
  },
  xmpp: { stanzaType: 'chat', stableId: 'msg_01' },
};

const payload: BridgeInboundPayload = {
  platformId: 'roman@example.com',
  threadId: 'thread_1',
  agentJid: 'planner@agents.example',
  message: {
    id: 'msg_01',
    kind: 'chat',
    content: { text: 'fallback' },
    timestamp: '2026-07-03T20:10:00Z',
    isMention: true,
    isGroup: false,
  },
  envelope,
};

describe('isXmppAgentEnvelope', () => {
  it('treats plain human text as non-agent envelope', () => {
    expect(
      isXmppAgentEnvelope({
        id: 'm1',
        from: 'human@example.com',
        to: 'planner@agents.example',
        kind: 'text',
        contentType: 'text/plain',
        body: 'Hello agent',
      }),
    ).toBe(false);
  });

  it('treats XEP-0432 task payloads as agent envelope', () => {
    expect(isXmppAgentEnvelope(envelope.message)).toBe(true);
  });

  it('treats structured agent text payloads as agent envelope', () => {
    expect(
      isXmppAgentEnvelope({
        id: 'm2',
        from: 'sender@agents.example',
        to: 'planner@agents.example',
        kind: 'text',
        contentType: 'text/plain',
        body: { text: 'ping' },
      }),
    ).toBe(true);
  });
});

describe('agentMessageFromNanoclawContent', () => {
  it('extracts the normative message from bridge content JSON', () => {
    const inbound = nanoclawInboundFromBridge(payload);
    const msg = agentMessageFromNanoclawContent(JSON.stringify(inbound.content));
    expect(msg?.kind).toBe('task');
    expect(msg?.from).toBe('roman@example.com');
  });
});

describe('agentMessageText', () => {
  it('returns string bodies as-is', () => {
    expect(agentMessageText({ ...envelope.message, kind: 'text', body: 'hello' })).toBe('hello');
  });

  it('stringifies structured task bodies', () => {
    expect(agentMessageText(envelope.message)).toContain('Summarize');
  });
});

describe('nanoclawInboundFromBridge', () => {
  it('preserves normative envelope for the agent runner', () => {
    const inbound = nanoclawInboundFromBridge(payload);
    expect(inbound.id).toBe('msg_01');
    expect(inbound.content.envelope).toEqual(envelope);
    expect(inbound.content.envelope.message.kind).toBe('task');
    expect(inbound.content.envelope.message.replyTo).toBe('msg_parent');
  });

  it('forwards mention and group flags', () => {
    const inbound = nanoclawInboundFromBridge({
      ...payload,
      message: { ...payload.message, isMention: false, isGroup: true },
    });
    expect(inbound.isMention).toBe(false);
    expect(inbound.isGroup).toBe(true);
  });
});
