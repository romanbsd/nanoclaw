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
  autoReceipts?: boolean;
}

const RECEIPTS_NS = 'urn:xmpp:receipts';

export class XmppSession {
  private xmpp: ReturnType<typeof client>;
  private handlers: Array<(stanza: Element) => void> = [];
  private autoReceipts: boolean;

  constructor(private opts: XmppSessionOptions) {
    this.autoReceipts = opts.autoReceipts ?? false;
    this.xmpp = client({
      service: opts.service,
      domain: opts.domain,
      username: opts.username,
      password: opts.password,
      tls: { rejectUnauthorized: process.env.XMPP_TLS_REJECT_UNAUTHORIZED === '1' },
    });
    this.xmpp.on('stanza', (stanza) => {
      for (const h of this.handlers) h(stanza);
      if (this.autoReceipts && stanza.is('message') && stanza.attrs.type !== 'groupchat') {
        const id = String(stanza.attrs.id ?? '');
        const to = String(stanza.attrs.from ?? '');
        if (id && to && stanza.getChild('request', RECEIPTS_NS)) {
          void this.xmpp
            .send(
              xml('message', { type: stanza.attrs.type ?? 'chat', to }, xml('received', { xmlns: RECEIPTS_NS, id })),
            )
            .catch((err: Error) => console.error('[xmpp-session] receipt send failed:', err.message));
        }
      }
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
    await this.xmpp.send(xml('message', { type: 'chat', to, id: id || `msg-${Date.now()}` }, xml('body', {}, body)));
  }

  async subscribe(to: string): Promise<void> {
    await this.xmpp.send(xml('presence', { type: 'subscribe', to }));
  }

  async unsubscribe(to: string): Promise<void> {
    await this.xmpp.send(xml('presence', { type: 'unsubscribe', to }));
  }

  async send(stanza: Element): Promise<void> {
    await this.xmpp.send(stanza);
  }

  setAutoReceipts(enabled: boolean): void {
    this.autoReceipts = enabled;
  }

  collectStanzas(predicate: (stanza: Element) => boolean, durationMs: number): Promise<Element[]> {
    return new Promise((resolve) => {
      const matches: Element[] = [];
      const handler = (stanza: Element) => {
        if (predicate(stanza)) matches.push(stanza);
      };
      this.handlers.push(handler);
      setTimeout(() => {
        this.handlers = this.handlers.filter((h) => h !== handler);
        resolve(matches);
      }, durationMs);
    });
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
