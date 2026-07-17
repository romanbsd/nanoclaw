import Fastify from 'fastify';

import { deleteNanoclawAgent } from './delete-agent.js';
import { provisionNanoclawAgent, type ProvisionNanoclawAgentRequest } from './provision-nanoclaw-agent.js';
import type { OpenfireClient } from './openfire-client.js';
import type { NanoclawAgentHost } from './nanoclaw-host.js';
import type { AgentXmppNamespaces } from '@agent-xmpp/protocol';

export interface OrchestratorServerOptions {
  nanoclawHost: NanoclawAgentHost;
  port?: number;
  host?: string;
  apiSecret?: string;
  openfireClient?: OpenfireClient;
  protocolNamespaces?: AgentXmppNamespaces;
}

function checkAuth(authHeader: string | undefined, secret: string | undefined): boolean {
  if (!secret) return true;
  return authHeader === `Bearer ${secret}`;
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

export async function createOrchestratorServer(options: OrchestratorServerOptions) {
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
    const rows = options.nanoclawHost.listAgents();
    return {
      agents: rows.map((row) => {
        return {
          id: row.orchestratorId,
          agentGroupId: row.agentGroupId,
          name: row.name,
          folder: row.folder,
          jid: row.jid,
          tenantId: row.tenantId,
          mockScenario: row.mockScenario,
          createdAt: row.createdAt,
        };
      }),
    };
  });

  app.get<{ Params: { id: string } }>('/v1/agents/:id', async (req, reply) => {
    const row = options.nanoclawHost.getAgent(req.params.id);
    if (!row) return reply.status(404).send({ error: 'not found' });
    return {
      id: row.orchestratorId,
      agentGroupId: row.agentGroupId,
      name: row.name,
      folder: row.folder,
      jid: row.jid,
      tenantId: row.tenantId,
      mockScenario: row.mockScenario,
      spawnEnv: row.spawnEnv,
      createdAt: row.createdAt,
    };
  });

  app.post<{ Body: ProvisionNanoclawAgentRequest }>('/v1/agents', async (req, reply) => {
    try {
      const result = await provisionNanoclawAgent(req.body, {
        host: options.nanoclawHost,
        openfireClient: options.openfireClient,
        baseDomain: req.body.tenantId,
        protocolNamespaces: options.protocolNamespaces,
      });
      return reply.status(201).send({
        id: result.orchestratorId,
        agentGroupId: result.agentGroupId,
        folder: result.folder,
        jid: result.jid,
        messagingGroupId: result.messagingGroupId,
      });
      // eslint-disable-next-line no-catch-all/no-catch-all -- map provision errors to HTTP 400
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: message });
    }
  });

  app.delete<{ Params: { id: string } }>('/v1/agents/:id', async (req, reply) => {
    try {
      await deleteNanoclawAgent(req.params.id, {
        host: options.nanoclawHost,
        openfireClient: options.openfireClient,
      });
      return reply.status(204).send();
      // eslint-disable-next-line no-catch-all/no-catch-all -- map delete errors to HTTP 4xx
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

export async function startOrchestratorServer(options: OrchestratorServerOptions) {
  const app = await createOrchestratorServer(options);
  const port = options.port ?? Number(process.env.ORCHESTRATOR_PORT || '19300');
  const host = options.host ?? process.env.ORCHESTRATOR_HOST ?? '127.0.0.1';
  const apiSecret = options.apiSecret || process.env.ORCHESTRATOR_API_SECRET;
  // Fail closed: an unauthenticated server may only bind loopback. On any routable
  // interface a missing secret would expose provision/delete to the network.
  if (!apiSecret && !isLoopbackHost(host)) {
    throw new Error(`orchestrator refuses to bind non-loopback host ${host} without ORCHESTRATOR_API_SECRET`);
  }
  await app.listen({ port, host });
  return app;
}
