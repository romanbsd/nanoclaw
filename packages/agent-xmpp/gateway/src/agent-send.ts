import type { Element } from '@xmpp/xml';

import type { InboundChatTargets } from './delivery.js';
import type { AgentIngress } from './ingress/types.js';
import { buildComposingStanza } from './xep-plugins/chatstate.js';
import type { SendForAgentFn, SendStanzaFn } from './stanza-router.js';

/** Route stanzas for local agent users through their C2S session; else use the component. */
export async function sendStanzaForAgent(
  fromJid: string,
  stanza: Element,
  c2sIngress: AgentIngress,
  componentSend: SendStanzaFn,
): Promise<void> {
  const bare = fromJid.split('/')[0];
  if (c2sIngress.hasSession?.(bare)) {
    await c2sIngress.sendStanza!(bare, stanza);
    return;
  }
  await componentSend(stanza);
}

export function createAgentSender(c2sIngress: AgentIngress, componentSend: SendStanzaFn): SendForAgentFn {
  return (agentJid, stanza) => sendStanzaForAgent(agentJid, stanza, c2sIngress, componentSend);
}

export async function sendComposingForAgent(
  sendForAgent: SendForAgentFn,
  agentJid: string,
  targets: Pick<InboundChatTargets, 'to' | 'threadId' | 'groupchat'>,
): Promise<void> {
  await sendForAgent(
    agentJid,
    buildComposingStanza({
      from: agentJid,
      to: targets.to,
      threadId: targets.threadId,
      groupchat: targets.groupchat,
    }),
  );
}
