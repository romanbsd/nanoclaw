/**
 * Ensure the default E2E agent exists on Openfire and has a gateway C2S inbox.
 */
import { spawn } from 'node:child_process';

import type { E2eStackConfig } from './e2e-stack.js';

const REST_SECRET = process.env.OPENFIRE_REST_SECRET || 'e2e-rest-secret';
const AGENT_PASS = process.env.E2E_AGENT_PASSWORD || 'secret';

function runCurl(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
  });
}

async function openfireUserExists(config: E2eStackConfig, username: string): Promise<boolean> {
  const { code, stdout } = await runCurl([
    '-s',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    '-H',
    `Authorization: ${REST_SECRET}`,
    `${config.openfireUrl}/plugins/restapi/v1/users/${encodeURIComponent(username)}`,
  ]);
  return code === 0 && stdout.trim() === '200';
}

async function createOpenfireUser(config: E2eStackConfig, username: string, password: string): Promise<void> {
  const body = JSON.stringify({
    username,
    name: 'E2E Assistant',
    email: `${username}@${config.xmppDomain}`,
    password,
  });
  const { code, stdout } = await runCurl([
    '-s',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    '-X',
    'POST',
    `${config.openfireUrl}/plugins/restapi/v1/users`,
    '-H',
    `Authorization: ${REST_SECRET}`,
    '-H',
    'Content-Type: application/json',
    '-d',
    body,
  ]);
  const status = stdout.trim();
  if (code !== 0 || (status !== '201' && status !== '200' && status !== '409')) {
    throw new Error(`create user ${username} failed: HTTP ${status}`);
  }
}

export async function registerAgentInbox(
  gatewayUrl: string,
  jid: string,
  password: string,
): Promise<void> {
  const res = await fetch(`${gatewayUrl.replace(/\/$/, '')}/v1/agents/register_inbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jid, password }),
  });
  if (!res.ok) {
    throw new Error(`register_inbox failed for ${jid}: ${res.status} ${await res.text()}`);
  }
}

export async function unregisterAgentInbox(gatewayUrl: string, jid: string): Promise<void> {
  const res = await fetch(`${gatewayUrl.replace(/\/$/, '')}/v1/agents/unregister`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jid }),
  });
  if (!res.ok) {
    throw new Error(`unregister failed for ${jid}: ${res.status} ${await res.text()}`);
  }
}

/** Idempotent: Openfire user + gateway C2S session for the default E2E agent. */
export async function ensureDefaultAgentInbox(config: E2eStackConfig, gatewayUrl: string): Promise<void> {
  const username = config.agentJid.split('@')[0];
  if (!username) throw new Error(`invalid agent JID: ${config.agentJid}`);

  if (!(await openfireUserExists(config, username))) {
    await createOpenfireUser(config, username, AGENT_PASS);
    console.log(`[e2e] created Openfire user ${config.agentJid}`);
  }

  await registerAgentInbox(gatewayUrl, config.agentJid, AGENT_PASS);
  console.log(`[e2e] C2S inbox registered for ${config.agentJid}`);
}

export { AGENT_PASS as e2eAgentPassword };
