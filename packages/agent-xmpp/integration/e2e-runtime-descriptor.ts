/**
 * Phase 2 E2E: publish runtime descriptor via gateway + discover_agents.
 */
import { ensureDefaultAgentInbox } from './e2e-agent-setup.js';
import { startE2eStack, stopE2eStack } from './e2e-stack.js';

async function main(): Promise<void> {
  const stack = await startE2eStack();
  const { config } = stack;

  try {
    await ensureDefaultAgentInbox(config, config.gatewayUrl);

    const descriptor = {
      jid: config.agentJid,
      tenantId: config.xmppDomain,
      tools: [
        {
          name: 'send_message',
          description: 'Send a message',
          inputSchema: { type: 'object', properties: { to: { type: 'string' } } },
        },
      ],
      model: 'claude-sonnet-test',
      provider: 'claude',
      softwareVersion: '2.0.0',
      health: 'healthy' as const,
      availability: 'idle' as const,
      supportedProtocols: ['xmpp', 'mcp', 'mam'],
      publishedAt: new Date().toISOString(),
    };

    const publishRes = await fetch(`${config.gatewayUrl}/v1/agents/publish_descriptor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(descriptor),
    });
    if (!publishRes.ok) {
      throw new Error(`publish_descriptor failed: ${publishRes.status} ${await publishRes.text()}`);
    }

    const discoverRes = await fetch(`${config.gatewayUrl}/v1/tools/xmpp.discover_agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capabilities: ['send_message'] }),
    });
    if (!discoverRes.ok) {
      throw new Error(`discover_agents failed: ${discoverRes.status}`);
    }
    const { agents } = (await discoverRes.json()) as { agents: Array<{ jid: string }> };
    if (!agents.some((a) => a.jid === config.agentJid)) {
      throw new Error(`agent ${config.agentJid} not in discovery results`);
    }

    console.log('[e2e-descriptor] PASS');
  } finally {
    await stopE2eStack(stack);
  }
}

main().catch((err) => {
  console.error('[e2e-descriptor] FAIL:', err);
  process.exit(1);
});
