/**
 * Post-start Openfire bootstrap for E2E via admin console (curl + cookie jar).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const OPENFIRE_URL = process.env.OPENFIRE_URL || 'http://127.0.0.1:9090';
const ADMIN_USER = process.env.OPENFIRE_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.OPENFIRE_ADMIN_PASS || 'admin';
const COMPONENT_SECRET = process.env.XMPP_COMPONENT_SECRET || 'component-secret';
const XMPP_DOMAIN = process.env.XMPP_DOMAIN || 'example.org';
const PINGER_USER = process.env.XMPP_PINGER_USER || 'john';
const PINGER_PASS = process.env.XMPP_PINGER_PASS || 'secret';

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

async function waitForAdmin(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { stdout, code } = await run('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `${OPENFIRE_URL}/login.jsp`]);
    if (code === 0 && (stdout.trim() === '200' || stdout.trim() === '302')) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Openfire admin not ready at ${OPENFIRE_URL}`);
}

function extractCsrf(html: string): string {
  const patterns = [
    /name="csrf"\s+value="([^"]+)"/,
    /name='csrf'\s+value='([^']+)'/,
    /name="csrf"\s+content="([^"]+)"/,
  ];
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m) return m[1];
  }
  throw new Error(`CSRF token not found (page length ${html.length})`);
}

async function curlAdmin(cookieJar: string, args: string[]): Promise<string> {
  const { stdout, stderr, code } = await run('curl', ['-sS', '-b', cookieJar, '-c', cookieJar, ...args]);
  if (code !== 0) throw new Error(`curl failed: ${stderr}`);
  return stdout;
}

async function login(cookieJar: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const loginHtml = await curlAdmin(cookieJar, [`${OPENFIRE_URL}/login.jsp`]);
    try {
      const csrf = extractCsrf(loginHtml);
      await curlAdmin(cookieJar, [
        '-X',
        'POST',
        `${OPENFIRE_URL}/login.jsp`,
        '-H',
        'Content-Type: application/x-www-form-urlencoded',
        '--data',
        new URLSearchParams({ login: 'true', csrf, username: ADMIN_USER, password: ADMIN_PASS }).toString(),
      ]);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('Openfire admin login failed');
}

async function ensureComponentSecret(cookieJar: string): Promise<void> {
  const page = await curlAdmin(cookieJar, [`${OPENFIRE_URL}/connection-settings-external-components.jsp`]);
  if (page.includes(`id="defaultSecret" value="${COMPONENT_SECRET}"`)) {
    console.log('[bootstrap] external component default secret already set');
    return;
  }
  const csrf = extractCsrf(page);
  await curlAdmin(cookieJar, [
    '-X',
    'POST',
    `${OPENFIRE_URL}/connection-settings-external-components.jsp`,
    '-H',
    'Content-Type: application/x-www-form-urlencoded',
    '--data',
    new URLSearchParams({
      csrf,
      defaultSecret: COMPONENT_SECRET,
      permissionFilter: 'blacklist',
      permissionUpdate: 'Save Settings',
    }).toString(),
  ]);
  const verify = await curlAdmin(cookieJar, [`${OPENFIRE_URL}/connection-settings-external-components.jsp`]);
  if (!verify.includes(`id="defaultSecret" value="${COMPONENT_SECRET}"`)) {
    throw new Error('failed to set external component default secret');
  }
  console.log('[bootstrap] set external component default secret');
}

async function ensurePinger(cookieJar: string): Promise<void> {
  const props = await curlAdmin(cookieJar, [`${OPENFIRE_URL}/user-properties.jsp?username=${PINGER_USER}`]);
  if (props.includes(`value="${PINGER_USER}"`) || props.includes(`>${PINGER_USER}<`)) {
    console.log(`[bootstrap] ${PINGER_USER} user already exists (demoboot)`);
    return;
  }
  const createPage = await curlAdmin(cookieJar, [`${OPENFIRE_URL}/user-create.jsp`]);
  const csrf = extractCsrf(createPage);
  await curlAdmin(cookieJar, [
    `${OPENFIRE_URL}/user-create.jsp?${new URLSearchParams({
      csrf,
      username: PINGER_USER,
      name: 'Ping Client',
      email: `${PINGER_USER}@${XMPP_DOMAIN}`,
      password: PINGER_PASS,
      passwordConfirm: PINGER_PASS,
      create: 'Create User',
    }).toString()}`,
  ]);
  const verifyProps = await curlAdmin(cookieJar, [`${OPENFIRE_URL}/user-properties.jsp?username=${PINGER_USER}`]);
  if (!verifyProps.includes(`value="${PINGER_USER}"`) && !verifyProps.includes(`>${PINGER_USER}<`)) {
    throw new Error(`failed to create ${PINGER_USER} user`);
  }
  console.log(`[bootstrap] created ${PINGER_USER} user`);
}

async function main(): Promise<void> {
  const cookieJar = path.join(os.tmpdir(), `openfire-e2e-${Date.now()}.cookies`);
  await fs.writeFile(cookieJar, '');
  console.log(`[bootstrap] waiting for Openfire at ${OPENFIRE_URL}`);
  await waitForAdmin();
  await login(cookieJar);
  console.log('[bootstrap] admin login ok');
  await ensureComponentSecret(cookieJar);
  await ensurePinger(cookieJar);
  console.log('[bootstrap] done');
  await fs.unlink(cookieJar).catch(() => undefined);
}

main().catch((err) => {
  console.error('[bootstrap] failed:', err);
  process.exit(1);
});
