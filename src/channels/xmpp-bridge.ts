/** XMPP channel plugin backed directly by NanoClaw session mailboxes. */
import {
  AGENT_API_NS,
  AGENT_DIRECTORY_NS,
  DISCO_INFO_NS,
  DISCO_ITEMS_NS,
  MCP_ENDPOINT_NS,
  EmbeddedXmppGateway,
  buildAgentDirectory,
  buildAgentInfo,
  buildGatewayInfo,
  buildManifestRegistrationResult,
  buildOperationInfo,
  buildOperationItems,
  buildSchemaResult,
  buildPingResponse,
  isPingRequest,
  loadConfig,
  operationFromNode,
  parseManifestRegistration,
  type Element,
  type GatewayRuntimeMailbox,
} from '@agent-xmpp/gateway';
import {
  isBridgeFormResponsePayload,
  nanoclawInboundFromBridge,
  type BridgeFormResponsePayload,
  type BridgeInboundPayload,
} from '@agent-xmpp/protocol';

import { getAskQuestionRender } from '../db/sessions.js';
import { getAgentGroupByXmppJid } from '../db/agent-groups.js';
import { getOrchestratorAgentByGroupId } from '../db/orchestrator-agents.js';
import { log } from '../log.js';
import { XmppAgentGatewayStore } from '../modules/xmpp-agent-gateway/store.js';
import { resolveAskQuestionSelection } from './ask-question.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

function createAdapter(): ChannelAdapter | null {
  if (!process.env.XMPP_COMPONENT_JID || !process.env.XMPP_COMPONENT_SECRET) return null;

  let gateway: EmbeddedXmppGateway | null = null;
  let setup: ChannelSetup | null = null;
  const store = new XmppAgentGatewayStore();
  const gatewayConfig = loadConfig();

  function tenantForSender(sender: string): string {
    const group = getAgentGroupByXmppJid(sender.split('/')[0] ?? sender);
    return group ? (getOrchestratorAgentByGroupId(group.id)?.tenant_id ?? 'default') : 'default';
  }

  function handleIq(stanza: Element): Element | null {
    const from = String(stanza.attrs.from ?? '');
    const to = String(stanza.attrs.to ?? '').split('/')[0] ?? '';
    const info = stanza.getChild('query', DISCO_INFO_NS);
    const items = stanza.getChild('query', DISCO_ITEMS_NS);
    const schema = stanza.getChild('schema', AGENT_API_NS);
    const tenant = tenantForSender(from);
    if (isPingRequest(stanza) && (to === gatewayConfig.componentJid || store.getAgent(to))) {
      return buildPingResponse(stanza);
    }
    const registration = parseManifestRegistration(stanza);
    if (registration) {
      const sender = from.split('/')[0] ?? from;
      if (registration.agent.jid !== sender) return null;
      return buildManifestRegistrationResult(stanza, store.registerManifest(registration, tenant));
    }
    if (info && to === gatewayConfig.componentJid) return buildGatewayInfo(stanza, gatewayConfig.componentJid);
    if (items?.attrs.node === AGENT_DIRECTORY_NS && to === gatewayConfig.componentJid) {
      return buildAgentDirectory(stanza, gatewayConfig.componentJid, store.listAgents(tenant));
    }
    const agent = store.getAgent(to);
    if (!agent || agent.tenantId !== tenant) return null;
    if (info?.attrs.node === MCP_ENDPOINT_NS) return buildAgentInfo(stanza, agent);
    if (items?.attrs.node === AGENT_API_NS) return buildOperationItems(stanza, agent);
    if (info?.attrs.node) {
      const operationName = operationFromNode(String(info.attrs.node));
      const operation = agent.operations.find((item) => item.name === operationName);
      if (operation) return buildOperationInfo(stanza, agent, operation);
    }
    if (schema) {
      const operation = agent.operations.find((item) => item.name === schema.attrs.operation);
      const direction = schema.attrs.direction;
      if (operation && (direction === 'input' || direction === 'output')) {
        return buildSchemaResult(stanza, agent, operation, direction);
      }
    }
    return null;
  }

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

    async setTyping(platformId, threadId, fromJid) {
      if (gateway && fromJid) await gateway.setTyping(fromJid, platformId, threadId, 'composing');
    },

    async clearTyping(platformId, threadId, fromJid) {
      if (gateway && fromJid) await gateway.setTyping(fromJid, platformId, threadId, 'paused');
    },

    async deliver(platformId, threadId, message: OutboundMessage, options) {
      if (!gateway) throw new Error('XMPP gateway is not connected');
      const from = options?.fromJid || process.env.XMPP_DEFAULT_AGENT_JID;
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
