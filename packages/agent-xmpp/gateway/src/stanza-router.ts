import type { Element } from '@xmpp/xml';

import type { AgentMessage } from '@agent-xmpp/protocol';

import { sendComposingForAgent } from './agent-send.js';
import type { GatewayConfig } from './config.js';
import {
  pushFormResponseToBridge,
  pushInboundToBridge,
  resolveInboundChatTargets,
  shouldAcceptStanza,
  type InboundDeliveryContext,
} from './delivery.js';
import { Mailbox } from './mailbox.js';
import {
  isAgentJid,
  resolveTargetAgentJid,
  stanzaToAgentMessage,
} from './xep-plugins/message.js';
import { parseAskQuestionSubmit } from './xep-plugins/data-form.js';
import { buildReceivedReceipt, isAckOrReceiptStanza } from './xep-plugins/receipts.js';

export type SendStanzaFn = (stanza: Element) => Promise<void>;
export type SendForAgentFn = (agentJid: string, stanza: Element) => Promise<void>;

export class StanzaRouter {
  constructor(
    private config: GatewayConfig,
    private mailbox: Mailbox,
    private sendForAgent: SendForAgentFn,
  ) {}

  async handleIncoming(stanza: Element): Promise<void> {
    if (stanza.name !== 'message') return;

    const toBare = (stanza.attrs.to as string)?.split('/')[0] || '';
    // Stanzas arrive on the component JID; resolve which registered agent they target.
    const agentJid = resolveTargetAgentJid(toBare, this.config.agentDomain, this.config.defaultAgentJid);

    if (!isAgentJid(agentJid, this.config.agentDomain) && agentJid !== this.config.defaultAgentJid) {
      return;
    }

    const from = stanza.attrs.from as string;
    const fromBare = from.split('/')[0];
    const agentBare = agentJid.split('/')[0];
    // C2S inbox receives agent self-sent stanzas (outbound loopback) — drop them.
    if (fromBare && agentBare && fromBare === agentBare) return;
    if (isAckOrReceiptStanza(stanza)) return;

    const formSubmit = parseAskQuestionSubmit(stanza);
    if (formSubmit) {
      const type = (stanza.attrs.type as string) || 'chat';
      await pushFormResponseToBridge(this.config, {
        agentJid,
        from,
        stanzaType: type,
        questionId: formSubmit.questionId,
        selectedIndex: formSubmit.selectedIndex,
      });
      return;
    }

    const agentMsg = stanzaToAgentMessage(stanza, this.config.agentDomain);
    if (!agentMsg) return;

    const type = (stanza.attrs.type as string) || 'chat';
    const agentNick = agentJid.split('@')[0];
    const bodyText = typeof agentMsg.body === 'string' ? agentMsg.body : JSON.stringify(agentMsg.body);

    if (!shouldAcceptStanza(type, from, bodyText, agentNick)) return;

    const stanzaId = agentMsg.id;
    const { id: deliveryId, isDuplicate, redelivered } = this.mailbox.enqueue(
      stanzaId,
      agentJid,
      JSON.stringify(agentMsg),
    );

    if (isDuplicate && !redelivered) return;
    // Duplicate without redelivery flag: already bridged; skip unless host asked for retry.
    if (isDuplicate && redelivered) this.mailbox.markRedelivered(stanzaId);

    const ctx: InboundDeliveryContext = {
      agentMsg,
      agentJid,
      deliveryId,
      stanzaType: type,
      from,
      redelivered: isDuplicate && redelivered,
    };

    void sendComposingForAgent(
      (stanza) => this.sendForAgent(agentJid, stanza),
      agentJid,
      resolveInboundChatTargets(from, type, agentMsg),
    ).catch((err) => {
      console.error('[xmpp-gateway] composing notification send failed:', err);
    });

    await pushInboundToBridge(this.config, this.mailbox, ctx);

    if (from) {
      await this.sendForAgent(agentJid, buildReceivedReceipt(from, agentJid, stanzaId)).catch((err) => {
        console.error('[xmpp-gateway] received receipt send failed:', err);
      });
    }
  }

  async redeliverRow(row: { id: string; stanzaId: string; agentJid: string; payload: string }): Promise<void> {
    const agentMsg = JSON.parse(row.payload) as AgentMessage;
    this.mailbox.markRedelivered(row.stanzaId);
    await pushInboundToBridge(this.config, this.mailbox, {
      agentMsg,
      agentJid: row.agentJid,
      deliveryId: row.id,
      stanzaType: agentMsg.roomId ? 'groupchat' : 'chat',
      from: agentMsg.from,
      redelivered: true,
    });
  }

  async sweepPending(): Promise<void> {
    for (const row of this.mailbox.listForRedelivery()) {
      await this.redeliverRow(row).catch((err) => {
        console.error('[xmpp-gateway] redelivery failed:', row.stanzaId, err);
      });
    }
  }
}
