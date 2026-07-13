/**
 * External-component session using XEP-0114 Jabber Component Protocol.
 * @see https://xmpp.org/extensions/xep-0114.html
 */
import { component } from '@xmpp/component';
import { xml, type Element } from '@xmpp/xml';

import type { GatewayConfig } from './config.js';

export interface XmppComponentSession {
  send: (stanza: Element) => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  onStanza: (handler: (stanza: Element) => void) => void;
}

export type IqGetHandler = (stanza: Element) => Element | null;

const STANZA_ERROR_NS = 'urn:ietf:params:xml:ns:xmpp-stanzas';

/**
 * RFC 6120 §8.3 stanza error for an IQ get/set the gateway does not handle.
 * `service-unavailable` (type cancel) is the standard "no such handler" reply;
 * the original request payload is echoed back per the SHOULD in §8.3.1.
 */
export function buildIqError(request: Element): Element {
  return xml(
    'iq',
    { type: 'error', id: request.attrs.id, from: request.attrs.to, to: request.attrs.from },
    ...request.children.filter((c): c is Element => typeof c !== 'string'),
    xml('error', { type: 'cancel' }, xml('service-unavailable', { xmlns: STANZA_ERROR_NS })),
  );
}

export type IqDisposition =
  | { kind: 'respond'; stanza: Element }
  | { kind: 'error' }
  | { kind: 'dispatch' };

/**
 * Decide how an inbound stanza is handled by the component:
 *  - IQ get/set the gateway answers    -> `respond` with the built reply
 *  - IQ get/set nothing handled        -> `error` (RFC 6120 §8.2.3 requires a reply)
 *  - everything else, incl. IQ result/error responses to our own outbound requests
 *    and all message/presence stanzas  -> `dispatch` to the registered stanza handlers
 */
export function dispositionForStanza(stanza: Element, onIqGet?: IqGetHandler): IqDisposition {
  if (stanza.name === 'iq') {
    const type = String(stanza.attrs.type ?? '');
    if (type === 'get' || type === 'set') {
      const response = onIqGet?.(stanza) ?? null;
      return response ? { kind: 'respond', stanza: response } : { kind: 'error' };
    }
  }
  return { kind: 'dispatch' };
}

export function createComponentSession(config: GatewayConfig, onIqGet?: IqGetHandler): XmppComponentSession {
  const xmpp = component({
    service: config.componentService,
    domain: config.componentJid,
    password: config.componentSecret,
  });

  const stanzaHandlers: Array<(stanza: Element) => void> = [];

  xmpp.on('stanza', (stanza: Element) => {
    const disposition = dispositionForStanza(stanza, onIqGet);
    if (disposition.kind !== 'dispatch') {
      const reply = disposition.kind === 'respond' ? disposition.stanza : buildIqError(stanza);
      xmpp.send(reply).catch((err) => {
        console.error(`[xmpp-gateway] IQ ${disposition.kind} send failed:`, err);
      });
      return;
    }
    for (const h of stanzaHandlers) h(stanza);
  });

  xmpp.on('error', (err: Error) => {
    console.error('[xmpp-gateway] component error:', err.message);
  });

  return {
    send: (stanza) => xmpp.send(stanza),
    start: async () => {
      await xmpp.start();
      console.error(`[xmpp-gateway] component online: ${config.componentJid}`);
    },
    stop: async () => {
      await xmpp.stop();
    },
    onStanza: (handler) => {
      stanzaHandlers.push(handler);
    },
  };
}

export { xml };
