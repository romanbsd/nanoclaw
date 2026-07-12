/** XEP-0199 XMPP Ping. */
import { xml, type Element } from '@xmpp/xml';

export const PING_NS = 'urn:xmpp:ping';

export function isPingRequest(stanza: Element): boolean {
  return stanza.name === 'iq' && stanza.attrs.type === 'get' && stanza.getChild('ping', PING_NS) != null;
}

export function buildPingResponse(stanza: Element): Element {
  return xml('iq', {
    type: 'result',
    id: stanza.attrs.id,
    from: stanza.attrs.to,
    to: stanza.attrs.from,
  });
}
