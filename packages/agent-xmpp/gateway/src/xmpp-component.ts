import { component } from '@xmpp/component';
import { xml, type Element } from '@xmpp/xml';

import type { GatewayConfig } from './config.js';
import { buildGatewayDiscoResponse } from './xep-plugins/discovery.js';

export interface XmppComponentSession {
  send: (stanza: Element) => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  onStanza: (handler: (stanza: Element) => void) => void;
}

export type IqGetHandler = (stanza: Element) => Element | null;

export function createComponentSession(config: GatewayConfig, onIqGet?: IqGetHandler): XmppComponentSession {
  const xmpp = component({
    service: config.componentService,
    domain: config.componentJid,
    password: config.componentSecret,
  });

  const stanzaHandlers: Array<(stanza: Element) => void> = [];

  xmpp.on('stanza', (stanza: Element) => {
    if (stanza.name === 'iq' && onIqGet) {
      const response = onIqGet(stanza);
      if (response) {
        xmpp.send(response).catch((err) => {
          console.error('[xmpp-gateway] IQ get response send failed:', err);
        });
        return;
      }
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
