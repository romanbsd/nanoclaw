import { randomUUID } from 'node:crypto';

import type {
  McpServerSpec,
  XmppAgentHost,
  NanoclawAgentProvision,
  NanoclawAgentProvisionResult,
  NanoclawAgentRecord,
} from '@agent-xmpp/orchestrator';

import { deleteAgentGroupCascade, provisionAgentGroup, removeAgentGroupFiles } from '../../agent-group-lifecycle.js';
import { getDb, hasTable } from '../../db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  deleteMessagingGroup,
  deleteMessagingGroupAgent,
  getAgentGroup,
  getAgentGroupByFolder,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
  getMessagingGroupsByAgentGroup,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../../db/index.js';
import { normalizeName } from '../agent-to-agent/db/agent-destinations.js';
import type { AgentGroup } from '../../types.js';
import { createXmppAgentIdentity, getXmppAgentIdentity } from './identity.js';
import { XmppAgentGatewayStore } from './store.js';
import {
  createOrchestratorAgent,
  getOrchestratorAgent,
  listOrchestratorAgents,
  parseOrchestratorSpawnEnv,
  type OrchestratorAgent,
} from './orchestrator-store.js';

function generateId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function buildMcpServers(
  specs: McpServerSpec[] | undefined,
): Record<string, { command: string; args?: string[]; env?: Record<string, string> }> {
  return Object.fromEntries((specs ?? []).map(({ name, command, args, env }) => [name, { command, args, env }]));
}

function toRecord(row: OrchestratorAgent): NanoclawAgentRecord {
  const group = getAgentGroup(row.agent_group_id);
  return {
    orchestratorId: row.id,
    agentGroupId: row.agent_group_id,
    name: group?.name ?? null,
    folder: group?.folder ?? null,
    jid: getXmppAgentIdentity(row.agent_group_id)?.jid ?? null,
    tenantId: row.tenant_id,
    mockScenario: row.mock_scenario,
    spawnEnv: parseOrchestratorSpawnEnv(row.spawn_env) ?? {},
    createdAt: row.created_at,
  };
}

export class NanoclawXmppAgentHost implements XmppAgentHost {
  getAgent(orchestratorId: string): NanoclawAgentRecord | undefined {
    const row = getOrchestratorAgent(orchestratorId);
    return row ? toRecord(row) : undefined;
  }

  listAgents(): NanoclawAgentRecord[] {
    return listOrchestratorAgents().map(toRecord);
  }

  async provisionAgent(request: NanoclawAgentProvision): Promise<NanoclawAgentProvisionResult> {
    const folder = this.resolveFolder(request.agentId);
    const now = new Date().toISOString();
    const agentGroupId = generateId('ag');
    const orchestratorId = generateId('orch');
    const provider = request.provider || 'mock';
    const model = request.model || (provider === 'mock' ? 'mock' : undefined);
    const rollback: Array<() => void | Promise<void>> = [];

    try {
      const agentGroup: AgentGroup = {
        id: agentGroupId,
        name: request.name,
        folder,
        agent_provider: null,
        created_at: now,
      };
      provisionAgentGroup(agentGroup, {
        instructions: request.personality?.instructions,
        provider,
      });
      rollback.push(() => {
        deleteAgentGroupCascade(agentGroupId);
        removeAgentGroupFiles(agentGroup);
      });
      createXmppAgentIdentity({ agent_group_id: agentGroupId, jid: request.jid, created_at: now });
      updateContainerConfigScalars(agentGroupId, {
        provider,
        model,
        assistant_name: request.personality?.assistantName || request.displayName,
      });
      updateContainerConfigJson(agentGroupId, 'skills', request.skills ?? []);
      updateContainerConfigJson(agentGroupId, 'mcp_servers', buildMcpServers(request.mcpServers));

      const existingGroup = getMessagingGroupByPlatform('xmpp', request.jid, 'xmpp');
      const messagingGroupId = existingGroup?.id ?? generateId('mg');
      if (!existingGroup) {
        createMessagingGroup({
          id: messagingGroupId,
          channel_type: 'xmpp',
          platform_id: request.jid,
          instance: 'xmpp',
          name: request.displayName,
          is_group: 0,
          unknown_sender_policy: 'public',
          created_at: now,
        });
        rollback.push(() => deleteMessagingGroup(messagingGroupId));
      }

      if (!getMessagingGroupAgentByPair(messagingGroupId, agentGroupId)) {
        const wiringId = generateId('mga');
        createMessagingGroupAgent(
          {
            id: wiringId,
            messaging_group_id: messagingGroupId,
            agent_group_id: agentGroupId,
            engage_mode: 'pattern',
            engage_pattern: '.',
            sender_scope: 'all',
            ignored_message_policy: 'drop',
            session_mode: 'shared',
            priority: 0,
            created_at: now,
          },
          { createDestination: false },
        );
        rollback.push(() => deleteMessagingGroupAgent(wiringId));
      }

      const spawnEnv = {
        XMPP_AGENT_JID: request.jid,
        XMPP_TENANT_ID: request.tenantId,
        ...(request.mockScenario ? { MOCK_SCENARIO: request.mockScenario } : {}),
        ...request.spawnEnv,
      };
      createOrchestratorAgent({
        id: orchestratorId,
        agent_group_id: agentGroupId,
        tenant_id: request.tenantId,
        mock_scenario: request.mockScenario ?? null,
        spawn_env: JSON.stringify(spawnEnv),
        created_at: now,
      });

      rollback.push(() => this.deleteManifest(request.jid));
      new XmppAgentGatewayStore().registerManifest(request.agentApiManifest, request.tenantId);

      return { orchestratorId, agentGroupId, folder, messagingGroupId };
    } catch (err) {
      for (const undo of rollback.reverse()) {
        try {
          await undo();
          // eslint-disable-next-line no-catch-all/no-catch-all -- compensating cleanup is best-effort
        } catch (cleanupErr) {
          console.warn(
            '[orchestrator-host] rollback step failed:',
            cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,
          );
        }
      }
      throw err;
    }
  }

  async deleteAgent(orchestratorId: string): Promise<void> {
    const record = getOrchestratorAgent(orchestratorId);
    if (!record) throw new Error(`Orchestrator agent not found: ${orchestratorId}`);

    const group = getAgentGroup(record.agent_group_id);
    if (!group) {
      getDb().prepare('DELETE FROM orchestrator_agents WHERE id = ?').run(orchestratorId);
      return;
    }
    const jid = getXmppAgentIdentity(group.id)?.jid;
    const messagingGroups = getMessagingGroupsByAgentGroup(group.id);
    for (const messagingGroup of messagingGroups) {
      const wiring = getMessagingGroupAgentByPair(messagingGroup.id, group.id);
      if (wiring) deleteMessagingGroupAgent(wiring.id);
    }
    if (jid) this.deleteManifest(jid);
    deleteAgentGroupCascade(group.id);
    for (const messagingGroup of messagingGroups) deleteMessagingGroup(messagingGroup.id);
    removeAgentGroupFiles(group);
  }

  private resolveFolder(agentId: string): string {
    const base = normalizeName(agentId) || 'agent';
    let folder = base;
    let suffix = 2;
    while (getAgentGroupByFolder(folder)) folder = `${base}-${suffix++}`;
    return folder;
  }

  private deleteManifest(jid: string): void {
    if (hasTable(getDb(), 'xmpp_agent_apis')) {
      getDb().prepare('DELETE FROM xmpp_agent_apis WHERE jid = ?').run(jid);
    }
  }
}
