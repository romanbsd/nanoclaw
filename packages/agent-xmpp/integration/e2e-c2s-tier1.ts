#!/usr/bin/env tsx
/**
 * Tier 1 C2S migration: presence, publish_descriptor, publish_event, unregister.
 *
 * Requires Openfire + gateway (docker compose). Proves agent-scoped stanzas
 * go through C2S after register_inbox (strict — no component fallback).
 */
import { GatewayClient } from './gateway-client.js';
import { ensureDefaultAgentInbox, registerAgentInbox, unregisterAgentInbox, e2eAgentPassword } from './e2e-agent-setup.js';
import { e2eConfig, startE2eStack, stopE2eStack } from './e2e-stack.js';
import { XmppSession } from './xmpp-session.js';

async function main(): Promise<void> {
  const config = e2eConfig();
  process.env.XMPP_DOMAIN = config.xmppDomain;
  process.env.XMPP_SERVICE = config.xmppService;
  process.env.XMPP_PINGER_JID = config.pingerJid;
  process.env.XMPP_GATEWAY_JID = config.gatewayJid;

  let stack: Awaited<ReturnType<typeof startE2eStack>> | null = null;
  let john: XmppSession | null = null;

  try {
    stack = await startE2eStack();
    const api = new GatewayClient(stack.config.gatewayUrl);
    await ensureDefaultAgentInbox(stack.config, stack.config.gatewayUrl);

    john = new XmppSession({
      service: stack.config.xmppService,
      domain: stack.config.xmppDomain,
      username: stack.config.pingerJid.split('@')[0],
      password: process.env.XMPP_PINGER_PASS || 'secret',
    });
    await john.start();
    // Probe so Openfire may route agent presence updates toward john.
    await john.sendChat(stack.config.agentJid, 'tier1-probe');

    // set_presence without inbox must fail (proves strict C2S gate).
    await unregisterAgentInbox(stack.config.gatewayUrl, stack.config.agentJid);
    const blocked = await api.setPresence({ from: stack.config.agentJid, status: 'available', message: 'nope' });
    if (blocked.status === 200) {
      throw new Error('set_presence succeeded without C2S session — expected failure');
    }
    await registerAgentInbox(stack.config.gatewayUrl, stack.config.agentJid, e2eAgentPassword);

    const { status: psStatus, json: psJson } = await api.setPresence({
      from: stack.config.agentJid,
      status: 'available',
      message: 'tier1-c2s-presence',
    });
    if (psStatus !== 200 || !psJson.ok) throw new Error(`set_presence failed: ${psStatus}`);
    console.log('[e2e-c2s-tier1] set_presence via C2S ok');

    const { status: pubStatus } = await api.publishDescriptor({
      jid: stack.config.agentJid,
      tenantId: stack.config.xmppDomain,
      tools: [{ name: 'send_message', description: 'Send', inputSchema: { type: 'object' } }],
      model: 'test',
      provider: 'claude',
      softwareVersion: '2.0.0',
      health: 'healthy',
      availability: 'idle',
      supportedProtocols: ['xmpp'],
      publishedAt: new Date().toISOString(),
    });
    if (pubStatus !== 200) throw new Error(`publish_descriptor failed: ${pubStatus}`);
    const { status: dStatus, json: dJson } = await api.discoverAgents({ capabilities: ['send_message'] });
    if (dStatus !== 200 || !dJson.agents.some((a) => a.jid === stack!.config.agentJid)) {
      throw new Error('publish_descriptor agent not discoverable');
    }
    console.log('[e2e-c2s-tier1] publish_descriptor via C2S ok');

    const { status: evStatus, json: evJson } = await api.publishEvent({
      from: stack.config.agentJid,
      node: `tier1-test/${stack.config.agentJid.replace('@', '/')}`,
      id: `tier1-${Date.now()}`,
      body: { event: 'tier1-c2s' },
    });
    if (evStatus !== 200 || !evJson.ok) throw new Error(`publish_event failed: ${evStatus}`);
    console.log('[e2e-c2s-tier1] publish_event via C2S ok');

    const { status: unStatus } = await api.unregisterAgent(stack.config.agentJid);
    if (unStatus !== 200) throw new Error(`unregister failed: ${unStatus}`);
    console.log('[e2e-c2s-tier1] unregister via C2S ok');

    // Re-register for any follow-on tests in the same stack.
    await registerAgentInbox(stack.config.gatewayUrl, stack.config.agentJid, e2eAgentPassword);

    console.log('[e2e-c2s-tier1] PASS');
  } finally {
    await john?.stop().catch(() => undefined);
    if (stack) await stopE2eStack(stack);
  }
}

main().catch((err) => {
  console.error('[e2e-c2s-tier1] FAIL:', err);
  process.exit(1);
});
