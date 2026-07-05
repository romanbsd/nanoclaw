import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  getAgentGroup,
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
        gatewayUrl: 'http://127.0.0.1:9220',
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
    expect(JSON.parse(config!.mcp_servers)).toHaveProperty('xmpp');

    const mg = getMessagingGroupByPlatform('xmpp', result.jid, 'xmpp');
    expect(mg).toBeDefined();
    expect(getMessagingGroupAgentByPair(mg!.id, result.agentGroupId)).toBeDefined();

    const orch = getOrchestratorAgentByGroupId(result.agentGroupId);
    expect(orch?.mock_scenario).toBe('accountant');
    const spawnEnv = JSON.parse(orch!.spawn_env) as Record<string, string>;
    expect(spawnEnv.XMPP_AGENT_JID).toBe(result.jid);
    expect(spawnEnv.MOCK_SCENARIO).toBe('accountant');
    expect(spawnEnv.MOCK_ACCOUNTANT_JID).toBe('other@example.org');

    removeAgentGroupFolder(result.folder);
  });
});
