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

export interface InboundChatTargets {
  /** Reply/typing destination: MUC room JID or bare sender JID. */
  to: string;
  threadId: string | null;
  groupchat: boolean;
  /** Same as `to` — host router session key. */
  platformId: string;
  /** Same as `groupchat`. */
  isGroup: boolean;
}

/** Resolve where replies and typing notifications for an inbound stanza should go. */
export function resolveInboundChatTargets(
  from: string,
  stanzaType: string,
  agentMsg: Pick<AgentMessage, 'from' | 'threadId'>,
): InboundChatTargets {
  const room = mucRoomFromStanza(from);
  const isGroup = stanzaType === 'groupchat' || !!room;
  const to = isGroup && room ? room : agentMsg.from.split('/')[0];
  const threadId = agentMsg.threadId || (isGroup ? room || null : null);
  return { to, threadId, groupchat: isGroup, platformId: to, isGroup };
}

export function buildBridgePayload(
  config: GatewayConfig,
  ctx: InboundDeliveryContext,
): BridgeInboundPayload {
  const { agentMsg, agentJid, deliveryId, stanzaType, from, redelivered } = ctx;
  const { platformId, threadId, isGroup } = resolveInboundChatTargets(from, stanzaType, agentMsg);
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
