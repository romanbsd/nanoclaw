import fs from 'node:fs';

import { getDb, hasTable } from '../../../src/db/connection.js';
import {
  deleteAgentGroup,
  deleteContainerConfig,
  deleteMessagingGroup,
  deleteMessagingGroupAgent,
  deleteOrchestratorAgent,
  deleteSession,
  getAgentGroup,
  getMessagingGroupAgentByPair,
  getMessagingGroupsByAgentGroup,
  getOrchestratorAgent,
  getSessionsByAgentGroup,
} from '../../../src/db/index.js';
import { deleteAllDestinationsTouching } from '../../../src/modules/agent-to-agent/db/agent-destinations.js';
import { sessionDir } from '../../../src/session-manager.js';
import { OpenfireClient, loadOpenfireConfigFromEnv, usernameFromJid } from './openfire-client.js';
import { removeAgentGroupFolder } from './provision-nanoclaw-agent.js';

export interface DeleteNanoclawAgentOptions {
  openfireClient?: OpenfireClient;
}

export async function deleteNanoclawAgent(
  orchestratorId: string,
  options: DeleteNanoclawAgentOptions = {},
): Promise<void> {
  const record = getOrchestratorAgent(orchestratorId);
  if (!record) {
    throw new Error(`Orchestrator agent not found: ${orchestratorId}`);
  }

  const agentGroup = getAgentGroup(record.agent_group_id);
  if (!agentGroup) {
    deleteOrchestratorAgent(orchestratorId);
    return;
  }

  const client = options.openfireClient ?? new OpenfireClient(loadOpenfireConfigFromEnv());
  const username = usernameFromJid(record.xmpp_jid);
  if (process.env.ORCHESTRATOR_SKIP_OPENFIRE !== '1') {
    await client.deleteUser(username).catch((err) => {
      console.warn(
        `[orchestrator] OpenFire deleteUser failed for ${username}:`,
        err instanceof Error ? err.message : err,
      );
    });
  }

  for (const session of getSessionsByAgentGroup(agentGroup.id)) {
    deleteSession(session.id);
    const dir = sessionDir(agentGroup.id, session.id);
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      // eslint-disable-next-line no-catch-all/no-catch-all -- best-effort session dir cleanup during delete
    } catch (err) {
      console.warn(
        `[orchestrator] session dir cleanup failed for ${dir}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  for (const mg of getMessagingGroupsByAgentGroup(agentGroup.id)) {
    const mga = getMessagingGroupAgentByPair(mg.id, agentGroup.id);
    if (mga) deleteMessagingGroupAgent(mga.id);
    deleteMessagingGroup(mg.id);
  }

  if (hasTable(getDb(), 'agent_destinations')) {
    // Must run before deleteAgentGroup — FK from agent_destinations → agent_groups.
    deleteAllDestinationsTouching(agentGroup.id);
  }

  if (hasTable(getDb(), 'xmpp_agent_apis')) {
    getDb().prepare('DELETE FROM xmpp_agent_apis WHERE jid = ?').run(record.xmpp_jid);
  }

  deleteContainerConfig(agentGroup.id);
  deleteAgentGroup(agentGroup.id);
  deleteOrchestratorAgent(orchestratorId);
  removeAgentGroupFolder(agentGroup.folder);
}
