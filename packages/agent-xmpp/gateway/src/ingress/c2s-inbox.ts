/**
 * C2S ingress for provisioned agent JIDs.
 *
 * OpenFire delivers human DMs to local user accounts. Those stanzas never reach the
 * XEP-0114 component, so the gateway connects as each agent user and forwards
 * inbound chat through the runtime inbound port (default: bridge webhook → session DB).
 *
 * Outbound MUC join/leave/room messages must also use C2S — the component cannot
 * impersonate local users for XEP-0045 presence.
 */
import { client } from '@xmpp/client';
import { xml, type Element } from '@xmpp/xml';

import type { GatewayConfig } from '../config.js';
import type { AgentIngress, StanzaHandler } from './types.js';

interface InboxSession {
  xmpp: ReturnType<typeof client>;
  stop: () => Promise<void>;
}

export class C2sAgentIngress implements AgentIngress {
  readonly kind = 'c2s';

  private sessions = new Map<string, InboxSession>();

  constructor(
    private readonly config: GatewayConfig,
    private readonly onMessage: StanzaHandler,
  ) {}

  hasSession(jid: string): boolean {
    const bare = jid.split('/')[0];
    return this.sessions.has(bare);
  }

  async sendStanza(jid: string, stanza: Element): Promise<void> {
    const bare = jid.split('/')[0];
    const session = this.sessions.get(bare);
    if (!session) {
      throw new Error(`No C2S session for ${bare}`);
    }
    await session.xmpp.send(stanza);
  }

  async register(jid: string, password: string): Promise<void> {
    const bare = jid.split('/')[0];
    if (!bare.includes('@')) {
      throw new Error(`Invalid agent JID: ${jid}`);
    }

    await this.unregister(bare);

    const [username, domain] = bare.split('@');
    if (!username || !domain) {
      throw new Error(`Invalid agent JID: ${jid}`);
    }

    const xmpp = client({
      service: this.config.c2sService,
      domain,
      username,
      password,
      tls: {
        rejectUnauthorized: process.env.XMPP_TLS_REJECT_UNAUTHORIZED === '1',
      },
    });

    xmpp.on('error', (err: Error) => {
      console.error(`[xmpp-gateway] c2s ingress ${bare} error:`, err.message);
    });

    xmpp.on('stanza', (stanza) => {
      if (stanza.name !== 'message') return;
      const type = (stanza.attrs.type as string) || 'chat';
      if (type === 'error' || type === 'headline') return;
      void this.onMessage(stanza).catch((err) => {
        console.error(`[xmpp-gateway] c2s ingress ${bare} forward failed:`, err);
      });
    });

    await xmpp.start();
    await xmpp.send(xml('presence'));

    this.sessions.set(bare, {
      xmpp,
      stop: () => xmpp.stop(),
    });
    console.error(`[xmpp-gateway] c2s ingress online: ${bare}`);
  }

  async unregister(jid: string): Promise<void> {
    const bare = jid.split('/')[0];
    const session = this.sessions.get(bare);
    if (!session) return;
    this.sessions.delete(bare);
    await session.stop().catch((err) => {
      console.error(`[xmpp-gateway] c2s ingress ${bare} stop failed:`, err);
    });
    console.error(`[xmpp-gateway] c2s ingress stopped: ${bare}`);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((jid) => this.unregister(jid)));
  }
}
