import type { OrchestratorAgent } from '../types.js';
import { getDb } from './connection.js';

export function createOrchestratorAgent(row: OrchestratorAgent): void {
  getDb()
    .prepare(
      `INSERT INTO orchestrator_agents (
         id, agent_group_id, xmpp_jid, tenant_id, mock_scenario, spawn_env, created_at
       ) VALUES (
         @id, @agent_group_id, @xmpp_jid, @tenant_id, @mock_scenario, @spawn_env, @created_at
       )`,
    )
    .run(row);
}

export function getOrchestratorAgent(id: string): OrchestratorAgent | undefined {
  return getDb().prepare('SELECT * FROM orchestrator_agents WHERE id = ?').get(id) as OrchestratorAgent | undefined;
}

export function getOrchestratorAgentByGroupId(agentGroupId: string): OrchestratorAgent | undefined {
  return getDb().prepare('SELECT * FROM orchestrator_agents WHERE agent_group_id = ?').get(agentGroupId) as
    | OrchestratorAgent
    | undefined;
}

export function getOrchestratorAgentByXmppJid(jid: string): OrchestratorAgent | undefined {
  return getDb().prepare('SELECT * FROM orchestrator_agents WHERE xmpp_jid = ?').get(jid) as
    | OrchestratorAgent
    | undefined;
}

export function listOrchestratorAgents(): OrchestratorAgent[] {
  return getDb().prepare('SELECT * FROM orchestrator_agents ORDER BY created_at').all() as OrchestratorAgent[];
}

export function deleteOrchestratorAgent(id: string): void {
  getDb().prepare('DELETE FROM orchestrator_agents WHERE id = ?').run(id);
}
