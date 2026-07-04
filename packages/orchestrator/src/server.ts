/**
 * Orchestrator HTTP service entrypoint.
 *
 * Run from repo root:
 *   pnpm exec tsx packages/orchestrator/src/server.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDb, initDb } from '../../../src/db/connection.js';
import { runMigrations } from '../../../src/db/migrations/index.js';
import { DATA_DIR } from '../../../src/config.js';
import { startOrchestratorServer } from './http-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(getDb());

  await startOrchestratorServer();
  console.log('[orchestrator] listening');
}

main().catch((err) => {
  console.error('[orchestrator] fatal:', err);
  process.exit(1);
});
