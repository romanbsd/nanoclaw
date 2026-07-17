import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDb,
  getAgentGroup,
  getAgentGroupByFolder,
  getContainerConfig,
  getDb,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { getOrchestratorAgentByGroupId } from './orchestrator-store.js';
import { getAgentGroupByXmppJid, getXmppAgentIdentity } from './identity.js';
import { NanoclawXmppAgentHost } from './orchestrator-host.js';

function manifest(jid: string) {
  return {
    specVersion: 'urn:solstice:agent-api:1' as const,
    capabilities: {},
    operations: [
      {
        name: 'conversation.respond',
        description: 'Respond.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
    agent: { jid, name: 'agent', title: 'Agent', version: '1.0.0' },
  };
}

describe('NanoclawXmppAgentHost', () => {
  const host = new NanoclawXmppAgentHost();

  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
  });

  afterEach(() => closeDb());

  it('owns NanoClaw provisioning, reads, and cleanup behind one boundary', async () => {
    const result = await host.provisionAgent({
      name: 'Test Agent',
      agentId: 'test-agent',
      tenantId: 'example.org',
      displayName: 'Test Agent',
      jid: 'test-agent@example.org',
      provider: 'mock',
      model: 'mock',
      mockScenario: 'accountant',
      spawnEnv: { MOCK_ACCOUNTANT_JID: 'other@example.org' },
      agentApiManifest: manifest('test-agent@example.org'),
    });

    const group = getAgentGroup(result.agentGroupId);
    expect(group?.name).toBe('Test Agent');
    expect(getXmppAgentIdentity(group!.id)?.jid).toBe('test-agent@example.org');
    expect(getAgentGroupByXmppJid('test-agent@example.org')?.id).toBe(result.agentGroupId);
    expect(getContainerConfig(result.agentGroupId)?.provider).toBe('mock');

    const messagingGroup = getMessagingGroupByPlatform('xmpp', 'test-agent@example.org', 'xmpp');
    expect(messagingGroup?.id).toBe(result.messagingGroupId);
    expect(getMessagingGroupAgentByPair(result.messagingGroupId, result.agentGroupId)).toBeDefined();
    expect(getOrchestratorAgentByGroupId(result.agentGroupId)?.mock_scenario).toBe('accountant');
    expect(host.getAgent(result.orchestratorId)?.spawnEnv).toMatchObject({
      XMPP_AGENT_JID: 'test-agent@example.org',
      MOCK_ACCOUNTANT_JID: 'other@example.org',
    });

    await host.deleteAgent(result.orchestratorId);
    expect(host.getAgent(result.orchestratorId)).toBeUndefined();
    expect(getAgentGroup(result.agentGroupId)).toBeUndefined();
  });

  it('rolls back every NanoClaw side effect when manifest registration fails', async () => {
    await expect(
      host.provisionAgent({
        name: 'Fail Agent',
        agentId: 'fail-agent',
        tenantId: 'example.org',
        displayName: 'Fail Agent',
        jid: 'fail-agent@example.org',
        provider: 'mock',
        agentApiManifest: {
          ...manifest('fail-agent@example.org'),
          operations: [
            {
              name: 'broken',
              description: 'Invalid non-object input root.',
              inputSchema: { type: 'string' },
            },
          ],
        },
      }),
    ).rejects.toThrow('inputSchema must have an object root');

    expect(getAgentGroupByFolder('fail-agent')).toBeUndefined();
    expect(getAgentGroupByXmppJid('fail-agent@example.org')).toBeUndefined();
    expect(getMessagingGroupByPlatform('xmpp', 'fail-agent@example.org', 'xmpp')).toBeUndefined();
  });
});
