import { describe, expect, it, vi } from 'vitest';

import { createOrchestratorServer, startOrchestratorServer } from './http-server.js';
import type { NanoclawAgentHost, NanoclawAgentRecord } from './nanoclaw-host.js';
import type { OpenfireClient } from './openfire-client.js';

function createHost(record?: NanoclawAgentRecord): NanoclawAgentHost {
  return {
    provisionAgent: vi.fn().mockResolvedValue({
      orchestratorId: 'orch-created',
      agentGroupId: 'ag-created',
      folder: 'research',
      messagingGroupId: 'mg-created',
    }),
    deleteAgent: vi.fn().mockResolvedValue(undefined),
    getAgent: vi.fn().mockReturnValue(record),
    listAgents: vi.fn().mockReturnValue(record ? [record] : []),
  };
}

describe('orchestrator http server', () => {
  it('serializes host records without knowing the NanoClaw database shape', async () => {
    const host = createHost({
      orchestratorId: 'orch-1',
      agentGroupId: 'ag-1',
      name: 'A',
      folder: 'a',
      jid: 'a@example.org',
      tenantId: 'example.org',
      mockScenario: null,
      spawnEnv: {},
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const app = await createOrchestratorServer({ nanoclawHost: host });
    const reply = await app.inject({ method: 'GET', url: '/v1/agents/orch-1' });

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ id: 'orch-1', spawnEnv: {} });
    await app.close();
  });

  it('provisions an identity through the injected host', async () => {
    const host = createHost();
    const openfireClient = {
      getUser: vi.fn().mockResolvedValue(false),
      createUser: vi.fn().mockResolvedValue(undefined),
      setVcard: vi.fn().mockResolvedValue(undefined),
      ensureSharedGroup: vi.fn().mockResolvedValue(undefined),
      addUserToGroup: vi.fn().mockResolvedValue(undefined),
      deleteUser: vi.fn().mockResolvedValue(undefined),
    } as unknown as OpenfireClient;
    const app = await createOrchestratorServer({
      nanoclawHost: host,
      openfireClient,
      apiSecret: 'test-secret',
    });
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
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      id: 'orch-created',
      jid: 'research@agents.example.org',
      messagingGroupId: 'mg-created',
    });
    expect(host.provisionAgent).toHaveBeenCalledOnce();
    await app.close();
  });

  it('refuses to bind a non-loopback host without an API secret', async () => {
    const previous = process.env.ORCHESTRATOR_API_SECRET;
    delete process.env.ORCHESTRATOR_API_SECRET;
    try {
      await expect(
        startOrchestratorServer({ nanoclawHost: createHost(), port: 0, host: '0.0.0.0' }),
      ).rejects.toThrow(/non-loopback/);
    } finally {
      if (previous !== undefined) process.env.ORCHESTRATOR_API_SECRET = previous;
    }
  });
});
