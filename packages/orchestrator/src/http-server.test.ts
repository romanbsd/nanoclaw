import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createOrchestratorAgent,
  getDb,
  getMessagingGroupByPlatform,
  getOrchestratorAgent,
  initTestDb,
  runMigrations,
} from '../../../src/db/index.js';
import { createOrchestratorServer, startOrchestratorServer } from './http-server.js';
import type { OpenfireClient } from './openfire-client.js';
import { removeAgentGroupFolder } from './provision-nanoclaw-agent.js';

describe('orchestrator http server', () => {
  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
  });

  afterEach(() => {
    closeDb();
  });

  it('does not 500 when spawn_env is malformed', async () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'A',
      folder: 'a',
      agent_provider: null,
      xmpp_jid: 'a@example.org',
      created_at: '2026-01-01',
    });
    createOrchestratorAgent({
      id: 'orch-1',
      agent_group_id: 'ag-1',
      tenant_id: 'example.org',
      mock_scenario: null,
      spawn_env: 'not-json',
      created_at: '2026-01-01',
    });

    const app = await createOrchestratorServer();
    const reply = await app.inject({ method: 'GET', url: '/v1/agents/orch-1' });
    expect(reply.statusCode).toBe(200);
    expect(reply.json().spawnEnv).toEqual({});
    await app.close();
  });

  it('provisions a mailbox-wired multi-agent identity through the API', async () => {
    const openfireClient = {
      getUser: vi.fn().mockResolvedValue(false),
      createUser: vi.fn().mockResolvedValue(undefined),
      setVcard: vi.fn().mockResolvedValue(undefined),
      ensureSharedGroup: vi.fn().mockResolvedValue(undefined),
      addUserToGroup: vi.fn().mockResolvedValue(undefined),
      deleteUser: vi.fn().mockResolvedValue(undefined),
    } as unknown as OpenfireClient;
    const app = await createOrchestratorServer({ openfireClient, apiSecret: 'test-secret' });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { authorization: 'Bearer test-secret' },
      payload: {
        name: 'Research Agent',
        agentId: 'research',
        tenantId: 'agents.example.org',
        displayName: 'Research',
        provider: 'mock',
        agentApiManifest: {
          specVersion: 'urn:businessos:agent-api:1',
          capabilities: { structuredOutput: true },
          operations: [{
            name: 'research.lookup',
            description: 'Look up a topic.',
            inputSchema: { type: 'object', required: ['topic'], properties: { topic: { type: 'string' } } },
            outputSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } },
          }],
        },
      },
    });
    expect(response.statusCode).toBe(201);
    const created = response.json() as { id: string; folder: string; jid: string; messagingGroupId: string };
    expect(created.jid).toBe('research@agents.example.org');
    expect(getMessagingGroupByPlatform('xmpp', created.jid, 'xmpp')?.id).toBe(created.messagingGroupId);
    const record = getOrchestratorAgent(created.id);
    expect(record?.spawn_env).not.toContain('XMPP_GATEWAY_URL');
    expect(openfireClient.createUser).toHaveBeenCalledOnce();
    removeAgentGroupFolder(created.folder);
    await app.close();
  });

  it('refuses to bind a non-loopback host without an API secret', async () => {
    const prev = process.env.ORCHESTRATOR_API_SECRET;
    delete process.env.ORCHESTRATOR_API_SECRET;
    try {
      await expect(startOrchestratorServer({ host: '0.0.0.0', port: 0 })).rejects.toThrow(/non-loopback/);
    } finally {
      if (prev !== undefined) process.env.ORCHESTRATOR_API_SECRET = prev;
    }
  });
});
