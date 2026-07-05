import type { Element } from '@xmpp/xml';

/** Collects XMPP stanzas addressed to agent JIDs and forwards them for delivery. */
export interface AgentIngress {
  readonly kind: string;
  register(jid: string, password: string): Promise<void>;
  unregister(jid: string): Promise<void>;
  stopAll(): Promise<void>;
  /** True when this JID has a live C2S session (local OpenFire user). */
  hasSession?(jid: string): boolean;
  /** Send a stanza on the agent's C2S session; falls back to caller if unsupported. */
  sendStanza?(jid: string, stanza: Element): Promise<void>;
}

export type StanzaHandler = (stanza: Element) => Promise<void>;
