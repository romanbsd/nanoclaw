import type { AgentMessage, BridgeInboundPayload, InboundMessage } from './agent-message.js';

/** Human-readable text from a normative AgentMessage. */
export function agentMessageText(msg: AgentMessage): string {
  if (typeof msg.body === 'string') return msg.body;
  if (msg.kind === 'text') return String(msg.body);
  return JSON.stringify(msg.body);
}

/** NanoClaw channel adapter inbound shape — preserves normative envelope. */
export interface NanoclawXmppInbound {
  id: string;
  kind: 'chat';
  content: { text: string; envelope: InboundMessage };
  timestamp: string;
  isMention?: boolean;
  isGroup?: boolean;
}

export function nanoclawInboundFromBridge(payload: BridgeInboundPayload): NanoclawXmppInbound {
  const { envelope, message } = payload;
  return {
    id: message.id,
    kind: 'chat',
    content: { text: agentMessageText(envelope.message), envelope },
    timestamp: envelope.delivery.receivedAt,
    isMention: message.isMention,
    isGroup: message.isGroup,
  };
}
