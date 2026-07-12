/** XMPP channel plugin backed directly by NanoClaw session mailboxes. */
import { EmbeddedXmppGateway, loadConfig, type GatewayRuntimeMailbox } from '@agent-xmpp/gateway';
import {
  isBridgeFormResponsePayload,
  nanoclawInboundFromBridge,
  type BridgeFormResponsePayload,
  type BridgeInboundPayload,
} from '@agent-xmpp/protocol';

import { getAskQuestionRender } from '../db/sessions.js';
import { getAgentGroup, getAgentGroupByXmppJid } from '../db/agent-groups.js';
import { getOrchestratorAgentByGroupId } from '../db/orchestrator-agents.js';
import { log } from '../log.js';
import { XmppAgentGatewayStore } from '../modules/xmpp-agent-gateway/store.js';
import { XmppAgentGatewayService } from '../modules/xmpp-agent-gateway/service.js';
import { resolveAskQuestionSelection } from './ask-question.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { createXmppAgentIqHandler } from './xmpp-agent-iq.js';

function createAdapter(): ChannelAdapter | null {
  if (!process.env.XMPP_COMPONENT_JID || !process.env.XMPP_COMPONENT_SECRET) return null;

  let gateway: EmbeddedXmppGateway | null = null;
  let setup: ChannelSetup | null = null;
  const store = new XmppAgentGatewayStore();
  const taskService = new XmppAgentGatewayService(store);
  const gatewayConfig = loadConfig();

  function tenantForSender(sender: string): string {
    const group = getAgentGroupByXmppJid(sender.split('/')[0] ?? sender);
    return group ? (getOrchestratorAgentByGroupId(group.id)?.tenant_id ?? 'default') : 'default';
  }

  const handleIq = createXmppAgentIqHandler({ componentJid: gatewayConfig.componentJid, tenantForSender, store });

  const mailbox: GatewayRuntimeMailbox = {
    async deliverInbound(payload: BridgeInboundPayload) {
      if (!setup) throw new Error('XMPP adapter is not initialized');
      const inbound = nanoclawInboundFromBridge(payload);
      await setup.onInboundEvent({
        channelType: 'xmpp',
        instance: payload.agentJid,
        platformId: payload.platformId,
        threadId: payload.threadId,
        message: {
          id: inbound.id,
          kind: inbound.kind,
          content: JSON.stringify(inbound.content),
          timestamp: inbound.timestamp,
          isMention: inbound.isMention ?? true,
          isGroup: inbound.isGroup,
        },
      });
    },

    async deliverFormResponse(payload: BridgeFormResponsePayload) {
      if (!setup || !gateway || !isBridgeFormResponsePayload(payload)) return;
      const render = getAskQuestionRender(payload.questionId);
      const selectedOption = resolveAskQuestionSelection(render, payload.selectedIndex);
      const selectedLabel = render?.options[payload.selectedIndex]?.selectedLabel ?? selectedOption;
      await gateway.deliver({
        from: payload.agentJid,
        to: payload.platformId,
        threadId: payload.threadId ?? undefined,
        content: `${render?.title ?? 'Question'}\n\n${selectedLabel}`,
      });
      setup.onAction(payload.questionId, selectedOption, payload.userId);
    },

    async deliverTaskInvocation(task) {
      await taskService.acceptRemoteInvocation(task);
    },

    async deliverTaskEvent(event) {
      await taskService.acceptRemoteEvent(event);
    },
  };

  return {
    name: 'XMPP',
    channelType: 'xmpp',
    supportsThreads: true,

    async setup(channelSetup) {
      setup = channelSetup;
      gateway = new EmbeddedXmppGateway(gatewayConfig, mailbox, handleIq);
      await gateway.start();
      log.info('Embedded XMPP gateway started');
    },

    async teardown() {
      const running = gateway;
      gateway = null;
      setup = null;
      if (running) await running.stop();
    },

    isConnected() {
      return gateway?.isConnected() === true;
    },

    async setTyping(platformId, threadId, senderIdentity) {
      if (gateway && senderIdentity) await gateway.setTyping(senderIdentity, platformId, threadId, 'composing');
    },

    async clearTyping(platformId, threadId, senderIdentity) {
      if (gateway && senderIdentity) await gateway.setTyping(senderIdentity, platformId, threadId, 'paused');
    },

    resolveSenderIdentity(agentGroupId) {
      return getAgentGroup(agentGroupId)?.xmpp_jid ?? undefined;
    },

    async deliver(platformId, threadId, message: OutboundMessage, options) {
      if (!gateway) throw new Error('XMPP gateway is not connected');
      const from = options?.senderIdentity || process.env.XMPP_DEFAULT_AGENT_JID;
      if (!from) throw new Error('XMPP delivery requires an agent JID');
      const content =
        typeof message.content === 'string'
          ? message.content
          : ((message.content as { text?: string })?.text ?? message.content);
      if (content && typeof content === 'object' && 'agentTask' in content) {
        return gateway.deliverTask(
          (content as { agentTask: import('@agent-xmpp/protocol').AgentTaskRecord }).agentTask,
        );
      }
      if (content && typeof content === 'object' && 'agentTaskEvent' in content) {
        return gateway.deliverTaskEvent(
          (content as { agentTaskEvent: import('@agent-xmpp/gateway').TaskWireEvent }).agentTaskEvent,
        );
      }
      return gateway.deliver({
        from,
        to: platformId,
        threadId: threadId ?? undefined,
        content,
        files: message.files?.map((file) => ({
          filename: file.filename,
          dataBase64: file.data.toString('base64'),
          mediaType: 'application/octet-stream',
        })),
      });
    },

    async resolveChannelName(platformId) {
      return platformId.split('@')[0] || platformId;
    },
  };
}

registerChannelAdapter('xmpp', { factory: createAdapter });
