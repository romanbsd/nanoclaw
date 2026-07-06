import type { Element } from '@xmpp/xml';

import { logOutboundRoute } from './agent-loopback.js';
import { bareJid } from './xep-plugins/jid.js';
import type { InboundChatTargets } from './delivery.js';
import type { AgentIngress } from './ingress/types.js';
import { buildComposingStanza, buildPausedStanza, isChatStateStanza } from './xep-plugins/chatstate.js';
import type { SendForAgentFn, SendStanzaFn } from './stanza-router.js';

/** Route stanzas for local agent users through their C2S session; else use the component. */
export async function sendStanzaForAgent(
  fromJid: string,
  stanza: Element,
  c2sIngress: AgentIngress,
  componentSend: SendStanzaFn,
): Promise<void> {
  const bare = bareJid(fromJid);
  const stanzaName = stanza.name ?? 'stanza';
  if (c2sIngress.hasSession?.(bare)) {
    if (!isChatStateStanza(stanza)) {
      logOutboundRoute(fromJid, 'c2s', stanzaName);
    }
    await c2sIngress.sendStanza!(bare, stanza);
    return;
  }
  if (!isChatStateStanza(stanza)) {
    logOutboundRoute(fromJid, 'component', stanzaName);
  }
  await componentSend(stanza);
}

export function createAgentSender(c2sIngress: AgentIngress, componentSend: SendStanzaFn): SendForAgentFn {
  return (agentJid, stanza) => sendStanzaForAgent(agentJid, stanza, c2sIngress, componentSend);
}

/** Agent presence/pubsub — must use C2S; no component fallback. */
export async function sendAgentStanzaRequired(
  fromJid: string,
  stanza: Element,
  c2sIngress: AgentIngress,
): Promise<void> {
  const bare = bareJid(fromJid);
  if (!c2sIngress.hasSession?.(bare)) {
    throw new Error(`No C2S session for ${bare} — register_inbox first`);
  }
  if (!isChatStateStanza(stanza)) {
    logOutboundRoute(fromJid, 'c2s', stanza.name ?? 'stanza');
  }
  await c2sIngress.sendStanza!(bare, stanza);
}

async function sendChatStateForAgent(
  sendOutbound: (stanza: Element) => Promise<void>,
  agentJid: string,
  targets: Pick<InboundChatTargets, 'to' | 'threadId' | 'groupchat'>,
  state: 'composing' | 'paused',
): Promise<void> {
  const build = state === 'composing' ? buildComposingStanza : buildPausedStanza;
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
