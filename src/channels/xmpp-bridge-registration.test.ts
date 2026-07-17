import { afterEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../db/index.js';
import { createXmppAgentIdentity } from '../modules/xmpp-agent-gateway/identity.js';
import { createOrchestratorAgent } from '../modules/xmpp-agent-gateway/orchestrator-store.js';
import { getChannelContainerContributions, getRegisteredChannelNames } from './channel-registry.js';

// Import real barrel so registration side effects run.
import './index.js';

describe('xmpp bridge registration', () => {
  afterEach(() => closeDb());

  it('registers xmpp in channel registry', () => {
    expect(getRegisteredChannelNames()).toContain('xmpp');
  });

  it('contributes remote-agent guidance without coupling the runner to XMPP', () => {
    initTestDb();
    runMigrations(getDb());
    createAgentGroup({
      id: 'ag-xmpp',
      name: 'XMPP Agent',
      folder: 'xmpp-agent',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    createXmppAgentIdentity({
      agent_group_id: 'ag-xmpp',
      jid: 'agent@example.org',
      created_at: new Date().toISOString(),
    });

    const contribution = getChannelContainerContributions('ag-xmpp').find(
      (candidate) => candidate.env?.XMPP_AGENT_JID === 'agent@example.org',
    );
    expect(contribution?.promptAddendum).toContain('agents.discover_endpoints');
    expect(contribution?.promptAddendum).toContain('conversation.respond');
  });

  it('centralizes orchestrator spawn env and blocked-host contributions', () => {
    initTestDb();
    runMigrations(getDb());
    createAgentGroup({
      id: 'ag-orchestrated',
      name: 'Orchestrated Agent',
      folder: 'orchestrated-agent',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    createXmppAgentIdentity({
      agent_group_id: 'ag-orchestrated',
      jid: 'orchestrated@example.org',
      created_at: new Date().toISOString(),
    });
    createOrchestratorAgent({
      id: 'orch-1',
      agent_group_id: 'ag-orchestrated',
      tenant_id: 'example.org',
      mock_scenario: null,
      spawn_env: JSON.stringify({ XMPP_AGENT_JID: 'orchestrated@example.org', BLOCKED_HOSTS: 'one.test, two.test' }),
      created_at: new Date().toISOString(),
    });

    expect(getChannelContainerContributions('ag-orchestrated')).toContainEqual(
      expect.objectContaining({
        env: { XMPP_AGENT_JID: 'orchestrated@example.org' },
        blockedHosts: ['one.test', 'two.test'],
      }),
    );
  });
});
