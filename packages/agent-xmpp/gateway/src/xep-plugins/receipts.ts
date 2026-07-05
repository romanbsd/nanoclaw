/** XEP-0184 Message Delivery Receipts, XEP-0333 Chat Markers */

import { xml, type Element } from '@xmpp/xml';

import { isChatStateStanza } from './chatstate.js';

const RECEIPTS_NS = 'urn:xmpp:receipts';
const MARKERS_NS = 'urn:xmpp:chat-markers:0';

/** True for XEP-0085 chat states and XEP-0184/0333 ack stanzas with no conversational body. */
export function isAckOrReceiptStanza(stanza: Element): boolean {
  if (isChatStateStanza(stanza)) return true;
  if (stanza.name !== 'message') return false;
  const body = stanza.getChildText('body');
  if (body?.trim()) return false;
  if (stanza.getChild('received', RECEIPTS_NS)) return true;
  if (stanza.getChild('displayed', MARKERS_NS)) return true;
  if (stanza.getChild('acknowledged', MARKERS_NS)) return true;
  if (stanza.getChild('request', RECEIPTS_NS)) return true;
  return false;
}

export function buildReceivedReceipt(to: string, from: string, messageId: string): Element {
  return xml(
    'message',
    { to, from, id: `receipt-${messageId}` },
    xml('received', { xmlns: RECEIPTS_NS, id: messageId }),
  );
}

export function buildDisplayedMarker(to: string, from: string, messageId: string): Element {
  return xml(
    'message',
    { to, from, id: `marker-${messageId}` },
    xml('displayed', { xmlns: MARKERS_NS, id: messageId }),
  );
}

export function buildAckStanza(
  to: string,
  from: string,
  messageId: string,
  status: 'received' | 'seen' | 'processing' | 'completed' | 'failed',
): Element {
  if (status === 'received') return buildReceivedReceipt(to, from, messageId);
  if (status === 'seen' || status === 'completed') return buildDisplayedMarker(to, from, messageId);
  return buildReceivedReceipt(to, from, messageId);
}
