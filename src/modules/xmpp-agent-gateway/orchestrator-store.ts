import { getDb } from '../../db/connection.js';

export interface OrchestratorAgent {
  id: string;
  agent_group_id: string;
  tenant_id: string | null;
  mock_scenario: string | null;
  /** JSON object of extra container spawn env vars. */
  spawn_env: string;
  created_at: string;
}

export function createOrchestratorAgent(row: OrchestratorAgent): void {
  getDb()
    .prepare(
      `INSERT INTO orchestrator_agents (
         id, agent_group_id, tenant_id, mock_scenario, spawn_env, created_at
       ) VALUES (
         @id, @agent_group_id, @tenant_id, @mock_scenario, @spawn_env, @created_at
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
  return getDb()
    .prepare(
      `SELECT oa.* FROM orchestrator_agents oa
       JOIN xmpp_agent_identities xi ON xi.agent_group_id = oa.agent_group_id
       WHERE xi.jid = ?`,
    )
    .get(jid) as OrchestratorAgent | undefined;
}

export function listOrchestratorAgents(): OrchestratorAgent[] {
  return getDb().prepare('SELECT * FROM orchestrator_agents ORDER BY created_at').all() as OrchestratorAgent[];
}

export function deleteOrchestratorAgent(id: string): void {
  getDb().prepare('DELETE FROM orchestrator_agents WHERE id = ?').run(id);
}
