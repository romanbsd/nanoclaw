/**
 * Central inbound stanza dispatch for the component. Routes by stanza kind and spec:
 *   presence            -> RFC 6121 §3 roster/probe handling (presence.ts)
 *   ask-question submit -> XEP-0004 Data Forms (data-form.ts)
 *   agent-task payloads -> gateway-private urn:businessos:agent-task:1 (task-stanza-codec.ts)
 *   XEP-0085/0184/0333  -> chat states & receipts are swallowed, not delivered (receipts.ts)
 *   message             -> normalized to AgentMessage (message.ts), then delivery-gated
 *
 * On accepted 1:1 messages the router emits an XEP-0085 composing state and, when the
 * sender opted in with an XEP-0184 <request/>, a delivery receipt.
 *
 * @see https://www.rfc-editor.org/rfc/rfc6121#section-3
 * @see https://xmpp.org/extensions/xep-0085.html
 * @see https://xmpp.org/extensions/xep-0184.html
 */
import type { Element } from '@xmpp/xml';

import type { AgentMessage } from '@agent-xmpp/protocol';

import { sendComposingForAgent } from './agent-send.js';
import { bareJid } from './xep-plugins/jid.js';
import type { GatewayConfig } from './config.js';
import {
  pushFormResponseToBridge,
  pushInboundToBridge,
  resolveInboundChatTargets,
  shouldAcceptStanza,
  type InboundDeliveryContext,
} from './delivery.js';
import type { GatewayRuntimeMailbox } from './runtime-mailbox.js';
import {
  isAgentJid,
  resolveTargetAgentJid,
  stanzaToAgentMessage,
} from './xep-plugins/message.js';
import { parseAskQuestionSubmit } from './xep-plugins/data-form.js';
import { buildReceivedReceipt, isAckOrReceiptStanza, requestsReceipt } from './xep-plugins/receipts.js';
import { parseTaskEvent, parseTaskInvocation } from './task-stanza-codec.js';
import { presenceResponses, type VirtualAgentIdentity } from './xep-plugins/presence.js';

export type SendStanzaFn = (stanza: Element) => Promise<void>;
export type SendForAgentFn = (agentJid: string, stanza: Element) => Promise<void>;
export type ResolveVirtualAgentFn = (jid: string) => VirtualAgentIdentity | null;

export class StanzaRouter {
  constructor(
    private config: GatewayConfig,
    private mailbox: GatewayRuntimeMailbox,
    private sendForAgent: SendForAgentFn,
    private resolveVirtualAgent?: ResolveVirtualAgentFn,
  ) {}

  async handleIncoming(stanza: Element): Promise<void> {
    if (stanza.name === 'presence') {
      const to = bareJid(String(stanza.attrs.to ?? ''));
      const agent = this.resolveVirtualAgent?.(to);
      if (agent) {
        for (const response of presenceResponses(stanza, agent)) {
          await this.sendForAgent(agent.jid, response);
        }
      }
      return;
    }
    if (stanza.name !== 'message') return;

    const toBare = (stanza.attrs.to as string)?.split('/')[0] || '';
    // Stanzas arrive on the component JID; resolve which registered agent they target.
    const agentJid = resolveTargetAgentJid(toBare, this.config.agentDomain, this.config.defaultAgentJid);

    if (!isAgentJid(agentJid, this.config.agentDomain) && agentJid !== this.config.defaultAgentJid) {
      return;
    }

    const from = stanza.attrs.from as string;
    const fromBare = bareJid(from);
    const agentBare = bareJid(agentJid);
    // C2S inbox receives agent self-sent stanzas (outbound loopback) — drop them.
    if (fromBare && agentBare && fromBare === agentBare) return;
    const taskEvent = parseTaskEvent(stanza);
    if (taskEvent) {
      await this.mailbox.deliverTaskEvent(taskEvent);
      return;
    }

    const formSubmit = parseAskQuestionSubmit(stanza);
    if (formSubmit) {
      const type = (stanza.attrs.type as string) || 'chat';
      await pushFormResponseToBridge(this.config, this.mailbox, {
        agentJid,
        from,
        stanzaType: type,
        questionId: formSubmit.questionId,
        selectedIndex: formSubmit.selectedIndex,
      });
      return;
    }

    const task = parseTaskInvocation(stanza);
    if (task) {
      await this.mailbox.deliverTaskInvocation(task);
      return;
    }
    if (isAckOrReceiptStanza(stanza)) return;
    const agentMsg = stanzaToAgentMessage(stanza, this.config.agentDomain);
    if (!agentMsg) return;

    const type = (stanza.attrs.type as string) || 'chat';
    const agentNick = agentJid.split('@')[0];
    const bodyText = typeof agentMsg.body === 'string' ? agentMsg.body : JSON.stringify(agentMsg.body);

    if (!shouldAcceptStanza(type, from, bodyText, agentNick)) return;

    const stanzaId = agentMsg.id;

    const ctx: InboundDeliveryContext = {
      agentMsg,
      agentJid,
      deliveryId: stanzaId,
      stanzaType: type,
      from,
      redelivered: false,
    };

    void sendComposingForAgent(
      (stanza) => this.sendForAgent(agentJid, stanza),
      agentJid,
      resolveInboundChatTargets(from, type, agentMsg),
    ).catch((err) => {
      console.error('[xmpp-gateway] composing notification send failed:', err);
    });

    await pushInboundToBridge(this.config, this.mailbox, ctx);

    // XEP-0184: ack only 1:1 messages that explicitly requested a receipt.
    // Groupchat receipts are not used (§5.5) and unsolicited ones spam the sender.
    if (from && type === 'chat' && requestsReceipt(stanza)) {
      await this.sendForAgent(agentJid, buildReceivedReceipt(from, agentJid, stanzaId)).catch((err) => {
        console.error('[xmpp-gateway] received receipt send failed:', err);
      });
    }
  }

}
