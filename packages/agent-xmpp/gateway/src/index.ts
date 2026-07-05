#!/usr/bin/env node
/**
 * agent-xmpp-gateway — always-on XEP-0114 component gateway for NanoClaw.
 */
import { loadConfig } from './config.js';
import { C2sAgentIngress } from './ingress/index.js';
import { createHttpServer } from './http-server.js';
import { Mailbox } from './mailbox.js';
import { StanzaRouter } from './stanza-router.js';
import { handleBindingIq } from './xep-plugins/a2a-binding.js';
import { AgentRegistry, buildGatewayDiscoResponse } from './xep-plugins/discovery.js';
import { MamQueryAwaiter } from './xep-plugins/mam-query.js';
import { createComponentSession } from './xmpp-component.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const mailbox = new Mailbox(config.dataDir);
  const agentRegistry = new AgentRegistry();
  const pendingIq = new Map<string, { resolve: (stanza: unknown) => void; reject: (e: Error) => void }>();
  const mamAwaiter = new MamQueryAwaiter();

  const session = createComponentSession(config, (stanza) => {
    const binding = handleBindingIq(stanza, config, agentRegistry);
    if (binding) return binding;
    const query = stanza.getChild('query', 'http://jabber.org/protocol/disco#info');
    if (query) {
      const from = stanza.attrs.from as string;
      const to = stanza.attrs.to as string;
      const iqId = stanza.attrs.id as string;
      const toBare = to.split('/')[0];
      if (toBare === config.componentJid.split('/')[0]) {
        return buildGatewayDiscoResponse(toBare, from, config.agentDomain, iqId);
      }
    }
    return null;
  });
  const router = new StanzaRouter(config, mailbox, (stanza) => session.send(stanza));
  const c2sIngress = new C2sAgentIngress(config, (stanza) => router.handleIncoming(stanza));

  session.onStanza((stanza) => {
    if (mamAwaiter.handleStanza(stanza, config.agentDomain)) return;

    if (stanza.name === 'iq' && (stanza.attrs.type === 'result' || stanza.attrs.type === 'error')) {
      const id = stanza.attrs.id as string;
      const pending = pendingIq.get(id);
      if (pending) {
        pendingIq.delete(id);
        if (stanza.attrs.type === 'error') {
          const errEl = stanza.getChild('error');
          pending.reject(new Error(errEl ? String(errEl) : 'iq error'));
        } else {
          pending.resolve(stanza);
        }
        return;
      }
      return;
    }
    void router.handleIncoming(stanza);
  });

  await createHttpServer({ config, mailbox, send: (s) => session.send(s), agentRegistry, c2sIngress, pendingIq, mamAwaiter });
  await session.start();
  await router.sweepPending();

  const shutdown = async () => {
    await c2sIngress.stopAll();
    await session.stop();
    mailbox.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error('[xmpp-gateway] fatal:', err);
  process.exit(1);
});
