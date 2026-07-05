import type { Element } from '@xmpp/xml';

import type { AgentIngress } from './ingress/types.js';
import type { SendStanzaFn } from './stanza-router.js';

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
