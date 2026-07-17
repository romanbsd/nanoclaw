/**
 * Production IQ handler: routes incoming <iq> to the right responder by payload.
 *   XEP-0199 ping           -> pong
 *   XEP-0030 disco#info/items -> gateway/agent/operation discovery (agent-api-disco.ts)
 *   XEP-0054 vCard-temp get  -> public agent identity
 *   configured agent-api namespace schema/registration -> gateway-private agent API
 * Disco and API metadata are tenant-scoped; the vCard identity is public.
 *
 * @see https://xmpp.org/extensions/xep-0030.html
 * @see https://xmpp.org/extensions/xep-0199.html
 * @see https://xmpp.org/extensions/xep-0054.html
 */
import {
  DISCO_INFO_NS,
  DISCO_ITEMS_NS,
  buildAgentDirectory,
  buildAgentInfo,
  buildGatewayInfo,
  buildManifestRegistrationResult,
  buildAgentVcard,
  buildOperationInfo,
  buildOperationItems,
  buildPingResponse,
  buildSchemaResult,
  isPingRequest,
  operationFromNode,
  parseManifestRegistration,
  VCARD_TEMP_NS,
  type Element,
} from '@agent-xmpp/gateway';
import { DEFAULT_PROTOCOL_NAMESPACES, bareJid, type AgentXmppNamespaces } from '@agent-xmpp/protocol';

import { XmppAgentGatewayStore } from '../modules/xmpp-agent-gateway/store.js';

export interface XmppAgentIqOptions {
  componentJid: string;
  tenantForSender(senderJid: string): string;
  store?: XmppAgentGatewayStore;
  protocolNamespaces?: AgentXmppNamespaces;
}

/** Build the production IQ handler used by both the channel and live integration tests. */
export function createXmppAgentIqHandler(options: XmppAgentIqOptions): (stanza: Element) => Element | null {
  const namespaces = options.protocolNamespaces ?? DEFAULT_PROTOCOL_NAMESPACES;
  const store = options.store ?? new XmppAgentGatewayStore(namespaces);
  return (stanza) => {
    const from = String(stanza.attrs.from ?? '');
    const to = bareJid(String(stanza.attrs.to ?? ''));
    const info = stanza.getChild('query', DISCO_INFO_NS);
    const items = stanza.getChild('query', DISCO_ITEMS_NS);
    const schema = stanza.getChild('schema', namespaces.api);
    const vcard = stanza.getChild('vCard', VCARD_TEMP_NS);
    const tenant = options.tenantForSender(from);

    if (isPingRequest(stanza) && (to === options.componentJid || store.getAgent(to))) {
      return buildPingResponse(stanza);
    }
    const registration = parseManifestRegistration(stanza, namespaces);
    if (registration) {
      const sender = bareJid(from);
      if (registration.agent.jid !== sender) return null;
      return buildManifestRegistrationResult(stanza, store.registerManifest(registration, tenant), namespaces);
    }
    if (info && to === options.componentJid) return buildGatewayInfo(stanza, options.componentJid, namespaces);
    if (items?.attrs.node === namespaces.directory && to === options.componentJid) {
      return buildAgentDirectory(stanza, options.componentJid, store.listAgents(tenant), namespaces);
    }
    const agent = store.getAgent(to);
    if (!agent) return null;
    // XEP-0054 identity is public like ordinary roster vCards; API discovery
    // and invocation metadata remain tenant-scoped below.
    if (vcard && stanza.attrs.type === 'get') return buildAgentVcard(stanza, agent);
    if (agent.tenantId !== tenant) return null;
    if (info && (!info.attrs.node || info.attrs.node === namespaces.endpoint))
      return buildAgentInfo(stanza, agent, namespaces);
    if (items?.attrs.node === namespaces.api) return buildOperationItems(stanza, agent, namespaces);
    if (info?.attrs.node) {
      const operation = agent.operations.find(
        (item) => item.name === operationFromNode(String(info.attrs.node), namespaces),
      );
      if (operation) return buildOperationInfo(stanza, agent, operation, namespaces);
    }
    if (schema) {
      const operation = agent.operations.find((item) => item.name === schema.attrs.operation);
      const direction = schema.attrs.direction;
      if (operation && (direction === 'input' || direction === 'output')) {
        return buildSchemaResult(stanza, agent, operation, direction, namespaces);
      }
    }
    return null;
  };
}
