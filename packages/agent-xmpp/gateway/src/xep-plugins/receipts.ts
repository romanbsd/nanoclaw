/**
 * XEP-0184 Message Delivery Receipts.
 * Bodyless XEP-0085 chat states are filtered by the same routing guard.
 *
 * @see https://xmpp.org/extensions/xep-0184.html
 * @see https://xmpp.org/extensions/xep-0085.html
 */

import { xml, type Element } from '@xmpp/xml';

import { isChatStateStanza } from './chatstate.js';

export const RECEIPTS_NS = 'urn:xmpp:receipts';

/** The id a peer's <received/> acknowledges, or null if the stanza isn't a receipt. */
export function receivedReceiptId(stanza: Element): string | null {
  if (stanza.name !== 'message') return null;
  return (stanza.getChild('received', RECEIPTS_NS)?.attrs.id as string | undefined) ?? null;
}

/** True for XEP-0085 chat states and XEP-0184 receipt stanzas with no conversational body. */
export function isAckOrReceiptStanza(stanza: Element): boolean {
  if (isChatStateStanza(stanza)) return true;
  if (stanza.name !== 'message') return false;
  const body = stanza.getChildText('body');
  if (body?.trim()) return false;
  if (stanza.getChild('received', RECEIPTS_NS)) return true;
  if (stanza.getChild('request', RECEIPTS_NS)) return true;
  return false;
}

/** XEP-0184: only ack when the sender opted in with <request/>. */
export function requestsReceipt(stanza: Element): boolean {
  return stanza.name === 'message' && stanza.getChild('request', RECEIPTS_NS) != null;
}

export function buildReceivedReceipt(to: string, from: string, messageId: string): Element {
  return xml(
    'message',
    { to, from, id: `receipt-${messageId}` },
    xml('received', { xmlns: RECEIPTS_NS, id: messageId }),
  );
}
