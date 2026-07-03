/**
 * XMPP pairing step — registers first inbound JID after user sends pairing code.
 *
 * Usage: pnpm exec tsx setup/index.ts --step pair-xmpp
 */
import crypto from 'crypto';

import { log } from '../src/log.js';
import { emitStatus } from './status.js';

const CODE_TTL_MS = 10 * 60 * 1000;

function generateCode(): string {
  return crypto.randomInt(1000, 9999).toString();
}

export async function run(_args: string[]): Promise<void> {
  const code = generateCode();
  const agentJid = process.env.XMPP_DEFAULT_AGENT_JID || 'assistant@agents.example';

  console.log(`=== NANOCLAW SETUP: PAIR_XMPP_CODE ===`);
  console.log(`CODE: ${code}`);
  console.log(`AGENT_JID: ${agentJid}`);
  console.log(`INSTRUCTION: Send this code as an XMPP message to ${agentJid}`);
  console.log(`=== END ===`);

  const deadline = Date.now() + CODE_TTL_MS;
  log.info('Waiting for XMPP pairing message', { code, agentJid, deadline });

  // Pairing completion is handled by xmpp-bridge intercept in a future
  // enhancement; for MVP operators register via /manage-channels after first DM.
  emitStatus('PAIR_XMPP', {
    STATUS: 'pending',
    CODE: code,
    AGENT_JID: agentJid,
    NOTE: 'Send code via XMPP, then run /manage-channels to wire the messaging group',
  });
}