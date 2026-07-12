import fs from 'node:fs';
import path from 'node:path';

import { GROUPS_DIR } from '../../../src/config.js';
import {
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  createOrchestratorAgent,
  deleteAgentGroup,
  deleteContainerConfig,
  deleteMessagingGroup,
  deleteMessagingGroupAgent,
  deleteOrchestratorAgent,
  ensureContainerConfig,
  getAgentGroupByFolder,
  getMessagingGroupByPlatform,
  getMessagingGroupAgentByPair,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../../../src/db/index.js';
import { initGroupFilesystem } from '../../../src/group-init.js';
import { normalizeName } from '../../../src/modules/agent-to-agent/db/agent-destinations.js';
import type { AgentGroup, OrchestratorAgent } from '../../../src/types.js';
import { XmppAgentGatewayStore } from '../../../src/modules/xmpp-agent-gateway/store.js';
import type { AgentApiManifest } from '@agent-xmpp/protocol';
import { provisionAgentIdentity } from './provision-identity.js';
import { OpenfireClient, loadOpenfireConfigFromEnv, usernameFromJid } from './openfire-client.js';
import type { OpenfireClientConfig } from './openfire-client.js';

export interface McpServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ProvisionNanoclawAgentRequest {
  name: string;
  agentId: string;
  tenantId: string;
  displayName: string;
  personality?: {
    instructions?: string;
    assistantName?: string;
  };
  provider?: string;
  model?: string;
  mockScenario?: string;
  skills?: string[] | 'all';
  mcpServers?: McpServerSpec[];
  groups?: string[];
  avatarUrl?: string;
  /** Extra env vars injected at container spawn (e.g. MOCK_ACCOUNTANT_JID). */
  spawnEnv?: Record<string, string>;
  /** Structured API advertised by this logical agent. Defaults to conversation.respond. */
  agentApiManifest?: Omit<AgentApiManifest, 'agent'> & { agent?: Partial<AgentApiManifest['agent']> };
}

export interface ProvisionNanoclawAgentResult {
  orchestratorId: string;
  agentGroupId: string;
  folder: string;
  jid: string;
  password: string;
  messagingGroupId: string;
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveFolder(agentId: string): string {
  const base = normalizeName(agentId) || 'agent';
  let folder = base;
  let suffix = 2;
  while (getAgentGroupByFolder(folder)) {
    folder = `${base}-${suffix}`;
    suffix++;
  }
  return folder;
}

function buildMcpServers(specs: McpServerSpec[] | undefined): Record<string, { command: string; args?: string[]; env?: Record<string, string> }> {
  const servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {};
  for (const spec of specs ?? []) {
    servers[spec.name] = {
      command: spec.command,
      args: spec.args,
      env: spec.env,
    };
  }
  return servers;
}

export interface ProvisionNanoclawAgentOptions {
  openfireClient?: OpenfireClient;
  openfireConfig?: OpenfireClientConfig;
  baseDomain?: string;
}

export async function provisionNanoclawAgent(
  request: ProvisionNanoclawAgentRequest,
  options: ProvisionNanoclawAgentOptions = {},
): Promise<ProvisionNanoclawAgentResult> {
  const baseDomain = options.baseDomain || request.tenantId;

  const identity = await provisionAgentIdentity(
    {
      tenantId: request.tenantId,
      agentId: request.agentId,
      displayName: request.displayName,
      groups: request.groups,
      avatarUrl: request.avatarUrl,
    },
    {
      client: options.openfireClient,
      baseDomain,
    },
  );

  const folder = resolveFolder(request.agentId);
  const now = new Date().toISOString();
  const agentGroupId = generateId('ag');
  const orchestratorId = generateId('orch');
  const provider = request.provider || 'mock';
  const model = request.model || (provider === 'mock' ? 'mock' : undefined);

  // Undo stack: on any failure after the XMPP identity is created, unwind every
  // side effect (DB rows, folder, and the OpenFire user) so nothing leaks.
  const rollback: Array<() => void | Promise<void>> = [
    async () => {
      if (process.env.ORCHESTRATOR_SKIP_OPENFIRE === '1') return;
      const client = options.openfireClient ?? new OpenfireClient(loadOpenfireConfigFromEnv());
      await client.deleteUser(usernameFromJid(identity.jid));
    },
  ];

  try {
    const agentGroup: AgentGroup = {
      id: agentGroupId,
      name: request.name,
      folder,
      agent_provider: null,
      xmpp_jid: identity.jid,
      created_at: now,
    };
    createAgentGroup(agentGroup);
    rollback.push(() => deleteAgentGroup(agentGroupId));

    const instructions = request.personality?.instructions;
    initGroupFilesystem(agentGroup, { instructions, provider });
    rollback.push(() => removeAgentGroupFolder(folder));

    ensureContainerConfig(agentGroupId);
    rollback.push(() => deleteContainerConfig(agentGroupId));
    updateContainerConfigScalars(agentGroupId, {
      provider,
      model,
      assistant_name: request.personality?.assistantName || request.displayName,
    });
    updateContainerConfigJson(agentGroupId, 'skills', request.skills ?? []);
    updateContainerConfigJson(agentGroupId, 'mcp_servers', buildMcpServers(request.mcpServers));

    const mgId = generateId('mg');
    // One messaging_group per agent JID (instance=xmpp); re-use if orchestrator re-provisions same JID.
    const existingMg = getMessagingGroupByPlatform('xmpp', identity.jid, 'xmpp');
    const messagingGroupId = existingMg?.id ?? mgId;
    if (!existingMg) {
      createMessagingGroup({
        id: mgId,
        channel_type: 'xmpp',
        platform_id: identity.jid,
        instance: 'xmpp',
        name: request.displayName,
        is_group: 0,
        unknown_sender_policy: 'public',
        created_at: now,
      });
      rollback.push(() => deleteMessagingGroup(mgId));
    }

    if (!getMessagingGroupAgentByPair(messagingGroupId, agentGroupId)) {
      const mgaId = generateId('mga');
      createMessagingGroupAgent({
        id: mgaId,
        messaging_group_id: messagingGroupId,
        agent_group_id: agentGroupId,
        // pattern '.' + sender_scope 'all': every inbound XMPP stanza wakes this agent (A2A + external).
        engage_mode: 'pattern',
        engage_pattern: '.',
        sender_scope: 'all',
        ignored_message_policy: 'drop',
        session_mode: 'shared',
        priority: 0,
        created_at: now,
      });
      rollback.push(() => deleteMessagingGroupAgent(mgaId));
    }

    // Injected into container spawn env; encodes XMPP identity + mock scenario knobs for agent-runner.
    const spawnEnv = {
      XMPP_AGENT_JID: identity.jid,
      XMPP_TENANT_ID: request.tenantId,
      ...(request.mockScenario ? { MOCK_SCENARIO: request.mockScenario } : {}),
      ...request.spawnEnv,
    };

    const orchRow: OrchestratorAgent = {
      id: orchestratorId,
      agent_group_id: agentGroupId,
      tenant_id: request.tenantId,
      mock_scenario: request.mockScenario ?? null,
      spawn_env: JSON.stringify(spawnEnv),
      created_at: now,
    };
    createOrchestratorAgent(orchRow);
    rollback.push(() => deleteOrchestratorAgent(orchestratorId));

    const supplied = request.agentApiManifest;
    const manifest: AgentApiManifest = {
      specVersion: 'urn:businessos:agent-api:1',
      capabilities: supplied?.capabilities ?? {
        tools: { listChanged: true }, progress: true, cancellation: true, inputRequired: true, structuredOutput: true,
      },
      operations: supplied?.operations ?? [{
        name: 'conversation.respond',
        description: 'Ask this agent to handle a conversational request.',
        inputSchema: {
          type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false,
        },
        outputSchema: {
          type: 'object', properties: { response: { type: 'string' } }, required: ['response'], additionalProperties: false,
        },
      }],
      agent: {
        jid: identity.jid,
        name: supplied?.agent?.name ?? request.agentId,
        title: supplied?.agent?.title ?? request.displayName,
        description: supplied?.agent?.description,
        version: supplied?.agent?.version ?? '1.0.0',
        vendor: supplied?.agent?.vendor,
        homepage: supplied?.agent?.homepage,
      },
    };
    new XmppAgentGatewayStore().registerManifest(manifest, request.tenantId);

    return {
      orchestratorId,
      agentGroupId,
      folder,
      jid: identity.jid,
      password: identity.password,
      messagingGroupId,
    };
  } catch (err) {
    // Unwind in reverse; each step is best-effort so one failure can't strand the rest.
    for (const undo of rollback.reverse()) {
      try {
        await undo();
        // eslint-disable-next-line no-catch-all/no-catch-all -- compensating cleanup is best-effort
      } catch (cleanupErr) {
        console.warn(
          '[provision-nanoclaw-agent] rollback step failed:',
          cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,
        );
      }
    }
    throw err;
  }
}

export function removeAgentGroupFolder(folder: string): void {
  const groupDir = path.join(GROUPS_DIR, folder);
  try {
    if (fs.existsSync(groupDir)) {
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- best-effort filesystem cleanup during delete
  } catch (err) {
    console.warn(
      `[orchestrator] agent group folder cleanup failed for ${groupDir}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
