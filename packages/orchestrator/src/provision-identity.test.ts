import { describe, expect, it, vi, beforeEach } from 'vitest';

import { OpenfireClient } from './openfire-client.js';
import { provisionAgentIdentity } from './provision-identity.js';
import { resolveAgentJid } from './openfire-client.js';

describe('resolveAgentJid', () => {
  it('flat E2E domain', () => {
    expect(resolveAgentJid('example.org', 'crm', 'example.org')).toBe('crm@example.org');
  });

  it('multi-tenant subdomain', () => {
    expect(resolveAgentJid('acme', 'crm', 'example.com')).toBe('crm@acme.example.com');
  });
});

describe('provisionAgentIdentity', () => {
  const mockClient = {
    getUser: vi.fn(),
    createUser: vi.fn(),
    setVcard: vi.fn(),
    ensureSharedGroup: vi.fn(),
    addUserToGroup: vi.fn(),
    deleteUser: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.getUser.mockResolvedValue(false);
    mockClient.createUser.mockResolvedValue(undefined);
    mockClient.setVcard.mockResolvedValue(undefined);
    mockClient.ensureSharedGroup.mockResolvedValue(undefined);
    mockClient.addUserToGroup.mockResolvedValue(undefined);
    mockClient.deleteUser.mockResolvedValue(undefined);
  });

  it('creates user, vcard, and groups', async () => {
    const result = await provisionAgentIdentity(
      {
        tenantId: 'example.org',
        agentId: 'crm',
        displayName: 'CRM Agent',
        groups: ['Agents', 'Sales'],
      },
      { client: mockClient as unknown as OpenfireClient, baseDomain: 'example.org' },
    );

    expect(result.jid).toBe('crm@example.org');
    expect(result.password.length).toBeGreaterThan(20);
    expect(mockClient.createUser).toHaveBeenCalledWith(
      'crm',
      result.password,
      'CRM Agent',
      'crm@example.org',
    );
    expect(mockClient.setVcard).toHaveBeenCalled();
    expect(mockClient.ensureSharedGroup).toHaveBeenCalledTimes(2);
    expect(mockClient.addUserToGroup).toHaveBeenCalledWith('crm', 'Agents');
  });

  it('rejects existing user', async () => {
    mockClient.getUser.mockResolvedValue(true);
    await expect(
      provisionAgentIdentity(
        { tenantId: 'example.org', agentId: 'crm', displayName: 'CRM Agent' },
        { client: mockClient as unknown as OpenfireClient, baseDomain: 'example.org' },
      ),
    ).rejects.toThrow('already exists');
  });
});
