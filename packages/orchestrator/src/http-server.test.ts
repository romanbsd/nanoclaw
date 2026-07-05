import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createOrchestratorAgent,
  getDb,
  initTestDb,
  runMigrations,
} from '../../../src/db/index.js';
import { createOrchestratorServer, startOrchestratorServer } from './http-server.js';

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
      xmpp_jid: 'a@example.org',
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
