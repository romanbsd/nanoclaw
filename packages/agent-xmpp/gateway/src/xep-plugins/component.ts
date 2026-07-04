/** XEP-0114 Component, XEP-0355 Namespace Delegation hooks */

import { A2A_AGENTCARD_PEP_NODE, A2A_NS } from '@agent-xmpp/protocol';

import type { GatewayConfig } from '../config.js';

export function delegatedNamespaces(config: GatewayConfig): string[] {
  return [
    A2A_NS,
    A2A_AGENTCARD_PEP_NODE,
    'urn:xmpp:json-msg:0',
    'urn:xmpp:agent-event:0',
    `agents.${config.agentDomain}`,
  ];
}

export function componentIdentity(_config: GatewayConfig): { name: string; category: string; type: string } {
  return {
    name: 'agent-xmpp-gateway',
    category: 'gateway',
    type: 'component',
  };
}
