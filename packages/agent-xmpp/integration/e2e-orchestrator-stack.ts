/**
 * Full E2E stack: Openfire + gateway + NanoClaw host + orchestrator HTTP.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  e2eConfig,
  freePort,
  REPO_ROOT,
  runOpenfireBootstrap,
  startGateway,
  stopGateway,
  waitForTcp,
  waitForUrl,
  type E2eStackConfig,
} from './e2e-stack.js';
import { readEnvFile } from '../../../src/env.js';
import { getDefaultContainerImage } from '../../../src/install-slug.js';
import { getOnecliApiHost } from '../../../setup/onecli.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = path.join(__dirname, 'docker-compose.yml');
const TSX = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

export interface OrchestratorE2eStack {
  config: E2eStackConfig;
  gatewayProc: ChildProcess;
  hostProc: ChildProcess;
  orchestratorProc: ChildProcess;
  nanoclawDataDir: string;
  orchestratorUrl: string;
  orchestratorSecret: string;
}

async function compose(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
      cwd: __dirname,
      stdio: 'inherit',
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`docker compose exited ${code}`))));
  });
}

async function curlJson(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

async function waitForHealth(url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await curlJson(`${url}/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Health check failed: ${url}`);
}

function spawnLogged(name: string, command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (buf) => process.stdout.write(`[${name}] ${buf}`));
  child.stderr?.on('data', (buf) => process.stderr.write(`[${name}] ${buf}`));
  return child;
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 8000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForCliSocket(dataDir: string, timeoutMs = 60_000): Promise<void> {
  const sockPath = path.join(dataDir, 'cli.sock');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(sockPath);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`CLI socket not ready: ${sockPath}`);
}

async function assertContainerImage(image: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    await execFileAsync('docker', ['image', 'inspect', image], { encoding: 'utf8' });
  } catch {
    throw new Error(
      `Agent container image not found: ${image}. Build it from the repo root with ./container/build.sh`,
    );
  }
}

async function resolveOnecliUrl(): Promise<string> {
  const fromEnv = process.env.ONECLI_URL || readEnvFile(['ONECLI_URL']).ONECLI_URL;
  if (fromEnv) return fromEnv;
  const fromCli = getOnecliApiHost();
  if (fromCli) return fromCli;
  return 'http://127.0.0.1:10254';
}

async function assertOnecliReachable(url: string): Promise<void> {
  const res = await fetch(`${url.replace(/\/$/, '')}/v1/agents`).catch(() => null);
  if (!res?.ok) {
    throw new Error(
      `OneCLI gateway not reachable at ${url} (GET /v1/agents failed). Start the local gateway or set ONECLI_URL.`,
    );
  }
}

async function stampUpgradeState(dataDir: string): Promise<void> {
  const pkg = JSON.parse(
    await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as { version: string };
  await fs.writeFile(
    path.join(dataDir, 'upgrade-state.json'),
    `${JSON.stringify(
      {
        version: pkg.version,
        updatedAt: new Date().toISOString(),
        via: 'e2e-orchestrator',
      },
      null,
      2,
    )}\n`,
  );
}

export async function startOrchestratorE2eStack(): Promise<OrchestratorE2eStack> {
  const config = e2eConfig();
  const nanoclawDataDir = path.join(__dirname, '.data', 'nanoclaw-e2e');
  const orchestratorPort = process.env.E2E_ORCHESTRATOR_PORT || '19300';
  const orchestratorUrl = `http://127.0.0.1:${orchestratorPort}`;
  const orchestratorSecret = process.env.ORCHESTRATOR_API_SECRET || 'e2e-orchestrator-secret';

  process.env.E2E_XMPP_PORT = config.xmppPort;
  process.env.E2E_COMPONENT_PORT = config.componentPort;
  process.env.E2E_OPENFIRE_ADMIN_PORT = process.env.E2E_OPENFIRE_ADMIN_PORT || '19090';
  process.env.E2E_GATEWAY_PORT = config.gatewayPort;
  process.env.E2E_BRIDGE_PORT = config.bridgePort;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  if (!process.env.KEEP_E2E) {
    await compose(['down', '-v']).catch(() => undefined);
  }
  await fs.rm(config.gatewayDataDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(nanoclawDataDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(nanoclawDataDir, { recursive: true });
  await stampUpgradeState(nanoclawDataDir);

  console.log('[e2e-orch] starting Openfire...');
  await compose(['up', '-d', 'openfire']);
  await waitForUrl(`${config.openfireUrl}/login.jsp`);
  await waitForTcp(Number(config.xmppPort));
  await new Promise((r) => setTimeout(r, 15000));
  await runOpenfireBootstrap(config);

  console.log('[e2e-orch] starting gateway...');
  await freePort(Number(config.gatewayPort));
  await freePort(Number(config.bridgePort));
  const gateway = startGateway(config);
  try {
    await Promise.race([
      gateway.online,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('gateway component did not connect in time')), 60_000),
      ),
    ]);
  } catch (err) {
    await stopGateway(gateway.proc);
    throw err;
  }

  const onecliUrl = await resolveOnecliUrl();
  await assertOnecliReachable(onecliUrl);
  const onecliEnv = readEnvFile(['ONECLI_API_KEY']);
  const containerImage = process.env.CONTAINER_IMAGE || getDefaultContainerImage(REPO_ROOT);
  await assertContainerImage(containerImage);

  const sharedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NANCLAW_DATA_DIR: nanoclawDataDir,
    CONTAINER_IMAGE: containerImage,
    ONECLI_URL: onecliUrl,
    ...(onecliEnv.ONECLI_API_KEY ? { ONECLI_API_KEY: onecliEnv.ONECLI_API_KEY } : {}),
    OPENFIRE_URL: config.openfireUrl,
    XMPP_DOMAIN: config.xmppDomain,
    XMPP_GATEWAY_URL: config.gatewayUrl,
    XMPP_BRIDGE_WEBHOOK_PORT: config.bridgePort,
    XMPP_BRIDGE_WEBHOOK_SECRET: 'dev-secret',
    XMPP_DEFAULT_AGENT_JID: config.agentJid,
    OPENFIRE_REST_SECRET: process.env.OPENFIRE_REST_SECRET || 'e2e-rest-secret',
    ORCHESTRATOR_API_SECRET: orchestratorSecret,
    ORCHESTRATOR_PORT: orchestratorPort,
  };

  console.log('[e2e-orch] starting NanoClaw host...');
  await freePort(Number(config.bridgePort));
  const hostProc = spawnLogged('host', 'node', [TSX, 'src/index.ts'], sharedEnv);
  await waitForCliSocket(nanoclawDataDir);

  console.log('[e2e-orch] starting orchestrator...');
  await freePort(Number(orchestratorPort));
  const orchestratorProc = spawnLogged(
    'orchestrator',
    'node',
    [TSX, 'packages/orchestrator/src/server.ts'],
    sharedEnv,
  );
  await waitForHealth(orchestratorUrl);

  return {
    config,
    gatewayProc: gateway.proc,
    hostProc,
    orchestratorProc,
    nanoclawDataDir,
    orchestratorUrl,
    orchestratorSecret,
  };
}

export async function stopOrchestratorE2eStack(stack: OrchestratorE2eStack): Promise<void> {
  await stopChild(stack.orchestratorProc);
  await stopChild(stack.hostProc);
  await stopGateway(stack.gatewayProc);
  if (!process.env.KEEP_E2E) {
    await compose(['down', '-v']).catch(() => undefined);
  }
}
