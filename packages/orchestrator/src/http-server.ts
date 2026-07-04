import Fastify from 'fastify';

import { getAgentGroup } from '../../../src/db/index.js';
import { deleteNanoclawAgent } from './delete-agent.js';
import { getOrchestratorAgent, listOrchestratorAgents } from '../../../src/db/orchestrator-agents.js';
import {
  provisionNanoclawAgent,
  type ProvisionNanoclawAgentRequest,
} from './provision-nanoclaw-agent.js';
import type { OpenfireClient } from './openfire-client.js';

export interface OrchestratorServerOptions {
  port?: number;
  host?: string;
  apiSecret?: string;
  openfireClient?: OpenfireClient;
  gatewayUrl?: string;
}

function checkAuth(authHeader: string | undefined, secret: string | undefined): boolean {
  if (!secret) return true;
  return authHeader === `Bearer ${secret}`;
}

export async function createOrchestratorServer(options: OrchestratorServerOptions = {}) {
  const app = Fastify({ logger: true });
  const apiSecret = options.apiSecret || process.env.ORCHESTRATOR_API_SECRET;

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return;
    if (!checkAuth(req.headers.authorization, apiSecret)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/health', async () => ({ ok: true }));

  app.get('/v1/agents', async () => {
    const rows = listOrchestratorAgents();
    return {
      agents: rows.map((row) => {
        const group = getAgentGroup(row.agent_group_id);
        return {
          id: row.id,
          agentGroupId: row.agent_group_id,
          name: group?.name ?? null,
          folder: group?.folder ?? null,
          jid: row.xmpp_jid,
          tenantId: row.tenant_id,
          mockScenario: row.mock_scenario,
          createdAt: row.created_at,
        };
      }),
    };
  });

  app.get<{ Params: { id: string } }>('/v1/agents/:id', async (req, reply) => {
    const row = getOrchestratorAgent(req.params.id);
    if (!row) return reply.status(404).send({ error: 'not found' });
    const group = getAgentGroup(row.agent_group_id);
    return {
      id: row.id,
      agentGroupId: row.agent_group_id,
      name: group?.name ?? null,
      folder: group?.folder ?? null,
      jid: row.xmpp_jid,
      tenantId: row.tenant_id,
      mockScenario: row.mock_scenario,
      spawnEnv: JSON.parse(row.spawn_env) as Record<string, string>,
      createdAt: row.created_at,
    };
  });

  app.post<{ Body: ProvisionNanoclawAgentRequest }>('/v1/agents', async (req, reply) => {
    try {
      const result = await provisionNanoclawAgent(req.body, {
        openfireClient: options.openfireClient,
        gatewayUrl: options.gatewayUrl,
        baseDomain: req.body.tenantId,
      });
      return reply.status(201).send({
        id: result.orchestratorId,
        agentGroupId: result.agentGroupId,
        folder: result.folder,
        jid: result.jid,
        messagingGroupId: result.messagingGroupId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: message });
    }
  });

  app.delete<{ Params: { id: string } }>('/v1/agents/:id', async (req, reply) => {
    try {
      await deleteNanoclawAgent(req.params.id, {
        openfireClient: options.openfireClient,
        gatewayUrl: options.gatewayUrl,
      });
      return reply.status(204).send();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found')) {
        return reply.status(404).send({ error: message });
      }
      return reply.status(400).send({ error: message });
    }
  });

  return app;
}

export async function startOrchestratorServer(options: OrchestratorServerOptions = {}) {
  const app = await createOrchestratorServer(options);
  const port = options.port ?? Number(process.env.ORCHESTRATOR_PORT || '19300');
  const host = options.host ?? process.env.ORCHESTRATOR_HOST ?? '127.0.0.1';
  await app.listen({ port, host });
  return app;
}
