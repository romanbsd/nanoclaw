import type { Element } from '@xmpp/xml';

import type { AgentMessage } from '@agent-xmpp/protocol';

import type { GatewayConfig } from './config.js';
import { pushInboundToBridge, shouldAcceptStanza, type InboundDeliveryContext } from './delivery.js';
import { Mailbox } from './mailbox.js';
import {
  isAgentJid,
  resolveTargetAgentJid,
  stanzaToAgentMessage,
} from './xep-plugins/message.js';
import { buildReceivedReceipt } from './xep-plugins/receipts.js';

export type SendStanzaFn = (stanza: Element) => Promise<void>;

export class StanzaRouter {
  constructor(
    private config: GatewayConfig,
    private mailbox: Mailbox,
    private send: SendStanzaFn,
  ) {}

  async handleIncoming(stanza: Element): Promise<void> {
    if (stanza.name !== 'message') return;

    const toBare = (stanza.attrs.to as string)?.split('/')[0] || '';
    const agentJid = resolveTargetAgentJid(toBare, this.config.agentDomain, this.config.defaultAgentJid);

    if (!isAgentJid(agentJid, this.config.agentDomain) && agentJid !== this.config.defaultAgentJid) {
      return;
    }

    const agentMsg = stanzaToAgentMessage(stanza, this.config.agentDomain);
    if (!agentMsg) return;

    const from = stanza.attrs.from as string;
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
    if (isDuplicate && redelivered) this.mailbox.markRedelivered(stanzaId);

    const ctx: InboundDeliveryContext = {
      agentMsg,
      agentJid,
      deliveryId,
      stanzaType: type,
      from,
      redelivered: isDuplicate && redelivered,
    };

    await pushInboundToBridge(this.config, this.mailbox, ctx);

    if (from) {
      await this.send(buildReceivedReceipt(from, agentJid, stanzaId)).catch(() => undefined);
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
