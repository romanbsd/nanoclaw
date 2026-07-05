/** XEP-0085 Chat State Notifications */

import { xml, type Element } from '@xmpp/xml';

const CHATSTATES_NS = 'http://jabber.org/protocol/chatstates';

export function isChatStateStanza(stanza: Element): boolean {
  if (stanza.name !== 'message') return false;
  const body = stanza.getChildText('body');
  if (body?.trim()) return false;
  for (const child of stanza.children) {
    if (typeof child !== 'object' || child === null) continue;
    if (child.attrs?.xmlns === CHATSTATES_NS) return true;
  }
  return false;
}

export function buildComposingStanza(opts: {
  from: string;
  to: string;
  threadId?: string | null;
  groupchat?: boolean;
}): Element {
  const to = opts.to.split('/')[0];
  const type = opts.groupchat ? 'groupchat' : 'chat';
  const children: Element[] = [xml('composing', { xmlns: CHATSTATES_NS })];
  if (opts.threadId) {
    children.unshift(xml('thread', {}, opts.threadId));
  }
  return xml('message', { type, to, from: opts.from.split('/')[0] }, ...children);
}
