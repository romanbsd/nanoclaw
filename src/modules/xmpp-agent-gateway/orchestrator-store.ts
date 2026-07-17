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

/** Parse persisted spawn environment, rejecting malformed or non-string values. */
export function parseOrchestratorSpawnEnv(raw: string | null | undefined): Record<string, string> | null {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed);
    if (entries.some(([, value]) => typeof value !== 'string')) return null;
    return Object.fromEntries(entries) as Record<string, string>;
    // eslint-disable-next-line no-catch-all/no-catch-all -- persisted legacy rows may be malformed
  } catch {
    return null;
  }
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
