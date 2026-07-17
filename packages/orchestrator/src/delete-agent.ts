import { OpenfireClient, loadOpenfireConfigFromEnv, usernameFromJid } from './openfire-client.js';
import type { NanoclawAgentHost } from './nanoclaw-host.js';

export interface DeleteNanoclawAgentOptions {
  host: NanoclawAgentHost;
  openfireClient?: OpenfireClient;
}

export async function deleteNanoclawAgent(
  orchestratorId: string,
  options: DeleteNanoclawAgentOptions,
): Promise<void> {
  const record = options.host.getAgent(orchestratorId);
  if (!record) {
    throw new Error(`Orchestrator agent not found: ${orchestratorId}`);
  }

  if (record.jid && process.env.ORCHESTRATOR_SKIP_OPENFIRE !== '1') {
    const client = options.openfireClient ?? new OpenfireClient(loadOpenfireConfigFromEnv());
    const username = usernameFromJid(record.jid);
    await client.deleteUser(username).catch((err) => {
      console.warn(
        `[orchestrator] OpenFire deleteUser failed for ${username}:`,
        err instanceof Error ? err.message : err,
      );
    });
  }
  await options.host.deleteAgent(orchestratorId);
}
