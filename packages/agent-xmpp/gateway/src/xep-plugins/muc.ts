/** XEP-0045 Multi-User Chat, XEP-0513 Explicit Mentions (basic) */

import { xml, type Element } from '@xmpp/xml';

import type { XmppJoinRoomInput, XmppLeaveRoomInput, XmppSendRoomMessageInput } from '@agent-xmpp/protocol';

import { isMucJid } from './jid.js';
import { buildOutboundStanza } from './message.js';

export { isMucJid };

const MUC_NS = 'http://jabber.org/protocol/muc';

export function buildJoinPresence(input: XmppJoinRoomInput, agentJid: string): Element {
  const nick = input.nickname || agentJid.split('@')[0];
  const roomWithNick = `${input.roomJid}/${nick}`;
  const children: Element[] = [xml('x', { xmlns: MUC_NS })];
  if (input.password) {
    children[0] = xml('x', { xmlns: MUC_NS }, xml('password', {}, input.password));
  }
  return xml('presence', { to: roomWithNick, from: agentJid }, ...children);
}

export function buildLeavePresence(input: XmppLeaveRoomInput, agentJid: string, nickname?: string): Element {
  const nick = nickname || input.nickname || agentJid.split('@')[0];
  return xml('presence', {
    to: `${input.roomJid}/${nick}`,
    from: agentJid,
    type: 'unavailable',
  });
}

export function buildRoomMessage(input: XmppSendRoomMessageInput, fromJid: string): Element {
  const stanza = buildOutboundStanza(
    {
      from: fromJid,
      to: input.roomJid,
      threadId: input.threadId,
      content: input.body,
    },
    fromJid,
  );
  stanza.attrs.type = 'groupchat';

  if (input.mentions?.length) {
    const mentionEls = input.mentions.map((m) => xml('mention', { jid: m }));
    stanza.append(xml('mentions', {}, ...mentionEls));
  }

  return stanza;
}

export function mucRoomFromStanza(from: string): string | null {
  if (!from.includes('/')) return null;
  const [room] = from.split('/');
  return isMucJid(room) ? room : null;
}
