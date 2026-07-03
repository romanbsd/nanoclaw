#!/usr/bin/env node
/**
 * agent-xmpp-gateway — always-on XEP-0114 component gateway for NanoClaw.
 */
import { loadConfig } from './config.js';
import { createHttpServer } from './http-server.js';
import { Mailbox } from './mailbox.js';
import { StanzaRouter } from './stanza-router.js';
import { AgentRegistry } from './xep-plugins/discovery.js';
import { parseSlotResponse } from './xep-plugins/file-upload.js';
import { MamQueryAwaiter } from './xep-plugins/mam-query.js';
import { createComponentSession } from './xmpp-component.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const mailbox = new Mailbox(config.dataDir);
  const agentRegistry = new AgentRegistry();
  const pendingIq = new Map<string, { resolve: (stanza: unknown) => void; reject: (e: Error) => void }>();
  const mamAwaiter = new MamQueryAwaiter();

  const session = createComponentSession(config);
  const router = new StanzaRouter(config, mailbox, (stanza) => session.send(stanza));

  session.onStanza((stanza) => {
    if (mamAwaiter.handleStanza(stanza, config.agentDomain)) return;

    if (stanza.name === 'iq' && stanza.attrs.type === 'result') {
      const id = stanza.attrs.id as string;
      const pending = pendingIq.get(id);
      if (pending) {
        pendingIq.delete(id);
        pending.resolve(stanza);
        return;
      }
      if (parseSlotResponse(stanza)) {
        const p = pendingIq.get(id);
        if (p) {
          pendingIq.delete(id);
          p.resolve(stanza);
        }
      }
      return;
    }
    void router.handleIncoming(stanza);
  });

  await createHttpServer({ config, mailbox, send: (s) => session.send(s), agentRegistry, pendingIq, mamAwaiter });
  await session.start();
  await router.sweepPending();

  const shutdown = async () => {
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
