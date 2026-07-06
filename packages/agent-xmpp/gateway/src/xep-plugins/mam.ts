/** XEP-0313 Message Archive Management, XEP-0059 Result Set Management */

import { xml, type Element } from '@xmpp/xml';
import { ulid } from 'ulid';

import type { AgentMessage, XmppGetArchiveInput } from '@agent-xmpp/protocol';

import { stanzaToAgentMessage } from './message.js';

const MAM_NS = 'urn:xmpp:mam:2';
const RSM_NS = 'http://jabber.org/protocol/rsm';

export function buildMamQuery(from: string, input: XmppGetArchiveInput): Element {
  const queryId = `mam-${ulid()}`;
  const withJid = input.with || input.roomId;
  const children: Element[] = [
    xml('query', { xmlns: MAM_NS, queryid: queryId }),
  ];

  if (withJid) {
    children.push(xml('x', { xmlns: 'jabber:x:data', type: 'submit' }, xml('field', { var: 'with' }, xml('value', {}, withJid))));
  }

  const rsmChildren: Element[] = [];
  if (input.before) rsmChildren.push(xml('before', {}, input.before));
  if (input.after) rsmChildren.push(xml('after', {}, input.after));
  if (input.limit) rsmChildren.push(xml('max', {}, String(input.limit)));
  if (rsmChildren.length) {
    children.push(xml('set', { xmlns: RSM_NS }, ...rsmChildren));
  }

  // MUC archive queries go to the room; personal-archive queries go to the querier's
  // own bare account JID (a full JID would target one resource's archive, not the account).
  const to = input.roomId || from.split('/')[0];
  return xml('iq', { type: 'set', from, to, id: queryId }, ...children);
}

export function parseMamResults(stanzas: Element[], agentDomain: string): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const stanza of stanzas) {
    const result = stanza.getChild('result', MAM_NS);
    if (!result) continue;
    const forwarded = result.getChild('forwarded', 'urn:xmpp:forward:0');
    const msg = forwarded?.getChild('message');
    if (!msg) continue;
    const agent = stanzaToAgentMessage(msg, agentDomain);
    if (agent) messages.push(agent);
  }
  return messages;
}

export interface MamPaging {
  before?: string;
  after?: string;
  complete?: boolean;
}

export function parseRsmPaging(stanza: Element): MamPaging | undefined {
  const fin = stanza.getChild('fin', MAM_NS);
  if (!fin) return undefined;
  const set = fin.getChild('set', RSM_NS);
  if (!set) return { complete: fin.attrs.complete === 'true' };
  return {
    before: set.getChildText('before') || undefined,
    after: set.getChildText('after') || undefined,
    complete: fin.attrs.complete === 'true',
  };
}
