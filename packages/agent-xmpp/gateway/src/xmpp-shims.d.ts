declare module '@xmpp/client' {
  import type { Element } from '@xmpp/xml';
  export function client(options: {
    service: string;
    domain: string;
    username: string;
    password: string;
    tls?: { rejectUnauthorized?: boolean };
  }): {
    on(event: 'stanza', handler: (stanza: Element) => void): void;
    on(event: 'error', handler: (err: Error) => void): void;
    send(stanza: Element): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
  };
}

declare module '@xmpp/component' {
  import type { Element } from '@xmpp/xml';
  export function component(options: {
    service: string;
    domain: string;
    password: string;
  }): {
    on(event: 'stanza', handler: (stanza: Element) => void): void;
    on(event: 'error', handler: (err: Error) => void): void;
    send(stanza: Element): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
  };
}

declare module '@xmpp/xml' {
  export interface Element {
    name: string;
    attrs: Record<string, string | undefined>;
    children: (Element | string)[];
    append(child: Element): void;
    getChild(name: string, xmlns?: string): Element | undefined;
    getChildText(name: string, xmlns?: string): string | undefined;
    toString(): string;
  }
  export function xml(
    name: string,
    attrs?: Record<string, string | undefined>,
    ...children: (Element | string)[]
  ): Element;
}

declare module '@xmpp/reconnect' {
  export function reconnect(client: unknown, options?: { delay?: number }): unknown;
}

declare module '@xmpp/jid' {
  export function jid(value: string): { bare: string; domain: string; resource?: string };
}
