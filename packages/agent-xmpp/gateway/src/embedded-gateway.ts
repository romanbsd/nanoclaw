import type { AgentTaskRecord, OutboundDeliverRequest } from '@agent-xmpp/protocol';
import type { Element } from '@xmpp/xml';

import type { GatewayConfig } from './config.js';
export { loadConfig } from './config.js';
export type { GatewayConfig } from './config.js';
import { sendComposingForAgent, sendInactiveForAgent, sendPausedForAgent } from './agent-send.js';
import { StanzaRouter, type ResolveVirtualAgentFn } from './stanza-router.js';
import type { GatewayRuntimeMailbox } from './runtime-mailbox.js';
import { applyStoreHints, buildOutboundStanza } from './xep-plugins/message.js';
import { isMucJid } from './xep-plugins/muc.js';
import { buildTaskEvent, buildTaskInvocation, type TaskWireEvent } from './task-stanza-codec.js';
import {
  createComponentSession,
  type IqGetHandler,
  type IqRequestOptions,
  type XmppComponentSession,
} from './xmpp-component.js';
import { RECEIPTS_NS } from './xep-plugins/receipts.js';
import { ReceiptTracker } from './receipt-tracker.js';

/** In-process XMPP channel runtime. All agent IO crosses GatewayRuntimeMailbox. */
export class EmbeddedXmppGateway {
  private session: XmppComponentSession | null = null;
  private router: StanzaRouter | null = null;
  private readonly receipts: ReceiptTracker;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: GatewayConfig,
    private readonly mailbox: GatewayRuntimeMailbox,
    private readonly onIqGet?: IqGetHandler,
    private readonly resolveVirtualAgent?: ResolveVirtualAgentFn,
  ) {
    this.receipts = new ReceiptTracker({
      timeoutMs: config.receiptTimeoutMs,
      maxResends: config.receiptMaxResends,
    });
  }

  async start(): Promise<void> {
    if (this.session) return;
    const session = createComponentSession(this.config, this.onIqGet);
    const sendForAgent = async (_agentJid: string, stanza: Element) => session.send(stanza);
    const router = new StanzaRouter(this.config, this.mailbox, sendForAgent, this.resolveVirtualAgent, (id) =>
      this.receipts.ack(id),
    );
    session.onStanza((stanza) => void router.handleIncoming(stanza));
    await session.start();
    this.session = session;
    this.router = router;
    this.sweepTimer = setInterval(() => this.resendUnacked(), this.config.receiptSweepMs);
    this.sweepTimer.unref?.();
  }

  async stop(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.router = null;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    // Drop pending receipts so a restart's sweep can't resend this session's stanzas.
    this.receipts.clear();
    if (session) await session.stop();
  }

  /**
   * XEP-0184 sweep. Default is observe-only (receiptMaxResends=0): un-acked messages
   * simply expire from tracking, since a missing receipt does not mean the message failed
   * and blind resends would duplicate ordinary messages. When an operator opts into
   * resends, we retry up to the cap and log the ones that still go unconfirmed.
   */
  private resendUnacked(): void {
    const session = this.session;
    if (!session) return;
    const { resend, gaveUp } = this.receipts.due(Date.now());
    for (const stanza of resend) {
      void session.send(stanza).catch((err) => {
        console.error('[xmpp-gateway] receipt resend failed:', err);
      });
    }
    // Only noteworthy when resends were actually attempted; observe-only expiry is normal.
    if (this.config.receiptMaxResends > 0) {
      for (const id of gaveUp) {
        console.error(`[xmpp-gateway] no delivery receipt for ${id} after ${this.config.receiptMaxResends} resends; giving up`);
      }
    }
  }

  isConnected(): boolean {
    return this.session !== null;
  }

  /** Send an IQ get/set and await its correlated result or error response. */
  requestIq(stanza: Element, options?: IqRequestOptions): Promise<Element> {
    return this.requiredSession().requestIq(stanza, options);
  }

  /**
   * The single outbound send path. Any stanza carrying an XEP-0184 <request/> is
   * registered for receipt tracking *before* the send resolves — otherwise a fast peer's
   * <received/> could arrive before registration and be dropped, leaving a delivered
   * message pending (and, with resends enabled, later duplicated). If the send itself
   * fails, the entry is removed.
   */
  private async sendTracked(stanza: Element): Promise<string> {
    const session = this.requiredSession();
    const id = String(stanza.attrs.id ?? '');
    const track = id !== '' && stanza.getChild('request', RECEIPTS_NS) != null;
    if (track) this.receipts.register(id, stanza);
    try {
      await session.send(stanza);
    } catch (err) {
      if (track) this.receipts.ack(id);
      throw err;
    }
    return id;
  }

  async deliver(input: OutboundDeliverRequest & { from: string }): Promise<string> {
    const built = buildOutboundStanza(input, input.from);
    // XEP-0334 <store/> so an offline 1:1 peer still gets it; MUC messages aren't stored.
    const stanza = applyStoreHints(built, built.attrs.type === 'chat' ? { store: true } : undefined);
    return this.sendTracked(stanza);
  }

  async deliverTask(task: AgentTaskRecord): Promise<string> {
    return this.sendTracked(buildTaskInvocation(task));
  }

  async deliverTaskEvent(event: TaskWireEvent): Promise<string> {
    return this.sendTracked(buildTaskEvent(event));
  }

  async setTyping(
    from: string,
    to: string,
    threadId: string | null,
    state: 'composing' | 'paused' | 'inactive',
  ): Promise<void> {
    const session = this.requiredSession();
    const targets = { to, threadId, groupchat: isMucJid(to) };
    const send = (stanza: Element) => session.send(stanza);
    if (state === 'inactive') await sendInactiveForAgent(send, from, targets);
    else if (state === 'paused') await sendPausedForAgent(send, from, targets);
    else await sendComposingForAgent(send, from, targets);
  }

  private requiredSession(): XmppComponentSession {
    if (!this.session) throw new Error('XMPP gateway is not connected');
    return this.session;
  }
}

export type { GatewayRuntimeMailbox } from './runtime-mailbox.js';
export type { Element } from '@xmpp/xml';
export { IqResponseError } from './xmpp-component.js';
export type { IqRequestOptions } from './xmpp-component.js';
export * from './agent-api-disco.js';
export * from './task-stanza-codec.js';
export * from './xep-plugins/ping.js';
export * from './xep-plugins/presence.js';
export * from './xep-plugins/vcard.js';
