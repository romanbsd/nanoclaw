import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration099: Migration = {
  version: 99,
  name: 'agent-xmpp-orchestrator',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_agents (
        id                  TEXT PRIMARY KEY,
        agent_group_id      TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        tenant_id           TEXT,
        mock_scenario       TEXT,
        spawn_env           TEXT NOT NULL DEFAULT '{}',
        created_at          TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestrator_agents_agent_group ON orchestrator_agents(agent_group_id);

      CREATE TABLE IF NOT EXISTS xmpp_agent_identities (
        agent_group_id TEXT PRIMARY KEY REFERENCES agent_groups(id) ON DELETE CASCADE,
        jid            TEXT NOT NULL UNIQUE,
        created_at     TEXT NOT NULL
      );
    `);
  },
};
