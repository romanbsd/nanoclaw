/**
 * Emits XEP-0085 Chat State Notifications on the agent's behalf (composing while
 * the agent works, paused/inactive when it stops). States are directed to the same
 * 1:1 resource or MUC room the inbound message came from.
 *
 * @see https://xmpp.org/extensions/xep-0085.html
 */
import type { Element } from '@xmpp/xml';

import type { InboundChatTargets } from './delivery.js';
import { buildComposingStanza, buildInactiveStanza, buildPausedStanza } from './xep-plugins/chatstate.js';

async function sendChatStateForAgent(
  sendOutbound: (stanza: Element) => Promise<void>,
  agentJid: string,
  targets: Pick<InboundChatTargets, 'to' | 'threadId' | 'groupchat'>,
  state: 'composing' | 'paused' | 'inactive',
): Promise<void> {
  const build =
    state === 'composing' ? buildComposingStanza : state === 'paused' ? buildPausedStanza : buildInactiveStanza;
  await sendOutbound(
    build({
      from: agentJid,
      to: targets.to,
      threadId: targets.threadId,
      groupchat: targets.groupchat,
    }),
  );
}

export async function sendComposingForAgent(
  sendOutbound: (stanza: Element) => Promise<void>,
  agentJid: string,
  targets: Pick<InboundChatTargets, 'to' | 'threadId' | 'groupchat'>,
): Promise<void> {
  await sendChatStateForAgent(sendOutbound, agentJid, targets, 'composing');
}

export async function sendPausedForAgent(
  sendOutbound: (stanza: Element) => Promise<void>,
  agentJid: string,
  targets: Pick<InboundChatTargets, 'to' | 'threadId' | 'groupchat'>,
): Promise<void> {
  await sendChatStateForAgent(sendOutbound, agentJid, targets, 'paused');
}

export async function sendInactiveForAgent(
  sendOutbound: (stanza: Element) => Promise<void>,
  agentJid: string,
  targets: Pick<InboundChatTargets, 'to' | 'threadId' | 'groupchat'>,
): Promise<void> {
  await sendChatStateForAgent(sendOutbound, agentJid, targets, 'inactive');
}
