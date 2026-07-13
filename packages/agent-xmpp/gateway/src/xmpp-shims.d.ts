declare module '@xmpp/xml' {
  export class Element {
    name: string;
    attrs: Record<string, unknown>;
    children: Array<Element | string>;

    getChild(name: string, xmlns?: string): Element | undefined;
    getChildren(name: string, xmlns?: string): Element[];
    getChildText(name: string, xmlns?: string): string | null;
    getText(): string;
    append(child: Element | string): this;
    toString(): string;
  }

  export function xml(
    name: string,
    attrs?: Record<string, unknown>,
    ...children: Array<Element | string | undefined | null>
  ): Element;

  export default xml;
}

declare module '@xmpp/component' {
  import type { Element } from '@xmpp/xml';

  interface ComponentClient {
    on(event: 'stanza', handler: (stanza: Element) => void): this;
    on(event: 'error', handler: (error: Error) => void): this;
    send(stanza: Element): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
  }

  export function component(options: {
    service: string;
    domain: string;
    password: string;
  }): ComponentClient;
}
