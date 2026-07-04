import { describe, expect, it } from 'vitest';
import { xml } from '@xmpp/xml';

import { A2A_AGENTCARD_PEP_NODE, A2A_XMPP_BINDING_URI, buildA2aAgentCard } from '@agent-xmpp/protocol';

import type { GatewayConfig } from '../config.js';
import { buildAgentDiscoResponse, handleBindingIq } from './a2a-binding.js';
import { AgentRegistry } from './discovery.js';

const config: GatewayConfig = {
  gatewayId: 'gw-test',
  componentJid: 'gateway.agents.test',
  agentDomain: 'agents.test',
  componentService: 'xmpp://127.0.0.1:5275',
  componentSecret: 'secret',
  httpHost: '127.0.0.1',
  httpPort: 9220,
  bridgeWebhookUrl: 'http://127.0.0.1:9221/inbound',
  bridgeWebhookSecret: 'dev',
  dataDir: '/tmp/xmpp-gw-test',
  defaultAgentJid: 'bot@agents.test',
};

describe('a2a binding IQ handling', () => {
  it('returns agent disco with A2A binding feature', () => {
    const card = buildA2aAgentCard({ jid: 'bot@agents.test', name: 'Bot' });
    const iq = buildAgentDiscoResponse('bot@agents.test', 'client@test', 'iq-1', card);
    expect(iq.attrs.type).toBe('result');
    const features = (iq.getChild('query')!.children as Array<{ name: string; attrs: { var?: string } }>)
      .filter((c) => c.name === 'feature')
      .map((c) => c.attrs.var);
    expect(features).toContain(A2A_XMPP_BINDING_URI);
  });

  it('handles PEP agent card fetch', () => {
    const registry = new AgentRegistry();
    const card = buildA2aAgentCard({ jid: 'bot@agents.test' });
    registry.register({ jid: 'bot@agents.test', capabilities: [], agentCard: card });

    const request = xml(
      'iq',
      { type: 'get', from: 'client@test', to: 'bot@agents.test', id: 'pep-1' },
      xml(
        'pubsub',
        { xmlns: 'http://jabber.org/protocol/pubsub' },
        xml('items', { node: A2A_AGENTCARD_PEP_NODE }),
      ),
    );

    const response = handleBindingIq(request, config, registry);
    expect(response?.attrs.type).toBe('result');
    const agentcard = response?.getChild('pubsub')?.getChild('items')?.getChild('item')?.getChild('agentcard');
    expect(agentcard).toBeDefined();
    const jsonText = (agentcard!.children as unknown[]).find((c) => typeof c === 'string') as string;
    const parsed = JSON.parse(jsonText) as { supportedInterfaces: Array<{ url: string }> };
    expect(parsed.supportedInterfaces[0].url).toBe('xmpp:bot@agents.test');
  });
});
