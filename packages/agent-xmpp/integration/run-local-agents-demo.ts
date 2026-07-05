#!/usr/bin/env tsx
/**
 * Provision two XMPP agents with distinct personalities, routed to a local
 * Rapid-MLX server (Anthropic-compatible API on the host).
 *
 * Prerequisites (start manually before this script):
 *   rapid-mlx serve gpt-oss-20b-4bit   # default http://127.0.0.1:8000
 *   ./container/build.sh        # agent container image
 *   onecli gateway running      # credential proxy (spawn env overrides base URL)
 *
 * Usage:
 *   pnpm --filter @agent-xmpp/integration demo:local-agents
 *   # or: bash scripts/run-xmpp-two-agents-demo.sh
 *
 * Connect with any XMPP client as john@example.org / secret (server 127.0.0.1:15222).
 */
import fs from 'node:fs';
import path from 'node:path';

import { initDb } from '../../../src/db/connection.js';
import { GatewayClient } from './gateway-client.js';
import { injectViaCliSocket } from './cli-inject.js';
import {
  startOrchestratorE2eStack,
  stopOrchestratorE2eStack,
  type OrchestratorE2eStack,
} from './e2e-orchestrator-stack.js';
import { REPO_ROOT } from './e2e-stack.js';
import { resolveNode22Bin, resolveNode22Version } from './resolve-node22.js';

const XMPP_MCP = path.join(REPO_ROOT, 'packages/agent-xmpp/mcp/dist/index.js');
const DEFAULT_MODEL = 'gpt-oss-20b-4bit';

let stepCounter = 0;

function logStep(message: string): void {
  stepCounter += 1;
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[demo ${ts}] step ${stepCounter}: ${message}`);
}

function logDetail(message: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[demo ${ts}]        ${message}`);
}

function logDone(message: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[demo ${ts}]   ok — ${message}`);
}

interface AgentSpec {
  agentId: string;
  name: string;
  displayName: string;
  instructions: string;
}

const DEFAULT_AGENTS: AgentSpec[] = [
  {
    agentId: 'jane',
    name: 'Jane',
    displayName: 'Jane',
    instructions:
      'You are Jane — calm, thoughtful, and a little poetic. Answer in complete sentences. ' +
      'When unsure, say so plainly. Keep replies under 120 words unless asked for detail.',
  },
  {
    agentId: 'mike',
    name: 'Mike',
    displayName: 'Mike',
    instructions:
      'You are Mike — upbeat, direct, and witty. Prefer short paragraphs and bullet points. ' +
      'Use one emoji when it fits. Keep replies under 80 words unless asked for detail.',
  },
];

function env(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function parseAgentsFromEnv(): AgentSpec[] {
  const raw = process.env.DEMO_AGENT_SPECS;
  if (!raw) return DEFAULT_AGENTS;
  const parsed = JSON.parse(raw) as AgentSpec[];
  if (!Array.isArray(parsed) || parsed.length < 2) {
    throw new Error('DEMO_AGENT_SPECS must be a JSON array with at least 2 agents');
  }
  return parsed;
}

function rapidMlxHostUrl(): string {
  return env('RAPID_MLX_URL', 'http://127.0.0.1:8000').replace(/\/$/, '');
}

/** URL reachable from inside the agent container. */
function rapidMlxContainerBaseUrl(hostUrl: string): string {
  try {
    const url = new URL(hostUrl);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      url.hostname = 'host.docker.internal';
    }
    return url.toString().replace(/\/$/, '');
    // eslint-disable-next-line no-catch-all/no-catch-all -- invalid URL falls back to docker host default
  } catch {
    return 'http://host.docker.internal:8000';
  }
}

function buildLlmSpawnEnv(hostUrl: string): Record<string, string> {
  const containerBase = rapidMlxContainerBaseUrl(hostUrl);
  return {
    ANTHROPIC_BASE_URL: containerBase,
    ANTHROPIC_API_KEY: env('RAPID_MLX_API_KEY', 'not-needed'),
    NO_PROXY: 'host.docker.internal',
    no_proxy: 'host.docker.internal',
    BLOCKED_HOSTS: env('DEMO_BLOCKED_HOSTS', 'api.anthropic.com'),
  };
}

async function assertRapidMlx(hostUrl: string, model: string): Promise<void> {
  logStep(`checking Rapid-MLX at ${hostUrl} (model: ${model})`);
  const probes = [`${hostUrl}/v1/models`, `${hostUrl}/health`, hostUrl];
  for (const url of probes) {
    logDetail(`probe ${url}`);
    try {
      const res = await fetch(url);
      if (res.ok) {
        logDone(`Rapid-MLX reachable (probe ${url})`);
        if (url.endsWith('/v1/models')) {
          try {
            const body = (await res.json()) as { data?: Array<{ id?: string }> };
            const ids = body.data?.map((m) => m.id).filter(Boolean) ?? [];
            if (ids.length > 0) {
              logDetail(`available models: ${ids.join(', ')}`);
              if (!ids.includes(model)) {
                logDetail(`warning: requested model "${model}" not listed — server may still accept it`);
              }
            }
            // eslint-disable-next-line no-catch-all/no-catch-all -- non-JSON /v1/models response is acceptable
          } catch {
            // non-JSON health response is fine
          }
        }
        return;
      }
      logDetail(`probe returned HTTP ${res.status}`);
      // eslint-disable-next-line no-catch-all/no-catch-all -- probe loop tries alternate URLs before failing
    } catch (err) {
      logDetail(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(
    `Rapid-MLX not reachable at ${hostUrl}. Start it first, e.g.: rapid-mlx serve ${model}`,
  );
}

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
  return fetch(`${baseUrl}${pathname}`, { ...init, headers });
}

function writeAgentModel(dataDir: string, agentGroupId: string, model: string): void {
  const settingsPath = path.join(dataDir, 'v2-sessions', agentGroupId, '.claude-shared', 'settings.json');
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  }
  settings.model = model;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

async function wakeAgent(dataDir: string, domain: string, agentJid: string, text: string): Promise<void> {
  await injectViaCliSocket(dataDir, {
    text,
    sender: 'demo',
    senderId: `demo@${domain}`,
    to: {
      channelType: 'xmpp',
      platformId: `demo@${domain}`,
      threadId: null,
      instance: agentJid,
    },
  });
}

function parseRoomJid(roomJid: string): { roomName: string; service: string } {
  const at = roomJid.indexOf('@');
  if (at < 0) throw new Error(`Invalid room JID: ${roomJid}`);
  return { roomName: roomJid.slice(0, at), service: roomJid.slice(at + 1) };
}

async function fetchMucOccupantNicks(openfireUrl: string, roomJid: string): Promise<string[]> {
  const secret = env('OPENFIRE_REST_SECRET', 'e2e-rest-secret');
  const mucService = env('DEMO_MUC_SERVICE_NAME', 'conference');
  const { roomName } = parseRoomJid(roomJid);
  const url = `${openfireUrl}/plugins/restapi/v1/chatrooms/${encodeURIComponent(roomName)}/occupants?servicename=${encodeURIComponent(mucService)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: secret,
      Accept: 'application/json',
    },
  });
  if (!res.ok) return [];
  const text = await res.text();
  if (!text.trim()) return [];
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return [];
  }
  const rows = normalizeOpenfireOccupants(body);
  return rows
    .map((row) => occupantNick(row))
    .filter(Boolean);
}

function normalizeOpenfireOccupants(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  const root = body as { occupants?: unknown };
  const raw = root?.occupants;
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === 'object') {
    const nested = (raw as { occupant?: unknown }).occupant;
    if (Array.isArray(nested)) return nested as Record<string, unknown>[];
    if (nested && typeof nested === 'object') return [nested as Record<string, unknown>];
  }
  return [];
}

function occupantNick(row: Record<string, unknown>): string {
  const nick = row.nick ?? row.nickname;
  if (typeof nick === 'string' && nick) return nick;
  for (const key of ['jid', 'userAddress'] as const) {
    const jid = row[key];
    if (typeof jid !== 'string' || !jid) continue;
    const slash = jid.lastIndexOf('/');
    if (slash >= 0) return jid.slice(slash + 1);
    const at = jid.indexOf('@');
    if (at > 0) return jid.slice(0, at);
  }
  return '';
}

async function assertMucOccupants(openfireUrl: string, roomJid: string, expectedNicks: string[]): Promise<void> {
  await waitFor(`MUC occupants (${expectedNicks.join(', ')})`, async () => {
    const nicks = await fetchMucOccupantNicks(openfireUrl, roomJid);
    const missing = expectedNicks.filter((n) => !nicks.includes(n));
    if (missing.length > 0) {
      logDetail(`room has [${nicks.join(', ')}]; waiting for ${missing.join(', ')}`);
      return undefined;
    }
    return true;
  });
}

async function waitFor<T>(
  label: string,
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 120_000,
): Promise<T> {
  logStep(`waiting for ${label} (timeout ${Math.round(timeoutMs / 1000)}s)`);
  const deadline = Date.now() + timeoutMs;
  let lastProgress = Date.now();
  while (Date.now() < deadline) {
    const hit = await fn();
    if (hit !== undefined) {
      logDone(label);
      return hit;
    }
    if (Date.now() - lastProgress >= 10_000) {
      const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      logDetail(`still waiting for ${label}… (${remaining}s left)`);
      lastProgress = Date.now();
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function provisionAgent(
  stack: OrchestratorE2eStack,
  spec: AgentSpec,
  llmSpawnEnv: Record<string, string>,
  model: string,
): Promise<{ orchId: string; jid: string; agentGroupId: string; nick: string }> {
  const { orchestratorUrl, orchestratorSecret, config } = stack;
  logStep(`provisioning agent "${spec.displayName}" (${spec.agentId}) via orchestrator`);
  logDetail(`POST ${orchestratorUrl}/v1/agents`);
  const res = await orchFetch(orchestratorUrl, orchestratorSecret, '/v1/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: spec.name,
      agentId: spec.agentId,
      tenantId: config.xmppDomain,
      displayName: spec.displayName,
      personality: { instructions: spec.instructions, assistantName: spec.displayName },
      provider: 'claude',
      model,
      skills: [],
      mcpServers: [{ name: 'xmpp', command: 'node', args: [XMPP_MCP] }],
      groups: ['Agents'],
      spawnEnv: llmSpawnEnv,
    }),
  });
  if (!res.ok) {
    throw new Error(`provision ${spec.agentId} failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string; jid: string; agentGroupId: string };
  logDone(`orchestrator created ${body.jid} (group ${body.agentGroupId})`);
  logDetail(`writing settings.json model=${model}`);
  writeAgentModel(stack.nanoclawDataDir, body.agentGroupId, model);
  logDetail('injecting wake message to start container');
  await wakeAgent(stack.nanoclawDataDir, config.xmppDomain, body.jid, 'Hello — please introduce yourself briefly.');
  logDone(`${spec.displayName} provisioned and woken`);
  return { orchId: body.id, jid: body.jid, agentGroupId: body.agentGroupId, nick: spec.agentId };
}

function printInstructions(
  stack: OrchestratorE2eStack,
  agents: Array<{ jid: string; nick: string; name: string }>,
  roomJid: string,
): void {
  const { config } = stack;
  const xmppHost = '127.0.0.1';
  const xmppPort = config.xmppPort;
  const humanJid = env('DEMO_HUMAN_JID', `john@${config.xmppDomain}`);
  const humanPass = env('DEMO_HUMAN_PASSWORD', 'secret');

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  XMPP two-agent demo is running');
  console.log('══════════════════════════════════════════════════════════════\n');
  console.log('XMPP server');
  console.log(`  Host:     ${xmppHost}`);
  console.log(`  Port:     ${xmppPort}`);
  console.log(`  Domain:   ${config.xmppDomain}`);
  console.log(`  Login:    ${humanJid}`);
  console.log(`  Password: ${humanPass}\n`);

  console.log('Agents (DM each one directly)');
  for (const a of agents) {
    console.log(`  ${a.name.padEnd(8)} ${a.jid}`);
  }

  console.log('\nGroup chat (MUC)');
  console.log(`  Room:     ${roomJid}`);
  console.log('  Both agents are joined. In the room, @mention an agent to wake it:');
  for (const a of agents) {
    console.log(`    @${a.nick} <your message>`);
  }
  console.log('\n  Join the room in your XMPP client (public, pre-created at bootstrap):');
  console.log(`    Room JID: ${roomJid}`);
  console.log('    You should see Jane and Mike already in the member list.\n');

  console.log('Rapid-MLX');
  console.log(`  Host URL: ${rapidMlxHostUrl()}`);
  console.log(`  Model:    ${env('RAPID_MLX_MODEL', DEFAULT_MODEL)}\n`);

  console.log('Stop');
  console.log('  Ctrl+C in this terminal tears down Openfire, gateway, host, and orchestrator.');
  console.log('  Set KEEP_DEMO=1 to leave containers running after exit.\n');
}

async function main(): Promise<void> {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor !== 22) {
    throw new Error(
      `Node.js 22 required (current v${process.versions.node}). Run: bash scripts/run-xmpp-two-agents-demo.sh`,
    );
  }
  const nodeBin = resolveNode22Bin();
  if (process.execPath !== nodeBin && nodeMajor === 22) {
    logDetail(`Node binary: ${nodeBin}`);
  }

  console.log('');
  logStep('XMPP two-agent demo starting');
  logDetail(`Node ${resolveNode22Version()} (required for better-sqlite3)`);
  const hostUrl = rapidMlxHostUrl();
  const model = env('RAPID_MLX_MODEL', DEFAULT_MODEL);
  const agentSpecs = parseAgentsFromEnv();
  const llmSpawnEnv = buildLlmSpawnEnv(hostUrl);

  logDetail(`agents: ${agentSpecs.slice(0, 2).map((a) => a.agentId).join(', ')}`);
  logDetail(`rapid-mlx host: ${hostUrl}`);
  logDetail(`container ANTHROPIC_BASE_URL: ${llmSpawnEnv.ANTHROPIC_BASE_URL}`);

  await assertRapidMlx(hostUrl, model);

  logStep('starting infrastructure stack (Openfire → bootstrap → gateway → OneCLI check → NanoClaw host → orchestrator)');
  logDetail('this may take 1–2 minutes on first run');
  const stack = await startOrchestratorE2eStack();
  logDone('infrastructure stack up');
  logDetail(`XMPP ${stack.config.xmppService}`);
  logDetail(`gateway ${stack.config.gatewayUrl}`);
  logDetail(`orchestrator ${stack.orchestratorUrl}`);
  logDetail(`data dir ${stack.nanoclawDataDir}`);

  logStep('initializing demo database');
  process.env.NANCLAW_DATA_DIR = stack.nanoclawDataDir;
  initDb(path.join(stack.nanoclawDataDir, 'v2.db'));
  logDone('database ready');

  const roomJid = env('DEMO_MUC_ROOM', `agents-lounge@conference.${stack.config.xmppDomain}`);
  const api = new GatewayClient(stack.config.gatewayUrl);
  const provisioned: Array<{ orchId: string; jid: string; nick: string; name: string }> = [];

  try {
    logStep(`provisioning ${Math.min(agentSpecs.length, 2)} agents`);
    for (const spec of agentSpecs.slice(0, 2)) {
      const agent = await provisionAgent(stack, spec, llmSpawnEnv, model);
      provisioned.push({ orchId: agent.orchId, jid: agent.jid, nick: agent.nick, name: spec.name });
    }
    logDone('all agents provisioned');

    await waitFor('both agents in gateway discovery', async () => {
      const { status, json } = await api.discoverAgents({ capabilities: ['send_message'] });
      if (status !== 200) return undefined;
      const agents = (json as { agents?: Array<{ jid: string }> }).agents ?? [];
      const jids = new Set(provisioned.map((a) => a.jid));
      const found = agents.filter((a) => jids.has(a.jid));
      if (found.length < provisioned.length) {
        logDetail(`discovery has ${found.length}/${provisioned.length} agents so far`);
        return undefined;
      }
      return true;
    });

    logStep(`joining agents to MUC room ${roomJid}`);
    for (const agent of provisioned) {
      logDetail(`join ${agent.jid} as nick "${agent.nick}"`);
      const { status, json } = await api.joinRoom({
        from: agent.jid,
        roomJid,
        nickname: agent.nick,
      });
      if (status !== 200 || !(json as { ok?: boolean }).ok) {
        throw new Error(`join_room failed for ${agent.jid}: ${status}`);
      }
      logDone(`${agent.nick} joined room`);
    }

    await assertMucOccupants(
      stack.config.openfireUrl,
      roomJid,
      provisioned.map((a) => a.nick),
    );

    logStep('demo ready — connect your XMPP client');
    printInstructions(stack, provisioned, roomJid);

    logDetail('press Ctrl+C to stop');
    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => {
        logStep('shutdown requested (SIGINT)');
        resolve();
      });
      process.on('SIGTERM', () => {
        logStep('shutdown requested (SIGTERM)');
        resolve();
      });
    });
  } finally {
    if (process.env.KEEP_DEMO !== '1') {
      logStep('tearing down stack (orchestrator → host → gateway → Openfire)');
      await stopOrchestratorE2eStack(stack);
      logDone('shutdown complete');
    } else {
      logDetail('KEEP_DEMO=1 — stack left running');
    }
  }
}

main().catch((err) => {
  console.error('[demo] FAIL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
