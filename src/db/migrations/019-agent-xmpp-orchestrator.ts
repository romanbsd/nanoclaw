import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration019: Migration = {
  version: 19,
  name: 'agent-xmpp-orchestrator',
  up: (db: Database.Database) => {
    const cols = db.prepare("PRAGMA table_info('agent_groups')").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'xmpp_jid')) {
      db.exec(`
        ALTER TABLE agent_groups ADD COLUMN xmpp_jid TEXT;
        CREATE UNIQUE INDEX idx_agent_groups_xmpp_jid ON agent_groups(xmpp_jid) WHERE xmpp_jid IS NOT NULL;
      `);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_agents (
        id                  TEXT PRIMARY KEY,
        agent_group_id      TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        xmpp_jid            TEXT NOT NULL,
        tenant_id           TEXT,
        mock_scenario       TEXT,
        spawn_env           TEXT NOT NULL DEFAULT '{}',
        created_at          TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestrator_agents_xmpp_jid ON orchestrator_agents(xmpp_jid);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestrator_agents_agent_group ON orchestrator_agents(agent_group_id);
    `);
  },
};
