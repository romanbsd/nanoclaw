import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GROUPS_DIR } from '../../../src/config.js';
import {
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  createOrchestratorAgent,
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
import { provisionAgentIdentity } from './provision-identity.js';
import type { OpenfireClient } from './openfire-client.js';
import type { OpenfireClientConfig } from './openfire-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(__dirname, '../../..');

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

function defaultXmppMcpPath(): string {
  return path.join(REPO_ROOT, 'packages/agent-xmpp/mcp/dist/index.js');
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

/** Containers reach the host gateway via host.docker.internal, not loopback. */
function containerGatewayUrl(gatewayUrl: string): string {
  try {
    const url = new URL(gatewayUrl);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      url.hostname = 'host.docker.internal';
      return url.toString().replace(/\/$/, '');
    }
  } catch {
    // fall through
  }
  return gatewayUrl;
}

function buildMcpServers(
  specs: McpServerSpec[] | undefined,
  gatewayUrl: string,
): Record<string, { command: string; args?: string[]; env?: Record<string, string> }> {
  const servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {};
  const list = specs?.length
    ? specs
    : [{ name: 'xmpp', command: 'node', args: [defaultXmppMcpPath()] }];

  for (const spec of list) {
    servers[spec.name] = {
      command: spec.command,
      args: spec.args,
      env: { XMPP_GATEWAY_URL: gatewayUrl, ...spec.env },
    };
  }
  return servers;
}

export interface ProvisionNanoclawAgentOptions {
  openfireClient?: OpenfireClient;
  openfireConfig?: OpenfireClientConfig;
  baseDomain?: string;
  gatewayUrl?: string;
}

export async function provisionNanoclawAgent(
  request: ProvisionNanoclawAgentRequest,
  options: ProvisionNanoclawAgentOptions = {},
): Promise<ProvisionNanoclawAgentResult> {
  const gatewayUrl = options.gatewayUrl || process.env.XMPP_GATEWAY_URL || 'http://127.0.0.1:9220';
  const containerGateway = containerGatewayUrl(gatewayUrl);
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

  const agentGroup: AgentGroup = {
    id: agentGroupId,
    name: request.name,
    folder,
    agent_provider: null,
    xmpp_jid: identity.jid,
    created_at: now,
  };
  createAgentGroup(agentGroup);

  const provider = request.provider || 'mock';
  const instructions = request.personality?.instructions;
  initGroupFilesystem(agentGroup, { instructions, provider });

  ensureContainerConfig(agentGroupId);
  updateContainerConfigScalars(agentGroupId, {
    provider,
    model: request.model || (provider === 'mock' ? 'mock' : undefined),
    assistant_name: request.personality?.assistantName || request.displayName,
  });
  updateContainerConfigJson(agentGroupId, 'skills', request.skills ?? []);
  updateContainerConfigJson(agentGroupId, 'mcp_servers', buildMcpServers(request.mcpServers, containerGateway));

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
  }

  if (!getMessagingGroupAgentByPair(messagingGroupId, agentGroupId)) {
    createMessagingGroupAgent({
      id: generateId('mga'),
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
  }

  // Injected into container spawn env; encodes XMPP identity + mock scenario knobs for agent-runner.
  const spawnEnv = {
    XMPP_AGENT_JID: identity.jid,
    XMPP_GATEWAY_URL: containerGateway,
    XMPP_TENANT_ID: request.tenantId,
    ...(request.mockScenario ? { MOCK_SCENARIO: request.mockScenario } : {}),
    ...request.spawnEnv,
  };

  const orchRow: OrchestratorAgent = {
    id: orchestratorId,
    agent_group_id: agentGroupId,
    xmpp_jid: identity.jid,
    tenant_id: request.tenantId,
    mock_scenario: request.mockScenario ?? null,
    spawn_env: JSON.stringify(spawnEnv),
    created_at: now,
  };
  createOrchestratorAgent(orchRow);

  return {
    orchestratorId,
    agentGroupId,
    folder,
    jid: identity.jid,
    password: identity.password,
    messagingGroupId,
  };
}

export function removeAgentGroupFolder(folder: string): void {
  const groupDir = path.join(GROUPS_DIR, folder);
  try {
    if (fs.existsSync(groupDir)) {
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  } catch {
    // Best-effort filesystem cleanup.
  }
}
