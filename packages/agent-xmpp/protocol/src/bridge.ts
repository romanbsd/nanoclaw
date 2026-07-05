import type { AgentMessage, BridgeInboundPayload, InboundMessage } from './agent-message.js';

/**
 * True when the gateway normalized a XEP-0432-inspired JSON payload (agent-to-agent),
 * as opposed to a plain human `<body>` stanza (kind=text, contentType=text/plain, string body).
 */
export function isXmppAgentEnvelope(msg: AgentMessage): boolean {
  if (msg.kind !== 'text') return true;
  if (msg.contentType !== 'text/plain') return true;
  return typeof msg.body !== 'string';
}

/** Extract the normative AgentMessage from a NanoClaw XMPP inbound content JSON blob. */
export function agentMessageFromNanoclawContent(raw: string): AgentMessage | null {
  try {
    const parsed = JSON.parse(raw) as { envelope?: InboundMessage };
    if (parsed.envelope?.type !== 'inbound.message') return null;
    return parsed.envelope.message;
    // eslint-disable-next-line no-catch-all/no-catch-all -- malformed inbound content returns null
  } catch {
    return null;
  }
}

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
