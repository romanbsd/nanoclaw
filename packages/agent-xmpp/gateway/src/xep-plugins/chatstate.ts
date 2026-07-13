/**
 * XEP-0085 Chat State Notifications.
 * @see https://xmpp.org/extensions/xep-0085.html
 */

import { xml, type Element } from '@xmpp/xml';

import { bareJid } from './jid.js';

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
  return buildChatStateStanza({ ...opts, state: 'composing' });
}

export function buildPausedStanza(opts: {
  from: string;
  to: string;
  threadId?: string | null;
  groupchat?: boolean;
}): Element {
  return buildChatStateStanza({ ...opts, state: 'paused' });
}

export function buildInactiveStanza(opts: {
  from: string;
  to: string;
  threadId?: string | null;
  groupchat?: boolean;
}): Element {
  return buildChatStateStanza({ ...opts, state: 'inactive' });
}

function buildChatStateStanza(opts: {
  from: string;
  to: string;
  threadId?: string | null;
  groupchat?: boolean;
  state: 'composing' | 'paused' | 'inactive';
}): Element {
  // XEP-0085 states belong to the same 1:1 resource as the chat response.
  const to = opts.groupchat ? bareJid(opts.to) : opts.to;
  const type = opts.groupchat ? 'groupchat' : 'chat';
  const children: Element[] = [xml(opts.state, { xmlns: CHATSTATES_NS })];
  if (opts.threadId) {
    children.unshift(xml('thread', {}, opts.threadId));
  }
  return xml('message', { type, to, from: bareJid(opts.from) }, ...children);
}
