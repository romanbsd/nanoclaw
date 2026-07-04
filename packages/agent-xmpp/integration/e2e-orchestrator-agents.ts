#!/usr/bin/env tsx
/**
 * Full orchestrator E2E: provision secretary + accountant, inject mail, verify delegation.
 */
import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { initDb } from '../../../src/db/connection.js';
import { listOrchestratorAgents } from '../../../src/db/orchestrator-agents.js';
import { getSessionsByAgentGroup } from '../../../src/db/sessions.js';
import { injectViaCliSocket } from './cli-inject.js';
import { GatewayClient } from './gateway-client.js';
import { startOrchestratorE2eStack, stopOrchestratorE2eStack } from './e2e-orchestrator-stack.js';
import { REPO_ROOT } from './e2e-stack.js';

const XMPP_MCP = path.join(REPO_ROOT, 'packages/agent-xmpp/mcp/dist/index.js');
const execFileAsync = promisify(execFile);

async function stopNanoclawContainers(): Promise<void> {
  try {
    const { stdout } = await execFileAsync('docker', ['ps', '-q', '--filter', 'name=nanoclaw-v2'], {
      encoding: 'utf8',
    });
    const ids = stdout.trim().split('\n').filter(Boolean);
    if (ids.length > 0) {
      await execFileAsync('docker', ['rm', '-f', ...ids]);
    }
  } catch {
    // Best-effort — containers may already have exited.
  }
}

const MAIL_TEXT =
  'New invoice #INV-42 from Acme Corp for $5,000 — needs accounting review';

async function orchFetch(
  baseUrl: string,
  secret: string,
  pathname: string,
  init?: RequestInit,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers,
  });
}

async function waitFor<T>(label: string, fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 180_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await fn();
    if (hit !== undefined) return hit;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function sessionDbPaths(dataDir: string, agentGroupId: string, sessionId: string): {
  inbound: string;
  outbound: string;
} {
  const base = path.join(dataDir, 'v2-sessions', agentGroupId, sessionId);
  return { inbound: path.join(base, 'inbound.db'), outbound: path.join(base, 'outbound.db') };
}

function sessionHasInboundText(
  dataDir: string,
  agentGroupId: string,
  sessionId: string,
  needle: string,
): boolean {
  const { inbound: dbPath } = sessionDbPaths(dataDir, agentGroupId, sessionId);
  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT content FROM messages_in').all() as Array<{ content: string }>;
    db.close();
    return rows.some((r) => r.content.includes(needle));
  } catch {
    return false;
  }
}

async function openfireUserExists(openfireUrl: string, username: string): Promise<boolean> {
  const restSecret = process.env.OPENFIRE_REST_SECRET || 'e2e-rest-secret';
  const res = await fetch(`${openfireUrl}/plugins/restapi/v1/users/${encodeURIComponent(username)}`, {
    redirect: 'manual',
    headers: { Authorization: restSecret, Accept: 'application/json' },
  });
  if (res.status === 404) return false;
  if (res.status >= 300 && res.status < 400) return false;
  if (!res.ok) return false;
  const text = await res.text();
  return !text.includes('<html');
}

async function wakeAgentViaCli(
  dataDir: string,
  domain: string,
  agentJid: string,
  text: string,
): Promise<void> {
  await injectViaCliSocket(dataDir, {
    text,
    sender: 'e2e-wake',
    senderId: `wake@${domain}`,
    to: {
      channelType: 'xmpp',
      platformId: `wake@${domain}`,
      threadId: null,
      instance: agentJid,
    },
  });
}

async function main(): Promise<void> {
  const stack = await startOrchestratorE2eStack();
  const { config, orchestratorUrl, orchestratorSecret, nanoclawDataDir } = stack;

  process.env.NANCLAW_DATA_DIR = nanoclawDataDir;
  initDb(path.join(nanoclawDataDir, 'v2.db'));

  let accountantJid = '';
  let secretaryJid = '';
  let accountantGroupId = '';
  let secretaryGroupId = '';
  let secretaryOrchId = '';
  let accountantOrchId = '';
  let accountantUsername = '';
  let secretaryUsername = '';

  try {
    const accountantRes = await orchFetch(orchestratorUrl, orchestratorSecret, '/v1/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Accountant',
        agentId: `accountant-${Date.now().toString(36)}`,
        tenantId: config.xmppDomain,
        displayName: 'Accountant',
        personality: { instructions: 'You handle invoices and accounting tasks.', assistantName: 'Accountant' },
        provider: 'mock',
        model: 'mock',
        mockScenario: 'accountant',
        skills: [],
        mcpServers: [{ name: 'xmpp', command: 'node', args: [XMPP_MCP] }],
        groups: ['Agents'],
      }),
    });
    if (!accountantRes.ok) {
      throw new Error(`provision accountant failed: ${accountantRes.status} ${await accountantRes.text()}`);
    }
    const accountant = (await accountantRes.json()) as { id: string; jid: string; agentGroupId: string };
    accountantJid = accountant.jid;
    accountantGroupId = accountant.agentGroupId;
    accountantOrchId = accountant.id;
    accountantUsername = accountant.jid.split('@')[0]!;
    console.log('[e2e-orch] accountant', accountantJid);

    const secretaryRes = await orchFetch(orchestratorUrl, orchestratorSecret, '/v1/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Secretary',
        agentId: `secretary-${Date.now().toString(36)}`,
        tenantId: config.xmppDomain,
        displayName: 'Secretary',
        personality: { instructions: 'You triage incoming mail and delegate accounting work.', assistantName: 'Secretary' },
        provider: 'mock',
        model: 'mock',
        mockScenario: 'secretary',
        skills: [],
        mcpServers: [{ name: 'xmpp', command: 'node', args: [XMPP_MCP] }],
        groups: ['Agents'],
        spawnEnv: { MOCK_ACCOUNTANT_JID: accountantJid },
      }),
    });
    if (!secretaryRes.ok) {
      throw new Error(`provision secretary failed: ${secretaryRes.status} ${await secretaryRes.text()}`);
    }
    const secretary = (await secretaryRes.json()) as { id: string; jid: string; agentGroupId: string };
    secretaryJid = secretary.jid;
    secretaryGroupId = secretary.agentGroupId;
    secretaryOrchId = secretary.id;
    secretaryGroupId = secretary.agentGroupId;
    secretaryOrchId = secretary.id;
    secretaryUsername = secretary.jid.split('@')[0]!;
    console.log('[e2e-orch] secretary', secretaryJid);

    const api = new GatewayClient(config.gatewayUrl);

    console.log('[e2e-orch] waking agents for descriptor publish...');
    await wakeAgentViaCli(stack.nanoclawDataDir, config.xmppDomain, secretaryJid, 'wake');
    await wakeAgentViaCli(stack.nanoclawDataDir, config.xmppDomain, accountantJid, 'wake');

    await waitFor('discover_agents', async () => {
      const { status, json } = await api.discoverAgents({ capabilities: ['send_message'] });
      if (status !== 200) return undefined;
      const agents = (json as { agents?: Array<{ jid: string }> }).agents ?? [];
      const hasBoth =
        agents.some((a) => a.jid === secretaryJid) && agents.some((a) => a.jid === accountantJid);
      return hasBoth ? true : undefined;
    }, 180_000);

    console.log('[e2e-orch] injecting mail to secretary via host CLI...');
    await injectViaCliSocket(stack.nanoclawDataDir, {
      text: MAIL_TEXT,
      sender: 'Mail Bot',
      senderId: `mailbot@${config.xmppDomain}`,
      to: {
        channelType: 'xmpp',
        platformId: `mailbot@${config.xmppDomain}`,
        threadId: null,
        instance: secretaryJid,
      },
    });

    console.log('[e2e-orch] waiting for secretary to delegate and accountant to receive INV-42...');
    await waitFor('accountant inbound INV-42', () => {
      const sessions = getSessionsByAgentGroup(accountantGroupId);
      for (const s of sessions) {
        if (sessionHasInboundText(nanoclawDataDir, accountantGroupId, s.id, 'INV-42')) {
          return true;
        }
      }
      return undefined;
    }, 180_000);

    const beforeDelete = listOrchestratorAgents();
    if (beforeDelete.length < 2) {
      throw new Error(`expected 2 orchestrator agents, got ${beforeDelete.length}`);
    }

    console.log('[e2e-orch] scenario PASS');

    console.log('[e2e-orch] deleting agents...');
    await stopNanoclawContainers();
    if (secretaryOrchId) {
      const del = await orchFetch(orchestratorUrl, orchestratorSecret, `/v1/agents/${secretaryOrchId}`, {
        method: 'DELETE',
      });
      if (del.status !== 204) {
        throw new Error(`delete secretary failed: ${del.status} ${await del.text()}`);
      }
    }
    if (accountantOrchId) {
      const del = await orchFetch(orchestratorUrl, orchestratorSecret, `/v1/agents/${accountantOrchId}`, {
        method: 'DELETE',
      });
      if (del.status !== 204) {
        throw new Error(`delete accountant failed: ${del.status} ${await del.text()}`);
      }
    }

    await waitFor('openfire user cleanup', async () => {
      const secGone = !(await openfireUserExists(config.openfireUrl, secretaryUsername));
      const accGone = !(await openfireUserExists(config.openfireUrl, accountantUsername));
      return secGone && accGone ? true : undefined;
    }, 30_000);

    const listed = listOrchestratorAgents();
    if (listed.length !== 0) {
      throw new Error(`expected 0 orchestrator agents after delete, got ${listed.length}`);
    }

    console.log('[e2e-orch] teardown verified');
  } finally {
    await stopOrchestratorE2eStack(stack);
  }
}

main().catch((err) => {
  console.error('[e2e-orch] FAIL:', err);
  process.exit(1);
});
