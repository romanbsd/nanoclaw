#!/usr/bin/env tsx
/**
 * End-to-end XMPP ping test (subset of API surface).
 */
import { bridgeState } from './mock-bridge.js';
import { startE2eStack, stopE2eStack } from './e2e-stack.js';
import { runPingTest } from './ping-client.js';

async function main(): Promise<void> {
  const stack = await startE2eStack();
  try {
    const config = stack.config;
    process.env.XMPP_DOMAIN = config.xmppDomain;
    process.env.XMPP_SERVICE = config.xmppService;
    process.env.XMPP_PINGER_JID = config.pingerJid;
    process.env.XMPP_GATEWAY_JID = config.gatewayJid;

    console.log('[e2e] running ping client...');
    await runPingTest();

    const state = bridgeState();
    if (!state.pingSeen || !state.pongSent) {
      throw new Error(`mock bridge state invalid: ${JSON.stringify(state)}`);
    }
    console.log('[e2e] success');
  } finally {
    await stopE2eStack(stack);
  }
}

main().catch((err) => {
  console.error('[e2e] failed:', err);
  process.exit(1);
});
