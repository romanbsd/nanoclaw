import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration100: Migration = {
  version: 100,
  name: 'xmpp-agent-gateway',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS xmpp_agent_apis (
        jid TEXT NOT NULL,
        version TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        manifest_digest TEXT NOT NULL,
        availability TEXT NOT NULL DEFAULT 'dormant',
        registered_at TEXT NOT NULL,
        PRIMARY KEY (jid, version),
        UNIQUE (manifest_digest)
      );
      CREATE INDEX IF NOT EXISTS idx_xmpp_agent_apis_tenant ON xmpp_agent_apis(tenant_id, jid);

      CREATE TABLE IF NOT EXISTS xmpp_agent_tasks (
        task_id TEXT PRIMARY KEY,
        root_task_id TEXT NOT NULL,
        parent_task_id TEXT,
        caller_jid TEXT NOT NULL,
        caller_session_id TEXT,
        target_jid TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT,
        endpoint_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        api_version TEXT NOT NULL,
        input_schema_digest TEXT NOT NULL,
        output_schema_digest TEXT,
        arguments_json TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        idempotency_key TEXT,
        correlation_id TEXT NOT NULL,
        deadline TEXT,
        result_json TEXT,
        error_json TEXT,
        summary TEXT,
        created_at TEXT NOT NULL,
        accepted_at TEXT,
        started_at TEXT,
        completed_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_xmpp_agent_task_idempotency
        ON xmpp_agent_tasks(caller_jid, endpoint_id, operation, api_version, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_xmpp_agent_tasks_target ON xmpp_agent_tasks(target_jid, state, created_at);

      CREATE TABLE IF NOT EXISTS xmpp_agent_task_events (
        event_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES xmpp_agent_tasks(task_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(task_id, sequence)
      );
    `);
  },
};
