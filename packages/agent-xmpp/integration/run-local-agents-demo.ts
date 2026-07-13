#!/usr/bin/env tsx
/** Live two-agent demo using the embedded XMPP component and Rapid-MLX. */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getDefaultContainerImage } from '../../../src/install-slug.js';
import { startOpenfireOnly, stopOpenfireOnly, type E2eStackConfig, REPO_ROOT } from './e2e-stack.js';
import { resolveNode22Bin, resolveNode22Version } from './resolve-node22.js';
import { XmppSession } from './xmpp-session.js';

const TSX = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const DEMO_ROOT = path.join(REPO_ROOT, 'packages', 'agent-xmpp', 'integration', '.data', 'local-agents-demo');
const DATA_DIR = path.join(DEMO_ROOT, 'data');
const GROUPS_DIR = path.join(DEMO_ROOT, 'groups');
const COMPONENT_JID = process.env.DEMO_COMPONENT_JID || 'demo-gateway.example.org';
const ORCHESTRATOR_PORT = Number(process.env.DEMO_ORCHESTRATOR_PORT || '19300');
const ORCHESTRATOR_URL = `http://127.0.0.1:${ORCHESTRATOR_PORT}`;
const ORCHESTRATOR_SECRET = process.env.ORCHESTRATOR_API_SECRET || 'local-xmpp-demo-secret';
const RAPID_MLX_URL = (process.env.RAPID_MLX_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const RAPID_MLX_MODEL = process.env.RAPID_MLX_MODEL || 'gemma-4-12b-qat-4bit';
const RAPID_MLX_MODEL_ID = process.env.RAPID_MLX_MODEL_ID || 'mlx-community/gemma-4-12B-it-qat-4bit';
const RAPID_MLX_PROVIDER = 'rapid-mlx';
const CONTAINER_MODEL = `${RAPID_MLX_PROVIDER}/${RAPID_MLX_MODEL_ID}`;

interface DemoAgent {
  id: string;
  name: string;
  instructions: string;
}

interface ProvisionedAgent extends DemoAgent {
  orchestratorId: string;
  agentGroupId: string;
  jid: string;
}

const AGENTS: DemoAgent[] = [
  {
    id: 'jane',
    name: 'Jane',
    instructions:
      'You are Jane, a calm and thoughtful assistant. Answer directly in complete sentences. Keep ordinary replies under 120 words.',
  },
  {
    id: 'mike',
    name: 'Mike',
    instructions:
      'You are Mike, an upbeat, direct, and lightly witty assistant. Prefer short replies and use at most one emoji.',
  },
];

let rapidMlxProcess: ChildProcess | null = null;
let hostProcess: ChildProcess | null = null;
let orchestratorProcess: ChildProcess | null = null;
let openfireStarted = false;
let provisioned: ProvisionedAgent[] = [];
let cleanupPromise: Promise<void> | null = null;

function log(message: string): void {
  console.log(`[demo ${new Date().toISOString().slice(11, 19)}] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnLogged(name: string, command: string, args: string[], env = process.env): ChildProcess {
  const child = spawn(command, args, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (data) => process.stdout.write(`[${name}] ${data}`));
  child.stderr?.on('data', (data) => process.stderr.write(`[${name}] ${data}`));
  return child;
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitFor(label: string, check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(1_000);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function urlIsReady(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

async function ensureRapidMlx(): Promise<void> {
  if (await urlIsReady(`${RAPID_MLX_URL}/v1/models`)) {
    log(`reusing Rapid-MLX at ${RAPID_MLX_URL}`);
    return;
  }
  const parsed = new URL(RAPID_MLX_URL);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new Error(`Rapid-MLX is unavailable at ${RAPID_MLX_URL}; automatic start is local-only`);
  }
  log(`starting Rapid-MLX model ${RAPID_MLX_MODEL}`);
  rapidMlxProcess = spawnLogged('rapid-mlx', 'rapid-mlx', [
    'serve',
    RAPID_MLX_MODEL,
    '--port',
    parsed.port || '8000',
    '--max-tokens',
    '4096',
    '--prefill-step-size',
    '2048',
    '--chunked-prefill-tokens',
    '2048',
    '--gpu-memory-utilization',
    '0.95',
    '--max-num-seqs',
    '1',
    '--max-concurrent-requests',
    '1',
    // Each demo agent has a different prompt. Retaining Jane's KV cache can
    // leave too little Metal headroom to admit Mike's request on this model.
    '--disable-prefix-cache',
  ]);
  await waitFor('Rapid-MLX', () => urlIsReady(`${RAPID_MLX_URL}/v1/models`), 10 * 60_000);
}

async function run(command: string, args: string[], env = process.env): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
  });
}

async function output(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => (stderr += data));
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} exited ${code}: ${stderr.trim()}`)),
    );
  });
}

async function ensureOneCli(): Promise<string> {
  const url = process.env.ONECLI_URL || 'http://127.0.0.1:10254';
  if (await urlIsReady(`${url}/v1/health`)) return url;
  const composeFile = path.join(os.homedir(), '.onecli', 'docker-compose.yml');
  if (!fs.existsSync(composeFile)) {
    throw new Error(`OneCLI is unavailable at ${url} and ${composeFile} does not exist`);
  }
  log('starting the existing OneCLI compose stack');
  await run('docker', ['compose', '-f', composeFile, 'up', '-d']);
  await waitFor('OneCLI', () => urlIsReady(`${url}/v1/health`), 120_000);
  return url;
}

function stampUpgradeState(): void {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DATA_DIR, 'upgrade-state.json'),
    `${JSON.stringify({ version: pkg.version, updatedAt: new Date().toISOString(), via: 'xmpp-local-agents-demo' }, null, 2)}\n`,
  );
}

async function waitForPath(file: string, timeoutMs = 60_000): Promise<void> {
  await waitFor(file, async () => fs.existsSync(file), timeoutMs);
}

async function waitForHealth(url: string): Promise<void> {
  await waitFor(`${url}/health`, () => urlIsReady(`${url}/health`), 60_000);
}

function containerRapidMlxUrl(): string {
  const url = new URL(RAPID_MLX_URL);
  if (['127.0.0.1', 'localhost'].includes(url.hostname)) url.hostname = 'host.docker.internal';
  return `${url.toString().replace(/\/$/, '')}/v1`;
}

async function provisionAgent(agent: DemoAgent): Promise<ProvisionedAgent> {
  const response = await fetch(`${ORCHESTRATOR_URL}/v1/agents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ORCHESTRATOR_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: agent.name,
      agentId: agent.id,
      tenantId: COMPONENT_JID,
      displayName: agent.name,
      personality: { assistantName: agent.name, instructions: agent.instructions },
      provider: 'opencode',
      model: CONTAINER_MODEL,
      skills: [],
      spawnEnv: {
        OPENCODE_PROVIDER: RAPID_MLX_PROVIDER,
        OPENCODE_PROVIDER_NPM: '@ai-sdk/openai-compatible',
        OPENCODE_PROVIDER_NAME: 'Rapid-MLX',
        OPENCODE_PROVIDER_API_KEY: 'not-needed',
        OPENCODE_AGENT_NAME: 'nanoclaw',
        OPENCODE_AGENT_PROMPT:
          'You are a NanoClaw messaging agent. Follow the identity, routing, and message-envelope instructions in the user content. Use the available MCP tools when needed. Be concise.',
        OPENCODE_DISABLE_BUILTIN_TOOLS: '1',
        // Keep the local model's prompt small enough for multi-turn chat while
        // retaining the complete remote-agent call/task lifecycle. Gateway
        // discovery manifests remain unchanged.
        NANOCLAW_MCP_TOOL_ALLOWLIST: [
          'agents.discover_endpoints',
          'agents.describe_endpoint',
          'agents.list_tools',
          'agents.call_tool',
          'task.report_progress',
          'task.request_input',
          'task.complete',
          'task.fail',
          'task.cancelled',
        ].join(','),
        OPENCODE_MODEL_CONTEXT_LIMIT: '262144',
        OPENCODE_MODEL_OUTPUT_LIMIT: '512',
        OPENCODE_MODEL: CONTAINER_MODEL,
        OPENCODE_SMALL_MODEL: CONTAINER_MODEL,
        ANTHROPIC_BASE_URL: containerRapidMlxUrl(),
        NO_PROXY: '127.0.0.1,localhost,host.docker.internal',
        no_proxy: '127.0.0.1,localhost,host.docker.internal',
      },
    }),
  });
  if (!response.ok) throw new Error(`Provisioning ${agent.name} failed: ${response.status} ${await response.text()}`);
  const result = (await response.json()) as { id: string; agentGroupId: string; jid: string };
  return { ...agent, orchestratorId: result.id, agentGroupId: result.agentGroupId, jid: result.jid };
}

async function waitForAgentReply(client: XmppSession, agent: ProvisionedAgent): Promise<string> {
  const deadline = Date.now() + 10 * 60_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const pending = client.waitForStanza(
      (stanza) => {
        if (!stanza.is('message')) return false;
        const from = String(stanza.attrs.from || '').split('/')[0];
        return from === agent.jid && Boolean(stanza.getChildText('body')?.trim());
      },
      Math.max(1, deadline - Date.now()),
    );
    await client.sendChat(
      agent.jid,
      `Hello ${agent.name}. Introduce yourself in one short sentence. Demo attempt ${attempt}.`,
    );
    const stanza = await pending;
    const reply = stanza.getChildText('body')?.trim() || '';
    if (!reply.startsWith('Error:')) return reply;
    if (!/server is busy|max concurrent requests/i.test(reply)) {
      throw new Error(`${agent.name} returned ${reply}`);
    }
    log(`${agent.name} is waiting for the shared Rapid-MLX slot; retrying in 10 seconds`);
    await sleep(10_000);
  }
  throw new Error(`Timed out waiting for a successful reply from ${agent.name}`);
}

async function deleteProvisionedAgents(): Promise<void> {
  for (const agent of provisioned.reverse()) {
    await fetch(`${ORCHESTRATOR_URL}/v1/agents/${agent.orchestratorId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ORCHESTRATOR_SECRET}` },
    }).catch(() => undefined);
  }
}

function printConnectionInfo(config: E2eStackConfig): void {
  console.log('\nXMPP two-agent demo is ready\n');
  console.log('Human account:');
  console.log(`  JID:      john@${config.xmppDomain}`);
  console.log('  Password: secret');
  console.log('  Host:     127.0.0.1');
  console.log(`  Port:     ${config.xmppPort}`);
  console.log('\nAgents:');
  for (const agent of provisioned) console.log(`  ${agent.name.padEnd(8)} ${agent.jid}`);
  console.log(`\nModel: ${RAPID_MLX_MODEL} via OpenCode at ${RAPID_MLX_URL}`);
  console.log('Press Ctrl+C to stop and clean up. Set KEEP_DEMO=1 to retain the running stack.\n');
}

async function cleanup(): Promise<void> {
  cleanupPromise ??= (async () => {
    if (process.env.KEEP_DEMO === '1') return;
    const containerIds = await output('docker', ['ps', '-q', '--filter', 'label=nanoclaw-install=xmpp-demo']).catch(
      () => '',
    );
    if (containerIds) await run('docker', ['stop', ...containerIds.split(/\s+/)]).catch(() => undefined);
    if (fs.existsSync(DEMO_ROOT)) {
      const image = process.env.CONTAINER_IMAGE || getDefaultContainerImage(REPO_ROOT);
      await run('docker', [
        'run',
        '--rm',
        '--entrypoint',
        'chown',
        '-v',
        `${DEMO_ROOT}:/demo`,
        image,
        '-R',
        `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
        '/demo',
      ]).catch(() => undefined);
    }
    await deleteProvisionedAgents();
    await stopChild(orchestratorProcess);
    await stopChild(hostProcess);
    if (openfireStarted) await stopOpenfireOnly();
    await stopChild(rapidMlxProcess);
    fs.rmSync(DEMO_ROOT, { recursive: true, force: true });
  })();
  await cleanupPromise;
}

async function main(): Promise<void> {
  if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('Node.js 22 is required');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
    });
  }
  log(`using Node ${resolveNode22Version()}`);
  if (process.env.KEEP_DEMO === '1') process.env.KEEP_E2E = '1';

  await ensureRapidMlx();
  const oneCliUrl = await ensureOneCli();

  if (process.env.KEEP_DEMO !== '1') fs.rmSync(DEMO_ROOT, { recursive: true, force: true });
  fs.mkdirSync(GROUPS_DIR, { recursive: true });
  stampUpgradeState();

  const config = await startOpenfireOnly();
  openfireStarted = true;
  const sharedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NANOCLAW_DATA_DIR: DATA_DIR,
    NANOCLAW_GROUPS_DIR: GROUPS_DIR,
    NANOCLAW_INSTALL_SLUG: 'xmpp-demo',
    CONTAINER_IMAGE: process.env.CONTAINER_IMAGE || getDefaultContainerImage(REPO_ROOT),
    ONECLI_URL: oneCliUrl,
    ORCHESTRATOR_API_SECRET: ORCHESTRATOR_SECRET,
    ORCHESTRATOR_PORT: String(ORCHESTRATOR_PORT),
    ORCHESTRATOR_SKIP_OPENFIRE: '1',
    OPENFIRE_URL: config.openfireUrl,
    OPENFIRE_REST_SECRET: process.env.OPENFIRE_REST_SECRET || 'e2e-rest-secret',
    XMPP_COMPONENT_JID: COMPONENT_JID,
    XMPP_AGENT_DOMAIN: COMPONENT_JID,
    XMPP_COMPONENT_SERVICE: `xmpp://127.0.0.1:${config.componentPort}`,
    XMPP_COMPONENT_SECRET: 'component-secret',
    XMPP_DEFAULT_AGENT_JID: `assistant@${COMPONENT_JID}`,
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  };

  hostProcess = spawnLogged('host', resolveNode22Bin(), [TSX, 'src/index.ts'], sharedEnv);
  await waitForPath(path.join(DATA_DIR, 'ncl.sock'));
  orchestratorProcess = spawnLogged(
    'orchestrator',
    resolveNode22Bin(),
    [TSX, 'packages/orchestrator/src/server.ts'],
    sharedEnv,
  );
  await waitForHealth(ORCHESTRATOR_URL);

  for (const spec of AGENTS) {
    const agent = await provisionAgent(spec);
    provisioned.push(agent);
    log(`provisioned ${agent.name} as ${agent.jid}`);
  }

  const human = new XmppSession({
    service: config.xmppService,
    domain: config.xmppDomain,
    username: 'john',
    password: 'secret',
  });
  await human.start();
  try {
    for (const agent of provisioned) {
      log(`smoke testing ${agent.jid}`);
      const reply = await waitForAgentReply(human, agent);
      log(`${agent.name} replied: ${reply}`);
    }
  } finally {
    await human.stop().catch(() => undefined);
  }

  printConnectionInfo(config);
  if (process.env.DEMO_SMOKE_ONLY === '1') return;
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
}

main()
  .catch((error) => {
    console.error('[demo] failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(cleanup);
