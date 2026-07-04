/**
 * Shared Openfire + gateway + mock-bridge stack for integration E2E tests.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type http from 'node:http';
import { fileURLToPath } from 'node:url';

import { resetMockBridge, startMockBridge } from './mock-bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(__dirname, '../../..');
export const COMPOSE_FILE = path.join(__dirname, 'docker-compose.yml');
const GATEWAY_ENTRY = path.join(REPO_ROOT, 'packages/agent-xmpp/gateway/dist/index.js');

export interface E2eStackConfig {
  xmppDomain: string;
  openfireUrl: string;
  gatewayUrl: string;
  xmppService: string;
  bridgePort: string;
  gatewayPort: string;
  componentPort: string;
  xmppPort: string;
  agentJid: string;
  pingerJid: string;
  gatewayJid: string;
  gatewayDataDir: string;
}

export function e2eConfig(): E2eStackConfig {
  const xmppDomain = process.env.XMPP_DOMAIN || 'example.org';
  const xmppPort = process.env.E2E_XMPP_PORT || '15222';
  const gatewayPort = process.env.E2E_GATEWAY_PORT || '19220';
  const bridgePort = process.env.E2E_BRIDGE_PORT || '19221';
  return {
    xmppDomain,
    openfireUrl: process.env.OPENFIRE_URL || `http://127.0.0.1:${process.env.E2E_OPENFIRE_ADMIN_PORT || '19090'}`,
    gatewayUrl: process.env.XMPP_GATEWAY_URL || `http://127.0.0.1:${gatewayPort}`,
    xmppService: process.env.XMPP_SERVICE || `xmpp://127.0.0.1:${xmppPort}`,
    bridgePort,
    gatewayPort,
    componentPort: process.env.E2E_COMPONENT_PORT || '15275',
    xmppPort,
    agentJid: process.env.XMPP_DEFAULT_AGENT_JID || `assistant@${xmppDomain}`,
    pingerJid: process.env.XMPP_PINGER_JID || `john@${xmppDomain}`,
    gatewayJid: process.env.XMPP_GATEWAY_JID || `gateway.${xmppDomain}`,
    gatewayDataDir: path.join(__dirname, '.data', 'xmpp-gateway'),
  };
}

export interface E2eStack {
  config: E2eStackConfig;
  gatewayProc: ChildProcess;
  bridgeServer: http.Server;
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function curlStatus(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', url]);
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', (code) => resolve(code === 0 ? stdout.trim() : null));
  });
}

export async function waitForTcp(port: number, host = '127.0.0.1', timeoutMs = 120_000): Promise<void> {
  const net = await import('node:net');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host }, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`TCP port not ready: ${host}:${port}`);
}

export async function waitForUrl(url: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await curlStatus(url);
    if (status === '200' || status === '302') return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`URL not ready: ${url}`);
}

/** Kill any process listening on a TCP port (stale E2E runs). */
export async function freePort(port: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn('sh', ['-c', `lsof -ti :${port} | xargs kill -9 2>/dev/null || true`]);
    child.on('exit', () => resolve());
  });
  await new Promise((r) => setTimeout(r, 300));
}

async function compose(args: string[]): Promise<void> {
  await run('docker', ['compose', '-f', COMPOSE_FILE, ...args], { cwd: __dirname });
}

function startGateway(config: E2eStackConfig): { proc: ChildProcess; online: Promise<void> } {
  const env = {
    ...process.env,
    XMPP_COMPONENT_JID: config.gatewayJid,
    XMPP_AGENT_DOMAIN: config.xmppDomain,
    XMPP_COMPONENT_SERVICE: `xmpp://127.0.0.1:${config.componentPort}`,
    XMPP_COMPONENT_SECRET: 'component-secret',
    XMPP_DEFAULT_AGENT_JID: config.agentJid,
    XMPP_GATEWAY_PORT: config.gatewayPort,
    XMPP_BRIDGE_WEBHOOK_URL: `http://127.0.0.1:${config.bridgePort}/internal/xmpp/inbound`,
    XMPP_BRIDGE_WEBHOOK_SECRET: 'dev-secret',
    XMPP_GATEWAY_DATA_DIR: config.gatewayDataDir,
  };
  const child = spawn('node', [GATEWAY_ENTRY], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (buf) => process.stdout.write(`[gateway] ${buf}`));
  child.stderr?.on('data', (buf) => process.stderr.write(`[gateway] ${buf}`));

  const online = new Promise<void>((resolve, reject) => {
    const onData = (buf: Buffer) => {
      if (buf.toString().includes('component online:')) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`gateway exited before component online (code ${code})`));
    };
    const cleanup = () => {
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', onExit);
  });

  return { proc: child, online };
}

async function stopGateway(child: ChildProcess | null): Promise<void> {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function startE2eStack(): Promise<E2eStack> {
  const config = e2eConfig();
  process.env.E2E_XMPP_PORT = config.xmppPort;
  process.env.E2E_COMPONENT_PORT = config.componentPort;
  process.env.E2E_OPENFIRE_ADMIN_PORT = process.env.E2E_OPENFIRE_ADMIN_PORT || '19090';
  process.env.E2E_GATEWAY_PORT = config.gatewayPort;
  process.env.E2E_BRIDGE_PORT = config.bridgePort;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  if (!process.env.KEEP_E2E) {
    await compose(['down', '-v']);
  }
  await fs.rm(config.gatewayDataDir, { recursive: true, force: true }).catch(() => undefined);

  console.log('[e2e] starting Openfire...');
  await compose(['up', '-d', 'openfire']);
  await waitForUrl(`${config.openfireUrl}/login.jsp`);
  await waitForTcp(Number(config.xmppPort));
  await new Promise((r) => setTimeout(r, 15000));

  console.log('[e2e] bootstrapping Openfire (component secret)...');
  await run('node', [path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(__dirname, 'bootstrap-openfire.ts')], {
    env: {
      ...process.env,
      OPENFIRE_URL: config.openfireUrl,
      XMPP_DOMAIN: config.xmppDomain,
      E2E_HTTP_BIND_PORT: process.env.E2E_HTTP_BIND_PORT || '17070',
    },
  });

  console.log('[e2e] starting gateway...');
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

  resetMockBridge();
  process.env.XMPP_BRIDGE_WEBHOOK_PORT = config.bridgePort;
  process.env.XMPP_GATEWAY_URL = config.gatewayUrl;
  process.env.XMPP_DOMAIN = config.xmppDomain;
  process.env.XMPP_DEFAULT_AGENT_JID = config.agentJid;
  process.env.XMPP_PINGER_JID = config.pingerJid;
  let bridgeServer: http.Server;
  try {
    bridgeServer = await startMockBridge();
  } catch (err) {
    await stopGateway(gateway.proc);
    throw err;
  }
  await new Promise((r) => setTimeout(r, 1500));

  return { config, gatewayProc: gateway.proc, bridgeServer };
}

export async function stopE2eStack(stack: E2eStack): Promise<void> {
  await stopGateway(stack.gatewayProc);
  await new Promise<void>((resolve) => stack.bridgeServer.close(() => resolve()));
  if (!process.env.KEEP_E2E) {
    await compose(['down', '-v']).catch(() => undefined);
  }
}
