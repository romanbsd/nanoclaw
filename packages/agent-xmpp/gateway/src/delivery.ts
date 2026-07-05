import type { AgentMessage, BridgeInboundPayload } from '@agent-xmpp/protocol';
import { agentMessageText } from '@agent-xmpp/protocol';

import type { GatewayConfig } from './config.js';
import type { Mailbox } from './mailbox.js';
import { getRuntimeInboundPort } from './runtime-inbound/index.js';
import { buildInboundEnvelope } from './xep-plugins/message.js';
import { mucRoomFromStanza } from './xep-plugins/muc.js';
import { isMentionForAgent, shouldDeliverInbound } from './xep-plugins/routing.js';

export interface InboundDeliveryContext {
  agentMsg: AgentMessage;
  agentJid: string;
  deliveryId: string;
  stanzaType: string;
  from: string;
  redelivered?: boolean;
}

export function shouldAcceptStanza(stanzaType: string, from: string, bodyText: string, agentNick: string): boolean {
  const room = mucRoomFromStanza(from);
  const isGroup = stanzaType === 'groupchat' || !!room;
  const isMention = isMentionForAgent(stanzaType, bodyText, agentNick);
  return shouldDeliverInbound(stanzaType, isGroup, isMention);
}

export function buildBridgePayload(
  config: GatewayConfig,
  ctx: InboundDeliveryContext,
): BridgeInboundPayload {
  const { agentMsg, agentJid, deliveryId, stanzaType, from, redelivered } = ctx;
  const room = mucRoomFromStanza(from);
  const isGroup = stanzaType === 'groupchat' || !!room;
  const bodyText = agentMessageText(agentMsg);
  const agentNick = agentJid.split('@')[0];
  const isMention = isMentionForAgent(stanzaType, bodyText, agentNick);

  const envelope = buildInboundEnvelope(
    agentMsg,
    config.gatewayId,
    deliveryId,
    {
      stanzaId: agentMsg.id,
      stableId: agentMsg.id,
      stanzaType: stanzaType as 'chat' | 'groupchat',
    },
    redelivered,
  );

  // Host router keys sessions by platformId: MUC room JID for groupchat, bare sender JID for DM.
  const platformId = isGroup && room ? room : agentMsg.from.split('/')[0];
  const threadId = agentMsg.threadId || (isGroup ? room || null : null);

  return {
    platformId,
    threadId,
    agentJid,
    message: {
      id: agentMsg.id,
      kind: 'chat',
      content: { text: bodyText, agentMessage: agentMsg },
      timestamp: envelope.delivery.receivedAt,
      isMention,
      isGroup,
    },
    envelope,
  };
}

export async function pushInboundToBridge(
  config: GatewayConfig,
  mailbox: Mailbox,
  ctx: InboundDeliveryContext,
): Promise<void> {
  const port = getRuntimeInboundPort(config);
  await port.deliver(buildBridgePayload(config, ctx));
  mailbox.markDelivered(ctx.agentMsg.id);
}
