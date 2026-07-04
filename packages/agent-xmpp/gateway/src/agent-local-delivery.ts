import type { AgentMessage } from '@agent-xmpp/protocol';

import type { GatewayConfig } from './config.js';
import { pushInboundToBridge, shouldAcceptStanza, type InboundDeliveryContext } from './delivery.js';
import type { Mailbox } from './mailbox.js';
import { isAgentJid } from './xep-plugins/message.js';

function bodyText(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object' && 'text' in body) {
    return String((body as { text?: unknown }).text ?? '');
  }
  return typeof body === 'object' && body !== null ? JSON.stringify(body) : String(body);
}

/**
 * Agent-to-agent delivery loopback.
 *
 * Agents send/receive through the gateway XMPP component, not as OpenFire c2s users.
 * Outbound stanzas to another agent@domain are routed by OpenFire to user sessions when
 * those users exist — which bypasses the component — so we mirror the inbound path here
 * after every outbound agent→agent send (see http-server outbound handlers).
 */
export async function deliverLocalAgentMessage(
  config: GatewayConfig,
  mailbox: Mailbox,
  params: {
    fromJid: string;
    toJid: string;
    messageId: string;
    body: unknown;
    threadId?: string;
    replyTo?: string;
  },
): Promise<boolean> {
  const fromBare = params.fromJid.split('/')[0];
  const toBare = params.toJid.split('/')[0];
  if (!fromBare || !toBare || fromBare === toBare) return false;
  if (!isAgentJid(toBare, config.agentDomain)) return false;

  const text = bodyText(params.body);
  const agentNick = toBare.split('@')[0] ?? '';
  if (!shouldAcceptStanza('chat', fromBare, text, agentNick)) return false;

  const agentMsg: AgentMessage = {
    id: params.messageId,
    from: fromBare,
    to: toBare,
    threadId: params.threadId,
    kind: 'text',
    contentType: 'text/plain',
    body: params.body,
    replyTo: params.replyTo,
  };

  const { id: deliveryId, isDuplicate, redelivered } = mailbox.enqueue(
    agentMsg.id,
    toBare,
    JSON.stringify(agentMsg),
  );
  if (isDuplicate && !redelivered) return true;
  // Redelivery: mark so bridge envelope gets redelivered=true (MAM-style retry semantics).
  if (isDuplicate && redelivered) mailbox.markRedelivered(agentMsg.id);

  const ctx: InboundDeliveryContext = {
    agentMsg,
    agentJid: toBare,
    deliveryId,
    stanzaType: 'chat',
    from: fromBare,
    redelivered: isDuplicate && redelivered,
  };

  await pushInboundToBridge(config, mailbox, ctx);
  return true;
}
