/**
 * Post-start Openfire bootstrap for E2E via admin console (curl + cookie jar).
 *
 * REST API plugin requires adminConsole.access.allow-wildcards-in-excludes=true
 * (OpenFire 4.7.5+ / CVE-2023-32315) or every /plugins/restapi/* request 302s to login.
 * docker-compose also seeds JVM -D overrides; this script enables REST via rest-api.jsp
 * (no CSRF on that form) and reloads the plugin when the probe still fails.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const OPENFIRE_URL = process.env.OPENFIRE_URL || 'http://127.0.0.1:9090';
const HTTP_BIND_HOST_PORT = process.env.E2E_HTTP_BIND_PORT || '17070';
const ADMIN_USER = process.env.OPENFIRE_ADMIN_USER || process.env.OPENFIRE_E2E_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.OPENFIRE_ADMIN_PASS || process.env.OPENFIRE_E2E_ADMIN_PASS || 'admin';
const REST_SECRET = process.env.OPENFIRE_REST_SECRET || process.env.OPENFIRE_E2E_REST_SECRET || 'e2e-rest-secret';
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

async function waitForPluginPage(cookieJar: string, page: string, timeoutMs = 180_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const html = await curlAdmin(cookieJar, [`${OPENFIRE_URL}/${page}`]);
      if (
        html.includes('name="csrf"') &&
        !html.includes('Plugin not found') &&
        !html.includes('Site unavailable')
      ) {
        return html;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`plugin page not ready: ${page}`);
}

async function ensureHttpBind(cookieJar: string): Promise<void> {
  const page = await curlAdmin(cookieJar, [`${OPENFIRE_URL}/http-bind.jsp`]);
  if (page.includes('name="httpBindEnabled" value="true"') && page.includes('checked')) {
    console.log('[bootstrap] HTTP binding already enabled');
    return;
  }
  const csrf = extractCsrf(page);
  const portMatch = page.match(/name="port"[^>]*value="(\d+)"/);
  const secureMatch = page.match(/name="securePort"[^>]*value="(\d+)"/);
  await curlAdmin(cookieJar, [
    '-X',
    'POST',
    `${OPENFIRE_URL}/http-bind.jsp`,
    '-H',
    'Content-Type: application/x-www-form-urlencoded',
    '--data',
    new URLSearchParams({
      csrf,
      httpBindEnabled: 'true',
      port: portMatch?.[1] || '7070',
      securePort: secureMatch?.[1] || '7443',
      update: 'Save Settings',
    }).toString(),
  ]);
  console.log('[bootstrap] enabled HTTP binding');
}

async function ensureHttpFileUpload(cookieJar: string): Promise<void> {
  const page = await waitForPluginPage(cookieJar, 'plugins/httpfileupload/httpfileupload-settings.jsp');
  const csrf = extractCsrf(page);
  const maxFileSizeMatch = page.match(/name="maxFileSize"[^>]*value="(\d+)"/);
  await curlAdmin(cookieJar, [
    '-X',
    'POST',
    `${OPENFIRE_URL}/plugins/httpfileupload/httpfileupload-settings.jsp`,
    '-H',
    'Content-Type: application/x-www-form-urlencoded',
    '--data',
    new URLSearchParams({
      csrf,
      announcedProtocol: 'http',
      announcedWebHost: '127.0.0.1',
      announcedPort: HTTP_BIND_HOST_PORT,
      announcedContextRoot: '/httpfileupload',
      maxFileSize: maxFileSizeMatch?.[1] || String(10 * 1024 * 1024),
      fileRepo: '',
      update: 'Save Settings',
    }).toString(),
  ]);
  console.log(`[bootstrap] configured HTTP File Upload (http://127.0.0.1:${HTTP_BIND_HOST_PORT}/httpfileupload)`);
}

async function setServerPropertyViaAdmin(
  cookieJar: string,
  propName: string,
  propValue: string,
): Promise<void> {
  const page = await curlAdmin(cookieJar, [`${OPENFIRE_URL}/server-properties.jsp`]);
  // Properties are saved via actionForm (action=save), not the visible propName/propValue fields.
  const csrf =
    page.match(/id="actionForm"[\s\S]*?name="csrf"\s+value="([^"]+)"/)?.[1] ?? extractCsrf(page);
  await curlAdmin(cookieJar, [
    '-X',
    'POST',
    `${OPENFIRE_URL}/server-properties.jsp`,
    '-H',
    'Content-Type: application/x-www-form-urlencoded',
    '--data',
    new URLSearchParams({
      csrf,
      action: 'save',
      key: propName,
      value: propValue,
      encrypt: 'false',
    }).toString(),
  ]);
}

async function fetchRestApiSettingsPage(cookieJar: string): Promise<string> {
  // OpenFire 5.1 REST plugin serves rest-api.jsp under both restAPI/ and restapi/ paths.
  const pages = ['plugins/restAPI/rest-api.jsp', 'plugins/restapi/rest-api.jsp'];
  for (const p of pages) {
    const html = await curlAdmin(cookieJar, [`${OPENFIRE_URL}/${p}`]);
    if (html.includes('name="secret"')) return html;
  }
  throw new Error('REST API settings JSP not found');
}

async function saveRestApiSettings(cookieJar: string): Promise<void> {
  await fetchRestApiSettingsPage(cookieJar);
  for (const settingsPage of ['plugins/restAPI/rest-api.jsp', 'plugins/restapi/rest-api.jsp']) {
    await curlAdmin(cookieJar, [
      '-X',
      'POST',
      `${OPENFIRE_URL}/${settingsPage}?save`,
      '-H',
      'Content-Type: application/x-www-form-urlencoded',
      '--data',
      new URLSearchParams({
        enabled: 'true',
        authtype: 'secret',
        secret: REST_SECRET,
        loggingEnabled: 'false',
      }).toString(),
    ]);
    break;
  }
}

async function reloadRestApiPlugin(cookieJar: string): Promise<void> {
  const page = await curlAdmin(cookieJar, [`${OPENFIRE_URL}/plugin-admin.jsp`]);
  const csrf =
    page.match(/id="actionForm"[\s\S]*?name="csrf"\s+value="([^"]+)"/)?.[1] ??
    page.match(/name="csrf"\s+value="([^"]+)"/)?.[1];
  if (!csrf) return;
  await curlAdmin(cookieJar, [
    '-X',
    'POST',
    `${OPENFIRE_URL}/plugin-admin.jsp`,
    '-H',
    'Content-Type: application/x-www-form-urlencoded',
    '--data',
    new URLSearchParams({ csrf, reloadplugin: 'restapi' }).toString(),
  ]);
}

async function restSecretProbe(): Promise<boolean> {
  const probe = await run('curl', [
    '-s',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    '-H',
    `Authorization: ${REST_SECRET}`,
    `${OPENFIRE_URL}/plugins/restapi/v1/users`,
  ]);
  return probe.code === 0 && probe.stdout.trim() === '200';
}

async function ensureWildcardExcludes(cookieJar: string): Promise<void> {
  const prop = 'adminConsole.access.allow-wildcards-in-excludes';
  const check = await run('curl', [
    '-s',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    '-H',
    `Authorization: ${REST_SECRET}`,
    `${OPENFIRE_URL}/plugins/restapi/v1/system/properties/${encodeURIComponent(prop)}`,
  ]);
  if (check.code === 0 && check.stdout.trim() === '200') {
    console.log('[bootstrap] wildcard excludes property already set');
    return;
  }

  await setServerPropertyViaAdmin(cookieJar, prop, 'true');
  const verify = await run('curl', [
    '-s',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    '-H',
    `Authorization: ${REST_SECRET}`,
    `${OPENFIRE_URL}/plugins/restapi/v1/system/properties/${encodeURIComponent(prop)}`,
  ]);
  if (verify.code === 0 && verify.stdout.trim() === '200') {
    console.log('[bootstrap] set adminConsole.access.allow-wildcards-in-excludes=true');
    return;
  }
  throw new Error(`failed to set wildcard excludes property (HTTP ${verify.stdout.trim()})`);
}

async function ensureRestApiSecret(cookieJar: string): Promise<void> {
  if (await restSecretProbe()) {
    console.log('[bootstrap] REST API shared secret already configured');
    return;
  }

  // Wildcard excludes must be true before REST endpoints are reachable from outside the admin filter.
  await setServerPropertyViaAdmin(cookieJar, 'adminConsole.access.allow-wildcards-in-excludes', 'true');
  await saveRestApiSettings(cookieJar);
  await reloadRestApiPlugin(cookieJar);
  // Plugin reload is async; give Jetty time to re-register auth exclusions.
  await new Promise((r) => setTimeout(r, 5000));

  if (await restSecretProbe()) {
    console.log('[bootstrap] configured REST API shared secret');
    return;
  }
  throw new Error('REST API shared secret not verified after bootstrap');
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
  await ensureHttpBind(cookieJar);
  await ensureHttpFileUpload(cookieJar);
  await ensureRestApiSecret(cookieJar);
  await ensureWildcardExcludes(cookieJar);
  console.log('[bootstrap] done');
  await fs.unlink(cookieJar).catch(() => undefined);
}

main().catch((err) => {
  console.error('[bootstrap] failed:', err);
  process.exit(1);
});
