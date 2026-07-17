import path from 'node:path';

import { startOrchestratorServer } from '@agent-xmpp/orchestrator';
import { createProtocolNamespaces, DEFAULT_PROTOCOL_PROFILE } from '@agent-xmpp/protocol';

import { DATA_DIR } from '../../config.js';
import { getDb, initDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { NanoclawXmppAgentHost } from './orchestrator-host.js';

async function main(): Promise<void> {
  initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(getDb());

  const protocolNamespaces = createProtocolNamespaces({
    namespaceRoot: process.env.AGENT_XMPP_NAMESPACE_ROOT || DEFAULT_PROTOCOL_PROFILE.namespaceRoot,
    mediaVendor: process.env.AGENT_XMPP_MEDIA_VENDOR || DEFAULT_PROTOCOL_PROFILE.mediaVendor,
  });
  await startOrchestratorServer({ nanoclawHost: new NanoclawXmppAgentHost(), protocolNamespaces });
  console.log('[orchestrator] listening');
}

main().catch((err) => {
  console.error('[orchestrator] fatal:', err);
  process.exit(1);
});
