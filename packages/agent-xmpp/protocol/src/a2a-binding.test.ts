import { describe, expect, it } from 'vitest';

import {
  A2A_XMPP_BINDING_URI,
  A2A_XMPP_PROTOCOL_VERSION,
  agentCardFromDescriptor,
  buildA2aAgentCard,
  buildA2aAgentInterface,
  registrationFromDescriptor,
  xmppAgentUrl,
} from './a2a-binding.js';

describe('a2a binding identification', () => {
  it('builds xmpp agent interface URL', () => {
    const iface = buildA2aAgentInterface('researcher@agents.example', 'acme');
    expect(iface.url).toBe('xmpp:researcher@agents.example');
    expect(iface.protocolBinding).toBe(A2A_XMPP_BINDING_URI);
    expect(iface.protocolVersion).toBe(A2A_XMPP_PROTOCOL_VERSION);
    expect(iface.tenant).toBe('acme');
  });

  it('builds agent card with supportedInterfaces', () => {
    const card = buildA2aAgentCard({
      jid: 'researcher@agents.example',
      name: 'Research Agent',
      description: 'Summarizes documents',
      tenantId: 'acme',
    });
    expect(card.supportedInterfaces).toHaveLength(1);
    expect(card.supportedInterfaces[0].url).toBe(xmppAgentUrl('researcher@agents.example'));
    expect(card.capabilities.streaming).toBe(true);
    expect(card.skills.length).toBeGreaterThan(0);
  });

  it('builds agent card from runtime descriptor', () => {
    const card = agentCardFromDescriptor({
      jid: 'sec@agents.test',
      tenantId: 'acme',
      tools: [{ name: 'xmpp.send_message', description: 'Send XMPP', inputSchema: { type: 'object' } }],
      model: 'claude-sonnet',
      provider: 'claude',
      softwareVersion: '1.0.0',
      health: 'healthy',
      availability: 'idle',
      supportedProtocols: [A2A_XMPP_BINDING_URI],
      publishedAt: new Date().toISOString(),
    });
    expect(card.supportedInterfaces[0].tenant).toBe('acme');
    expect(card.skills.some((s) => s.id === 'xmpp.send_message')).toBe(true);
  });

  it('builds registry entry from runtime descriptor', () => {
    const { agent, agentCard } = registrationFromDescriptor({
      jid: 'bot@agents.test',
      tools: [{ name: 'xmpp.reply', inputSchema: { type: 'object' } }],
      model: 'claude-sonnet',
      provider: 'claude',
      softwareVersion: '1.0.0',
      health: 'healthy',
      availability: 'idle',
      supportedProtocols: [],
      publishedAt: new Date().toISOString(),
    });
    expect(agent.agentCard).toBe(agentCard);
    expect(agent.capabilities).toContain(A2A_XMPP_BINDING_URI);
    expect(agent.capabilities).toContain('xmpp.reply');
  });
});
