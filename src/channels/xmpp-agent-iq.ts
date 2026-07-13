/**
 * Production IQ handler: routes incoming <iq> to the right responder by payload.
 *   XEP-0199 ping           -> pong
 *   XEP-0030 disco#info/items -> gateway/agent/operation discovery (agent-api-disco.ts)
 *   XEP-0054 vCard-temp get  -> public agent identity
 *   urn:businessos:agent-api:1 schema/registration -> gateway-private agent API
 * Disco and API metadata are tenant-scoped; the vCard identity is public.
 *
 * @see https://xmpp.org/extensions/xep-0030.html
 * @see https://xmpp.org/extensions/xep-0199.html
 * @see https://xmpp.org/extensions/xep-0054.html
 */
import {
  AGENT_API_NS,
  AGENT_DIRECTORY_NS,
  DISCO_INFO_NS,
  DISCO_ITEMS_NS,
  MCP_ENDPOINT_NS,
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

import { XmppAgentGatewayStore } from '../modules/xmpp-agent-gateway/store.js';

export interface XmppAgentIqOptions {
  componentJid: string;
  tenantForSender(senderJid: string): string;
  store?: XmppAgentGatewayStore;
}

/** Build the production IQ handler used by both the channel and live integration tests. */
export function createXmppAgentIqHandler(options: XmppAgentIqOptions): (stanza: Element) => Element | null {
  const store = options.store ?? new XmppAgentGatewayStore();
  return (stanza) => {
    const from = String(stanza.attrs.from ?? '');
    const to = String(stanza.attrs.to ?? '').split('/')[0] ?? '';
    const info = stanza.getChild('query', DISCO_INFO_NS);
    const items = stanza.getChild('query', DISCO_ITEMS_NS);
    const schema = stanza.getChild('schema', AGENT_API_NS);
    const vcard = stanza.getChild('vCard', VCARD_TEMP_NS);
    const tenant = options.tenantForSender(from);

    if (isPingRequest(stanza) && (to === options.componentJid || store.getAgent(to))) {
      return buildPingResponse(stanza);
    }
    const registration = parseManifestRegistration(stanza);
    if (registration) {
      const sender = from.split('/')[0] ?? from;
      if (registration.agent.jid !== sender) return null;
      return buildManifestRegistrationResult(stanza, store.registerManifest(registration, tenant));
    }
    if (info && to === options.componentJid) return buildGatewayInfo(stanza, options.componentJid);
    if (items?.attrs.node === AGENT_DIRECTORY_NS && to === options.componentJid) {
      return buildAgentDirectory(stanza, options.componentJid, store.listAgents(tenant));
    }
    const agent = store.getAgent(to);
    if (!agent) return null;
    // XEP-0054 identity is public like ordinary roster vCards; API discovery
    // and invocation metadata remain tenant-scoped below.
    if (vcard && stanza.attrs.type === 'get') return buildAgentVcard(stanza, agent);
    if (agent.tenantId !== tenant) return null;
    if (info && (!info.attrs.node || info.attrs.node === MCP_ENDPOINT_NS)) return buildAgentInfo(stanza, agent);
    if (items?.attrs.node === AGENT_API_NS) return buildOperationItems(stanza, agent);
    if (info?.attrs.node) {
      const operation = agent.operations.find((item) => item.name === operationFromNode(String(info.attrs.node)));
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
  };
}
