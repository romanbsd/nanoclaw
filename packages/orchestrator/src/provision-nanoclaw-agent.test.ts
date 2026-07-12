import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  getAgentGroup,
  getAgentGroupByFolder,
  getAgentGroupByXmppJid,
  getContainerConfig,
  getDb,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
  getOrchestratorAgentByGroupId,
  initTestDb,
  runMigrations,
} from '../../../src/db/index.js';
import { OpenfireClient } from './openfire-client.js';
import { provisionNanoclawAgent, removeAgentGroupFolder } from './provision-nanoclaw-agent.js';

describe('provisionNanoclawAgent', () => {
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
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '',
      }),
    );
    mockClient.getUser.mockResolvedValue(false);
    mockClient.createUser.mockResolvedValue(undefined);
    mockClient.setVcard.mockResolvedValue(undefined);
    mockClient.ensureSharedGroup.mockResolvedValue(undefined);
    mockClient.addUserToGroup.mockResolvedValue(undefined);
    initTestDb();
    runMigrations(getDb());
  });

  afterEach(() => {
    closeDb();
  });

  it('creates agent group, container config, xmpp wiring, and orchestrator row', async () => {
    const result = await provisionNanoclawAgent(
      {
        name: 'Test Agent',
        agentId: 'test-agent',
        tenantId: 'example.org',
        displayName: 'Test Agent',
        provider: 'mock',
        model: 'mock',
        mockScenario: 'accountant',
        personality: { instructions: 'Be helpful.', assistantName: 'Test' },
        spawnEnv: { MOCK_ACCOUNTANT_JID: 'other@example.org' },
      },
      {
        openfireClient: mockClient as unknown as OpenfireClient,
        baseDomain: 'example.org',
      },
    );

    expect(result.jid).toBe('test-agent@example.org');
    expect(result.agentGroupId).toMatch(/^ag-/);
    expect(result.orchestratorId).toMatch(/^orch-/);

    const group = getAgentGroup(result.agentGroupId);
    expect(group?.name).toBe('Test Agent');
    expect(group?.xmpp_jid).toBe('test-agent@example.org');
    expect(getAgentGroupByXmppJid('test-agent@example.org')?.id).toBe(result.agentGroupId);

    const config = getContainerConfig(result.agentGroupId);
    expect(config?.provider).toBe('mock');
    expect(config?.model).toBe('mock');
    expect(JSON.parse(config!.mcp_servers)).toEqual({});

    const mg = getMessagingGroupByPlatform('xmpp', result.jid, 'xmpp');
    expect(mg).toBeDefined();
    expect(getMessagingGroupAgentByPair(mg!.id, result.agentGroupId)).toBeDefined();

    const orch = getOrchestratorAgentByGroupId(result.agentGroupId);
    expect(orch?.mock_scenario).toBe('accountant');
    const spawnEnv = JSON.parse(orch!.spawn_env) as Record<string, string>;
    expect(spawnEnv.XMPP_AGENT_JID).toBe(result.jid);
    expect(spawnEnv.XMPP_GATEWAY_URL).toBeUndefined();
    expect(spawnEnv.MOCK_SCENARIO).toBe('accountant');
    expect(spawnEnv.MOCK_ACCOUNTANT_JID).toBe('other@example.org');

    removeAgentGroupFolder(result.folder);
  });

  it('rolls back all state and deletes the xmpp user when manifest registration fails', async () => {
    await expect(
      provisionNanoclawAgent(
        {
          name: 'Fail Agent',
          agentId: 'fail-agent',
          tenantId: 'example.org',
          displayName: 'Fail Agent',
          provider: 'mock',
          model: 'mock',
          agentApiManifest: {
            specVersion: 'urn:businessos:agent-api:1',
            capabilities: {},
            operations: [{
              name: 'broken',
              description: 'Invalid non-object input root.',
              inputSchema: { type: 'string' },
            }],
          },
        },
        {
          openfireClient: mockClient as unknown as OpenfireClient,
          baseDomain: 'example.org',
        },
      ),
    ).rejects.toThrow('inputSchema must have an object root');

    // No leaked rows.
    expect(getAgentGroupByFolder('fail-agent')).toBeUndefined();
    expect(getAgentGroupByXmppJid('fail-agent@example.org')).toBeUndefined();
    expect(getMessagingGroupByPlatform('xmpp', 'fail-agent@example.org', 'xmpp')).toBeUndefined();

    // Compensating delete removed the XMPP user created during identity provisioning.
    expect(mockClient.deleteUser).toHaveBeenCalledWith('fail-agent');
  });
});
