#!/usr/bin/env tsx
/**
 * Tier 2 C2S migration: human DM outbound via agent C2S (not component).
 *
 * Proves assistant → john delivers over C2S after register_inbox, with no
 * spurious agent loopback to john@ on the bridge.
 */
import { GatewayClient } from './gateway-client.js';
import { ensureDefaultAgentInbox } from './e2e-agent-setup.js';
import { e2eConfig, startE2eStack, stopE2eStack } from './e2e-stack.js';
import { bridgeState } from './mock-bridge.js';
import { XmppSession } from './xmpp-session.js';

async function main(): Promise<void> {
  const config = e2eConfig();
  process.env.XMPP_DOMAIN = config.xmppDomain;
  process.env.XMPP_SERVICE = config.xmppService;
  process.env.XMPP_PINGER_JID = config.pingerJid;
  process.env.XMPP_GATEWAY_JID = config.gatewayJid;
  process.env.XMPP_DEFAULT_AGENT_JID = config.agentJid;

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

    const deliverText = 'tier2-human-dm-c2s-deliver';
    const beforeBridge = bridgeState().inboundCount;
    const deliverWait = john.waitForBody(deliverText);
    const { status: dStatus, json: dJson } = await api.deliver({
      from: stack.config.agentJid,
      to: stack.config.pingerJid,
      content: deliverText,
    });
    if (dStatus !== 200 || !dJson.messageId) throw new Error(`deliver failed: ${dStatus}`);
    await deliverWait;
    if (bridgeState().inboundCount !== beforeBridge) {
      throw new Error('human DM triggered bridge inbound (spurious agent loopback)');
    }
    console.log('[e2e-c2s-tier2] outbound/deliver to human via C2S ok');

    const sendText = 'tier2-human-dm-c2s-send_message';
    const sendWait = john.waitForBody(sendText);
    const { status: sStatus, json: sJson } = await api.sendMessage({
      from: stack.config.agentJid,
      to: stack.config.pingerJid,
      kind: 'text',
      contentType: 'text/plain',
      body: sendText,
    });
    if (sStatus !== 200 || !sJson.messageId) throw new Error(`send_message failed: ${sStatus}`);
    await sendWait;
    console.log('[e2e-c2s-tier2] xmpp.send_message to human via C2S ok');

    // Without C2S inbox, outbound still works via component (legacy fallback).
    await api.unregisterAgent(stack.config.agentJid);
    const fallbackText = 'tier2-human-dm-component-fallback';
    const fallbackWait = john.waitForBody(fallbackText);
    const { status: fStatus } = await api.deliver({
      from: stack.config.agentJid,
      to: stack.config.pingerJid,
      content: fallbackText,
    });
    if (fStatus !== 200) throw new Error(`component fallback deliver failed: ${fStatus}`);
    await fallbackWait;
    console.log('[e2e-c2s-tier2] component fallback without inbox ok');

    console.log('[e2e-c2s-tier2] PASS');
  } finally {
    await john?.stop().catch(() => undefined);
    if (stack) await stopE2eStack(stack);
  }
}

main().catch((err) => {
  console.error('[e2e-c2s-tier2] FAIL:', err);
  process.exit(1);
});
