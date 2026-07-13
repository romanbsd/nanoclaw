/**
 * Inbound delivery gating and routing. 1:1 (XMPP `chat`) messages always pass;
 * groupchat (XEP-0045) messages are delivered only when the agent is mentioned —
 * via XEP-0513 explicit mentions or the plaintext `@nick` fallback in routing.ts.
 *
 * @see https://xmpp.org/extensions/xep-0045.html
 * @see https://xmpp.org/extensions/xep-0513.html
 */
import type { AgentMessage, BridgeFormResponsePayload, BridgeInboundPayload } from '@agent-xmpp/protocol';
import { agentMessageText } from '@agent-xmpp/protocol';

import type { GatewayConfig } from './config.js';
import type { GatewayRuntimeMailbox } from './runtime-mailbox.js';
import { buildInboundEnvelope } from './xep-plugins/message.js';
import { bareJid } from './xep-plugins/jid.js';
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
  /** Reply/typing destination and host router session key: MUC room JID or bare sender JID. */
  to: string;
  threadId: string | null;
  /** True for MUC/groupchat traffic. */
  groupchat: boolean;
}

/** Resolve where replies and typing notifications for an inbound stanza should go. */
export function resolveInboundChatTargets(
  from: string,
  stanzaType: string,
  agentMsg: Pick<AgentMessage, 'from' | 'threadId'>,
): InboundChatTargets {
  const room = mucRoomFromStanza(from);
  const groupchat = stanzaType === 'groupchat' || !!room;
  const to = groupchat && room ? room : bareJid(agentMsg.from);
  const threadId = agentMsg.threadId || (groupchat ? room || null : null);
  return { to, threadId, groupchat };
}

export function buildBridgePayload(
  config: GatewayConfig,
  ctx: InboundDeliveryContext,
): BridgeInboundPayload {
  const { agentMsg, agentJid, deliveryId, stanzaType, from, redelivered } = ctx;
  const { to: platformId, threadId, groupchat: isGroup } = resolveInboundChatTargets(from, stanzaType, agentMsg);
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
    // RFC 6121 section 8.5.2.1: reply to the originating resource. Keeping
    // routing on the bare JID avoids creating one NanoClaw session per client.
    replyTo: isGroup ? undefined : from,
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
  mailbox: GatewayRuntimeMailbox,
  ctx: InboundDeliveryContext,
): Promise<void> {
  await mailbox.deliverInbound(buildBridgePayload(config, ctx));
}

export interface FormResponseContext {
  agentJid: string;
  from: string;
  stanzaType: string;
  questionId: string;
  selectedIndex: number;
}

export function buildFormResponsePayload(
  _config: GatewayConfig,
  ctx: FormResponseContext,
): BridgeFormResponsePayload {
  const { to: platformId, threadId, groupchat: isGroup } = resolveInboundChatTargets(
    ctx.from,
    ctx.stanzaType,
    { from: ctx.from, threadId: undefined },
  );

  return {
    type: 'form_response',
    agentJid: ctx.agentJid,
    platformId,
    threadId,
    questionId: ctx.questionId,
    selectedIndex: ctx.selectedIndex,
    // In a MUC the occupant identity is the resource (room@muc/nick); keep the full JID so
    // the answer is attributed to the responder, not to the room.
    userId: isGroup ? ctx.from : platformId,
    timestamp: new Date().toISOString(),
  };
}

export async function pushFormResponseToBridge(
  config: GatewayConfig,
  mailbox: GatewayRuntimeMailbox,
  ctx: FormResponseContext,
): Promise<void> {
  await mailbox.deliverFormResponse(buildFormResponsePayload(config, ctx));
}
