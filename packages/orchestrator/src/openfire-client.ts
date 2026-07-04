export interface OpenfireClientConfig {
  baseUrl: string;
  /** Shared secret for Authorization header (REST API plugin). */
  restSecret?: string;
  /** Fallback: admin basic auth when secret is not configured yet. */
  adminUser?: string;
  adminPassword?: string;
}

export class OpenfireRestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'OpenfireRestError';
  }
}

export class OpenfireClient {
  private readonly apiBase: string;

  constructor(private readonly config: OpenfireClientConfig) {
    const trimmed = config.baseUrl.replace(/\/$/, '');
    this.apiBase = `${trimmed}/plugins/restapi/v1`;
  }

  private headers(contentType?: string): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.config.restSecret) {
      // OpenFire REST plugin expects the raw shared secret, not Bearer/Basic prefix.
      h.Authorization = this.config.restSecret;
    } else if (this.config.adminUser && this.config.adminPassword) {
      const token = Buffer.from(`${this.config.adminUser}:${this.config.adminPassword}`).toString('base64');
      h.Authorization = `Basic ${token}`;
    } else {
      throw new Error('OpenfireClient requires OPENFIRE_REST_SECRET or admin credentials');
    }
    if (contentType) h['Content-Type'] = contentType;
    return h;
  }

  async request(method: string, path: string, body?: string, contentType?: string): Promise<Response> {
    const url = `${this.apiBase}${path.startsWith('/') ? path : `/${path}`}`;
    const res = await fetch(url, {
      method,
      // Do not follow redirects — OpenFire returns 302→login.jsp when REST is disabled or auth fails.
      redirect: 'manual',
      headers: this.headers(contentType),
      body,
    });
    return res;
  }

  private async readBody(res: Response): Promise<string> {
    return res.text();
  }

  private isAuthRedirect(res: Response, body: string): boolean {
    // REST plugin returns 302 or HTML login page when secret is wrong or plugin is disabled.
    return (res.status >= 300 && res.status < 400) || body.includes('<html');
  }

  async requestOk(method: string, path: string, body?: string, contentType?: string): Promise<void> {
    const res = await this.request(method, path, body, contentType);
    const text = await this.readBody(res);
    if (res.ok && !this.isAuthRedirect(res, text)) return;

    // Retry with admin Basic auth only when REST secret auth fails. Useless once bootstrap sets authtype=secret.
    if (this.config.restSecret && this.config.adminUser && this.config.adminPassword) {
      const fallback = new OpenfireClient({
        baseUrl: this.config.baseUrl,
        adminUser: this.config.adminUser,
        adminPassword: this.config.adminPassword,
      });
      const retry = await fallback.request(method, path, body, contentType);
      const retryText = await fallback.readBody(retry);
      if (retry.ok && !fallback.isAuthRedirect(retry, retryText)) return;
      throw new OpenfireRestError(`OpenFire REST ${method} ${path} failed: ${retry.status}`, retry.status, retryText);
    }

    throw new OpenfireRestError(`OpenFire REST ${method} ${path} failed: ${res.status}`, res.status, text);
  }

  async getUser(username: string): Promise<boolean> {
    const res = await this.request('GET', `/users/${encodeURIComponent(username)}`, undefined, 'application/json');
    const text = await this.readBody(res);
    if (res.status === 404) return false;
    if (!res.ok || this.isAuthRedirect(res, text)) return false;
    try {
      const data = JSON.parse(text) as { username?: string; user?: { username?: string } };
      return data.username === username || data.user?.username === username;
    } catch {
      return text.includes(username);
    }
  }

  async createUser(username: string, password: string, name: string, email: string): Promise<void> {
    await this.requestOk(
      'POST',
      '/users',
      JSON.stringify({ username, password, name, email }),
      'application/json',
    );
  }

  async deleteUser(username: string): Promise<void> {
    const path = `/users/${encodeURIComponent(username)}`;
    const res = await this.request('DELETE', path);
    const text = await this.readBody(res);
    if ((res.status === 200 || res.status === 204 || res.status === 404) && !this.isAuthRedirect(res, text)) {
      return;
    }

    if (this.config.restSecret && this.config.adminUser && this.config.adminPassword) {
      const fallback = new OpenfireClient({
        baseUrl: this.config.baseUrl,
        adminUser: this.config.adminUser,
        adminPassword: this.config.adminPassword,
      });
      const retry = await fallback.request('DELETE', path);
      const retryText = await fallback.readBody(retry);
      if (
        (retry.status === 200 || retry.status === 204 || retry.status === 404) &&
        !fallback.isAuthRedirect(retry, retryText)
      ) {
        return;
      }
      throw new OpenfireRestError(`OpenFire REST DELETE user failed: ${retry.status}`, retry.status, retryText);
    }

    throw new OpenfireRestError(`OpenFire REST DELETE user failed: ${res.status}`, res.status, text);
  }

  async setVcard(username: string, vcardXml: string): Promise<void> {
    const res = await this.request('PUT', `/users/${encodeURIComponent(username)}/vcard`, vcardXml, 'application/xml');
    if (res.ok) return;
    if (res.status === 405 || res.status === 404 || res.status === 415) {
      // Some Openfire builds omit vCard REST until the user profile is touched; display name is on the user record.
      return;
    }
    const text = await res.text();
    throw new OpenfireRestError(`OpenFire REST PUT /users/${username}/vcard failed: ${res.status}`, res.status, text);
  }

  async ensureSharedGroup(groupName: string): Promise<void> {
    const res = await this.request('GET', `/groups/${encodeURIComponent(groupName)}`);
    if (res.status === 200) return;
    if (res.status !== 404) {
      const text = await res.text();
      throw new OpenfireRestError(`OpenFire REST GET group failed: ${res.status}`, res.status, text);
    }
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<group>
  <name>${escapeXml(groupName)}</name>
  <description>${escapeXml(groupName)}</description>
  <isshared>true</isshared>
</group>`;
    await this.requestOk('POST', '/groups', xml, 'application/xml');
  }

  async addUserToGroup(username: string, groupName: string): Promise<void> {
    await this.requestOk(
      'POST',
      `/users/${encodeURIComponent(username)}/groups/${encodeURIComponent(groupName)}`,
    );
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function loadOpenfireConfigFromEnv(): OpenfireClientConfig {
  return {
    baseUrl: process.env.OPENFIRE_URL || 'http://127.0.0.1:9090',
    restSecret: process.env.OPENFIRE_REST_SECRET || undefined,
    adminUser: process.env.OPENFIRE_ADMIN_USER || 'admin',
    adminPassword: process.env.OPENFIRE_ADMIN_PASS || 'admin',
  };
}

/** Resolve bare JID. Flat E2E: tenantId `example.org` → agent@example.org; multi-tenant: acme + example.com → agent@acme.example.com */
export function resolveAgentJid(tenantId: string, agentId: string, baseDomain?: string): string {
  const base = baseDomain || process.env.OPENFIRE_XMPP_BASE_DOMAIN || 'example.org';
  if (tenantId === base || tenantId.includes('.')) {
    const host = tenantId.includes('.') ? tenantId : base;
    return `${agentId}@${host}`;
  }
  return `${agentId}@${tenantId}.${base}`;
}

export function usernameFromJid(jid: string): string {
  return jid.split('@')[0] ?? jid;
}
