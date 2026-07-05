import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { ulid } from 'ulid';

import type { AgentMessage } from '@agent-xmpp/protocol';

export type MailboxStatus = 'pending' | 'delivered' | 'acked' | 'failed';

export interface MailboxRow {
  id: string;
  stanza_id: string;
  agent_jid: string;
  payload: string;
  status: MailboxStatus;
  created_at: string;
  updated_at: string;
  redelivered: number;
}

export class Mailbox {
  private db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, 'mailbox.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mailbox (
        id TEXT PRIMARY KEY,
        stanza_id TEXT NOT NULL UNIQUE,
        agent_jid TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        redelivered INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_mailbox_status ON mailbox(status);
      CREATE INDEX IF NOT EXISTS idx_mailbox_agent ON mailbox(agent_jid);
    `);
  }

  /** Returns false if stanza already seen (idempotency). */
  enqueue(stanzaId: string, agentJid: string, payload: string): { id: string; isDuplicate: boolean; redelivered: boolean } {
    const existing = this.db.prepare('SELECT id, status, redelivered FROM mailbox WHERE stanza_id = ?').get(stanzaId) as
      | { id: string; status: MailboxStatus; redelivered: number }
      | undefined;

    if (existing) {
      return { id: existing.id, isDuplicate: true, redelivered: existing.redelivered === 1 };
    }

    const id = ulid();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO mailbox (id, stanza_id, agent_jid, payload, status, created_at, updated_at, redelivered)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, 0)`,
      )
      .run(id, stanzaId, agentJid, payload, now, now);
    return { id, isDuplicate: false, redelivered: false };
  }

  markDelivered(stanzaId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE mailbox SET status = 'delivered', updated_at = ? WHERE stanza_id = ?`)
      .run(now, stanzaId);
  }

  markAcked(messageId: string, status: MailboxStatus): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE mailbox SET status = ?, updated_at = ? WHERE stanza_id = ? OR id = ?`)
      .run(status, now, messageId, messageId);
  }

  markRedelivered(stanzaId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE mailbox SET redelivered = 1, updated_at = ? WHERE stanza_id = ?`)
      .run(now, stanzaId);
  }

  resolveMessage(messageId: string): AgentMessage | null {
    const row = this.db
      .prepare('SELECT payload FROM mailbox WHERE stanza_id = ? OR id = ?')
      .get(messageId, messageId) as { payload: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.payload) as AgentMessage;
    // eslint-disable-next-line no-catch-all/no-catch-all -- corrupt row: log and treat as missing
    } catch (err) {
      console.error('[xmpp-gateway] mailbox payload parse failed:', messageId, err);
      return null;
    }
  }

  listForRedelivery(): Array<{ id: string; stanzaId: string; agentJid: string; payload: string }> {
    return this.db
      .prepare(
        `SELECT id, stanza_id AS stanzaId, agent_jid AS agentJid, payload
         FROM mailbox WHERE status IN ('pending', 'delivered') ORDER BY created_at`,
      )
      .all() as Array<{ id: string; stanzaId: string; agentJid: string; payload: string }>;
  }

  close(): void {
    this.db.close();
  }
}
