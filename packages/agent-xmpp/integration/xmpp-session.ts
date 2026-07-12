/**
 * Minimal XMPP client session for E2E verification.
 */
import { client } from '@xmpp/client';
import { xml, type Element } from '@xmpp/xml';

export interface XmppSessionOptions {
  service: string;
  domain: string;
  username: string;
  password: string;
}

export class XmppSession {
  private xmpp: ReturnType<typeof client>;
  private handlers: Array<(stanza: Element) => void> = [];

  constructor(private opts: XmppSessionOptions) {
    this.xmpp = client({
      service: opts.service,
      domain: opts.domain,
      username: opts.username,
      password: opts.password,
      tls: { rejectUnauthorized: process.env.XMPP_TLS_REJECT_UNAUTHORIZED === '1' },
    });
    this.xmpp.on('stanza', (stanza) => {
      for (const h of this.handlers) h(stanza);
    });
    this.xmpp.on('error', (err: Error) => console.error('[xmpp-session] error:', err.message));
  }

  async start(): Promise<void> {
    await this.xmpp.start();
    await this.xmpp.send(xml('presence'));
  }

  async stop(): Promise<void> {
    await this.xmpp.stop();
  }

  async sendChat(to: string, body: string, id?: string): Promise<void> {
    await this.xmpp.send(
      xml('message', { type: 'chat', to, id: id || `msg-${Date.now()}` }, xml('body', {}, body)),
    );
  }

  async send(stanza: Element): Promise<void> {
    await this.xmpp.send(stanza);
  }

  waitForStanza(predicate: (stanza: Element) => boolean, timeoutMs = 30_000): Promise<Element> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('timeout waiting for XMPP stanza'));
      }, timeoutMs);
      const handler = (stanza: Element) => {
        if (!predicate(stanza)) return;
        cleanup();
        resolve(stanza);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.handlers = this.handlers.filter((h) => h !== handler);
      };
      this.handlers.push(handler);
    });
  }

  waitForBody(text: string, timeoutMs = 30_000): Promise<Element> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout waiting for body: ${text}`));
      }, timeoutMs);
      const handler = (stanza: Element) => {
        if (!stanza.is('message')) return;
        const body = stanza.getChildText('body')?.trim();
        if (body === text) {
          cleanup();
          resolve(stanza);
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.handlers = this.handlers.filter((h) => h !== handler);
      };
      this.handlers.push(handler);
    });
  }
}
