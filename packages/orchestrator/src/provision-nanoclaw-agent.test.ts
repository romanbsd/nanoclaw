import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NanoclawAgentHost } from './nanoclaw-host.js';
import type { OpenfireClient } from './openfire-client.js';
import { provisionNanoclawAgent } from './provision-nanoclaw-agent.js';

describe('provisionNanoclawAgent', () => {
  const openfireClient = {
    getUser: vi.fn(),
    createUser: vi.fn(),
    setVcard: vi.fn(),
    ensureSharedGroup: vi.fn(),
    addUserToGroup: vi.fn(),
    deleteUser: vi.fn(),
  };
  const host: NanoclawAgentHost = {
    provisionAgent: vi.fn(),
    deleteAgent: vi.fn(),
    getAgent: vi.fn(),
    listAgents: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    openfireClient.getUser.mockResolvedValue(false);
    openfireClient.createUser.mockResolvedValue(undefined);
    openfireClient.setVcard.mockResolvedValue(undefined);
    openfireClient.ensureSharedGroup.mockResolvedValue(undefined);
    openfireClient.addUserToGroup.mockResolvedValue(undefined);
    openfireClient.deleteUser.mockResolvedValue(undefined);
    vi.mocked(host.provisionAgent).mockResolvedValue({
      orchestratorId: 'orch-1',
      agentGroupId: 'ag-1',
      folder: 'test-agent',
      messagingGroupId: 'mg-1',
    });
  });

  it('provisions the XMPP identity before handing NanoClaw state to the host', async () => {
    const result = await provisionNanoclawAgent(
      {
        name: 'Test Agent',
        agentId: 'test-agent',
        tenantId: 'example.org',
        displayName: 'Test Agent',
        provider: 'mock',
        mockScenario: 'accountant',
        spawnEnv: { MOCK_ACCOUNTANT_JID: 'other@example.org' },
      },
      {
        host,
        openfireClient: openfireClient as unknown as OpenfireClient,
        baseDomain: 'example.org',
      },
    );

    expect(result).toEqual({
      orchestratorId: 'orch-1',
      agentGroupId: 'ag-1',
      folder: 'test-agent',
      messagingGroupId: 'mg-1',
      jid: 'test-agent@example.org',
      password: expect.any(String),
    });
    expect(host.provisionAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        jid: 'test-agent@example.org',
        tenantId: 'example.org',
        agentApiManifest: expect.objectContaining({
          operations: [expect.objectContaining({ name: 'conversation.respond' })],
          agent: expect.objectContaining({ jid: 'test-agent@example.org' }),
        }),
      }),
    );
  });

  it('deletes the XMPP identity when host provisioning fails', async () => {
    vi.mocked(host.provisionAgent).mockRejectedValueOnce(new Error('host failed'));

    await expect(
      provisionNanoclawAgent(
        {
          name: 'Fail Agent',
          agentId: 'fail-agent',
          tenantId: 'example.org',
          displayName: 'Fail Agent',
        },
        {
          host,
          openfireClient: openfireClient as unknown as OpenfireClient,
        },
      ),
    ).rejects.toThrow('host failed');

    expect(openfireClient.deleteUser).toHaveBeenCalledWith('fail-agent');
  });
});
