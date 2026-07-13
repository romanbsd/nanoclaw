/**
 * XEP-0045 Multi-User Chat presence and groupchat messages.
 * Mentions use XEP-0513 wire format. Outbound uses the `jid` address form (the
 * spec's non-anonymous fallback) — the gateway does not yet track XEP-0421
 * occupant-ids, which XEP-0513 mandates for rooms that support them. No begin/end
 * offsets, since the gateway doesn't track where in the body a mention occurs.
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
  // XEP-0045 §7.2.2: request zero history so joining doesn't flood the agent
  // with the room's backlog as fresh inbound messages.
  const mucChildren: Element[] = [xml('history', { maxstanzas: '0' })];
  if (input.password) {
    mucChildren.unshift(xml('password', {}, input.password));
  }
  return xml('presence', { to: roomWithNick, from: agentJid }, xml('x', { xmlns: MUC_NS }, ...mucChildren));
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

  for (const m of input.mentions ?? []) {
    stanza.append(xml('mention', { xmlns: 'urn:xmpp:mentions:0', jid: m }));
  }

  return stanza;
}

export function mucRoomFromStanza(from: string): string | null {
  if (!from.includes('/')) return null;
  const [room] = from.split('/');
  return isMucJid(room) ? room : null;
}
