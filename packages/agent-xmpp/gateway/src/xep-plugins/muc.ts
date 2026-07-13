/**
 * XEP-0045 Multi-User Chat presence and groupchat messages.
 * The existing gateway-private <mentions/> payload is not XEP-0513 wire format;
 * XEP-0513 is the interoperability target for a future transport switch.
 *
 * @see https://xmpp.org/extensions/xep-0045.html
 * @see https://xmpp.org/extensions/xep-0513.html
 */

import { xml, type Element } from '@xmpp/xml';

import { isMucJid } from './jid.js';
import { buildOutboundStanza } from './message.js';

export { isMucJid };

const MUC_NS = 'http://jabber.org/protocol/muc';

export interface XmppJoinRoomInput { roomJid: string; nickname?: string; password?: string }
export interface XmppLeaveRoomInput { roomJid: string; nickname?: string }
export interface XmppSendRoomMessageInput {
  roomJid: string;
  body: string;
  threadId?: string;
  mentions?: string[];
}

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
