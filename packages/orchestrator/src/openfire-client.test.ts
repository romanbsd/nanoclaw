import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenfireClient } from './openfire-client.js';

function res(status: number, body: string): Response {
  return { status, ok: status >= 200 && status < 300, text: async () => body } as unknown as Response;
}

describe('OpenfireClient.getUser', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to admin Basic auth when the secret returns a login redirect', async () => {
    const fetchMock = vi
      .fn()
      // secret auth → 302 redirect to login.jsp (isAuthRedirect)
      .mockResolvedValueOnce(res(302, ''))
      // admin Basic retry → user exists
      .mockResolvedValueOnce(res(200, JSON.stringify({ username: 'agent' })));
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenfireClient({
      baseUrl: 'http://of:9090',
      restSecret: 'stale-secret',
      adminUser: 'admin',
      adminPassword: 'pw',
    });

    // Without the fallback this returns false → provision would try to recreate an existing user.
    await expect(client.getUser('agent')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondAuth = (fetchMock.mock.calls[1][1] as { headers: Record<string, string> }).headers.Authorization;
    expect(secondAuth).toBe(`Basic ${Buffer.from('admin:pw').toString('base64')}`);
  });

  it('does not fall back when no admin creds are configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(302, ''));
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenfireClient({ baseUrl: 'http://of:9090', restSecret: 'stale-secret' });

    await expect(client.getUser('agent')).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
