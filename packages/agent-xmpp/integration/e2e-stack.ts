/** Shared live Openfire harness for embedded-gateway integration tests. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(__dirname, '../../..');
export const COMPOSE_FILE = path.join(__dirname, 'docker-compose.yml');

export interface E2eStackConfig {
  xmppDomain: string;
  openfireUrl: string;
  xmppService: string;
  componentPort: string;
  xmppPort: string;
  pingerJid: string;
  gatewayJid: string;
}

export function e2eConfig(): E2eStackConfig {
  const xmppDomain = process.env.XMPP_DOMAIN || 'example.org';
  const xmppPort = process.env.E2E_XMPP_PORT || '15222';
  return {
    xmppDomain,
    openfireUrl: process.env.OPENFIRE_URL || `http://127.0.0.1:${process.env.E2E_OPENFIRE_ADMIN_PORT || '19090'}`,
    xmppService: process.env.XMPP_SERVICE || `xmpp://127.0.0.1:${xmppPort}`,
    componentPort: process.env.E2E_COMPONENT_PORT || '15275',
    xmppPort,
    pingerJid: process.env.XMPP_PINGER_JID || `john@${xmppDomain}`,
    gatewayJid: process.env.XMPP_GATEWAY_JID || `gateway.${xmppDomain}`,
  };
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: __dirname, env: { ...process.env, ...env }, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function compose(...args: string[]): Promise<void> {
  await run('docker', ['compose', '-f', COMPOSE_FILE, ...args]);
}

async function waitForUrl(url: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise<boolean>((resolve) => {
      const child = spawn('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', url]);
      let status = '';
      child.stdout.on('data', (data) => status += data);
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0 && ['200', '302'].includes(status.trim())));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`URL not ready: ${url}`);
}

export async function runOpenfireBootstrap(config: Pick<E2eStackConfig, 'openfireUrl' | 'xmppDomain'>): Promise<void> {
  console.log('[e2e] bootstrapping Openfire...');
  await run(process.execPath, [path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(__dirname, 'bootstrap-openfire.ts')], {
    OPENFIRE_URL: config.openfireUrl,
    XMPP_DOMAIN: config.xmppDomain,
    E2E_HTTP_BIND_PORT: process.env.E2E_HTTP_BIND_PORT || '17070',
    OPENFIRE_REST_SECRET: process.env.OPENFIRE_REST_SECRET || 'e2e-rest-secret',
  });
}

export async function startOpenfireOnly(): Promise<E2eStackConfig> {
  const config = e2eConfig();
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  if (!process.env.KEEP_E2E) await compose('down', '-v');
  console.log('[e2e] starting Openfire...');
  await compose('up', '-d', 'openfire');
  await waitForUrl(`${config.openfireUrl}/login.jsp`);
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  await runOpenfireBootstrap(config);
  return config;
}

export async function stopOpenfireOnly(): Promise<void> {
  if (!process.env.KEEP_E2E) await compose('down', '-v').catch(() => undefined);
}

/** Stop only the server process while preserving its configured volume. */
export async function stopOpenfireService(): Promise<void> {
  await compose('stop', 'openfire');
}

/** Restart a previously configured server without rerunning destructive bootstrap. */
export async function startOpenfireService(config: Pick<E2eStackConfig, 'openfireUrl'>): Promise<void> {
  await compose('start', 'openfire');
  await waitForUrl(`${config.openfireUrl}/login.jsp`);
}
