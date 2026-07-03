/** XEP-0114 Component, XEP-0355 Namespace Delegation hooks */

import type { GatewayConfig } from '../config.js';

export function delegatedNamespaces(config: GatewayConfig): string[] {
  return [
    'urn:xmpp:json-msg:0',
    'urn:xmpp:agent-event:0',
    `agents.${config.agentDomain}`,
  ];
}

export function componentIdentity(config: GatewayConfig): { name: string; category: string; type: string } {
  return {
    name: 'agent-xmpp-gateway',
    category: 'gateway',
    type: 'component',
  };
}
