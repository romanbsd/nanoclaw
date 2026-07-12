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
  if (msg.body && typeof msg.body === 'object' && 'text' in msg.body) {
    return String((msg.body as { text?: unknown }).text ?? '');
  }
  return JSON.stringify(msg.body);
}

/** NanoClaw channel adapter inbound shape — preserves normative envelope. */
export interface NanoclawXmppInbound {
  id: string;
  kind: 'chat' | 'task';
  content: { text?: string; prompt?: string; task?: unknown; envelope: InboundMessage };
  timestamp: string;
  isMention?: boolean;
  isGroup?: boolean;
}

export function nanoclawInboundFromBridge(payload: BridgeInboundPayload): NanoclawXmppInbound {
  const { envelope, message } = payload;
  const structuredTask = envelope.message.kind === 'task';
  const text = agentMessageText(envelope.message);
  return {
    id: message.id,
    kind: structuredTask ? 'task' : 'chat',
    content: structuredTask
      ? {
          prompt: `Execute the inbound XMPP task. Use the task lifecycle tools and preserve taskId ${envelope.message.id}.`,
          task: envelope.message.body,
          envelope,
        }
      : { text, envelope },
    timestamp: envelope.delivery.receivedAt,
    isMention: message.isMention,
    isGroup: message.isGroup,
  };
}
