import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';

import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../db/index.js';
import { createSession } from '../db/sessions.js';
import { initSessionFolder, openInboundDb } from '../session-manager.js';
import type { Session } from '../types.js';
import { ensureXmppPeerDestination } from './xmpp-peer-destination.js';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-xmpp-peer' };
});

const TEST_DIR = '/tmp/nanoclaw-test-xmpp-peer';

describe('ensureXmppPeerDestination', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    initTestDb();
    runMigrations(getDb());
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('registers human peer JID as a named destination and filters self-inbox row', async () => {
    createAgentGroup({
      id: 'ag-spark',
      name: 'Spark',
      folder: 'spark',
      agent_provider: null,
      xmpp_jid: 'spark@example.org',
      created_at: new Date().toISOString(),
    });

    createMessagingGroup({
      id: 'mg-inbox',
      channel_type: 'xmpp',
      platform_id: 'spark@example.org',
      instance: 'xmpp',
      name: 'Spark',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: new Date().toISOString(),
    });

    getDb()
      .prepare(
        `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
         VALUES ('ag-spark', 'spark', 'channel', 'mg-inbox', datetime('now'))`,
      )
      .run();

    const session: Session = {
      id: 'sess-spark',
      agent_group_id: 'ag-spark',
      messaging_group_id: 'mg-inbox',
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'idle',
      last_active: null,
      created_at: new Date().toISOString(),
    };
    createSession(session);
    initSessionFolder('ag-spark', 'sess-spark');

    await ensureXmppPeerDestination('ag-spark', 'sess-spark', 'john@example.org');

    const db = openInboundDb('ag-spark', 'sess-spark');
    try {
      const rows = db.prepare('SELECT name, platform_id FROM destinations ORDER BY name').all() as Array<{
        name: string;
        platform_id: string;
      }>;
      expect(rows).toEqual([{ name: 'john', platform_id: 'john@example.org' }]);
    } finally {
      db.close();
    }

    const peerMg = getDb()
      .prepare("SELECT platform_id FROM messaging_groups WHERE platform_id = 'john@example.org'")
      .get() as { platform_id: string };
    expect(peerMg.platform_id).toBe('john@example.org');
  });
});
