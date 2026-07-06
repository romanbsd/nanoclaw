import { agentMessageText, type AgentMessage } from '@agent-xmpp/protocol';

import { decideAgentLoopback, logAgentLoopback, type AgentLoopbackRegistry } from './agent-loopback.js';
import { bareJid } from './xep-plugins/jid.js';
import type { GatewayConfig } from './config.js';
import { pushInboundToBridge, shouldAcceptStanza, type InboundDeliveryContext } from './delivery.js';
import type { AgentIngress } from './ingress/types.js';
import type { Mailbox } from './mailbox.js';

/**
 * Agent-to-agent delivery loopback.
 *
 * Outbound agent→agent chat uses C2S when the sender has a registered inbox session.
 * OpenFire delivers to the peer's C2S session without hitting the component inbound path,
 * so we mirror the bridge enqueue here after every outbound agent→agent send.
 */
export async function deliverLocalAgentMessage(
  config: GatewayConfig,
  mailbox: Mailbox,
  c2sIngress: AgentIngress,
  agentRegistry: AgentLoopbackRegistry | undefined,
  params: {
    fromJid: string;
    toJid: string;
    messageId: string;
    body: unknown;
    threadId?: string;
    replyTo?: string;
  },
): Promise<boolean> {
  const fromBare = bareJid(params.fromJid);
  const toBare = bareJid(params.toJid);
  const loopback = decideAgentLoopback(params.fromJid, params.toJid, config.agentDomain, c2sIngress, agentRegistry);
  logAgentLoopback(loopback, params.fromJid, params.toJid);
  if (!loopback.loopback) return false;

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

  const agentNick = toBare.split('@')[0] ?? '';
  if (!shouldAcceptStanza('chat', fromBare, agentMessageText(agentMsg), agentNick)) return false;

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
