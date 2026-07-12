import type { AgentTaskRecord, OutboundDeliverRequest } from '@agent-xmpp/protocol';
import type { Element } from '@xmpp/xml';

import type { GatewayConfig } from './config.js';
export { loadConfig } from './config.js';
export type { GatewayConfig } from './config.js';
import { sendComposingForAgent, sendPausedForAgent } from './agent-send.js';
import { StanzaRouter } from './stanza-router.js';
import type { GatewayRuntimeMailbox } from './runtime-mailbox.js';
import { applyStoreHints, buildOutboundStanza } from './xep-plugins/message.js';
import { isMucJid } from './xep-plugins/muc.js';
import { buildTaskEvent, buildTaskInvocation, type TaskWireEvent } from './task-stanza-codec.js';
import { createComponentSession, type IqGetHandler, type XmppComponentSession } from './xmpp-component.js';

/** In-process XMPP channel runtime. All agent IO crosses GatewayRuntimeMailbox. */
export class EmbeddedXmppGateway {
  private session: XmppComponentSession | null = null;
  private router: StanzaRouter | null = null;

  constructor(
    private readonly config: GatewayConfig,
    private readonly mailbox: GatewayRuntimeMailbox,
    private readonly onIqGet?: IqGetHandler,
  ) {}

  async start(): Promise<void> {
    if (this.session) return;
    const session = createComponentSession(this.config, this.onIqGet);
    const sendForAgent = async (_agentJid: string, stanza: Element) => session.send(stanza);
    const router = new StanzaRouter(this.config, this.mailbox, sendForAgent);
    session.onStanza((stanza) => void router.handleIncoming(stanza));
    await session.start();
    this.session = session;
    this.router = router;
  }

  async stop(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.router = null;
    if (session) await session.stop();
  }

  isConnected(): boolean {
    return this.session !== null;
  }

  async deliver(input: OutboundDeliverRequest & { from: string }): Promise<string> {
    const session = this.requiredSession();
    const stanza = applyStoreHints(buildOutboundStanza(input, input.from));
    await session.send(stanza);
    return String(stanza.attrs.id ?? '');
  }

  async deliverTask(task: AgentTaskRecord): Promise<string> {
    const stanza = buildTaskInvocation(task);
    await this.requiredSession().send(stanza);
    return String(stanza.attrs.id ?? '');
  }

  async deliverTaskEvent(event: TaskWireEvent): Promise<string> {
    const stanza = buildTaskEvent(event);
    await this.requiredSession().send(stanza);
    return String(stanza.attrs.id ?? '');
  }

  async setTyping(from: string, to: string, threadId: string | null, state: 'composing' | 'paused'): Promise<void> {
    const session = this.requiredSession();
    const targets = { to, threadId, groupchat: isMucJid(to) };
    const send = (stanza: Element) => session.send(stanza);
    if (state === 'paused') await sendPausedForAgent(send, from, targets);
    else await sendComposingForAgent(send, from, targets);
  }

  private requiredSession(): XmppComponentSession {
    if (!this.session) throw new Error('XMPP gateway is not connected');
    return this.session;
  }
}

export type { GatewayRuntimeMailbox } from './runtime-mailbox.js';
export type { Element } from '@xmpp/xml';
export * from './agent-api-disco.js';
export * from './task-stanza-codec.js';
export * from './xep-plugins/ping.js';
