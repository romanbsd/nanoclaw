import type { ContainerContribution } from '../../container-contribution.js';
import { log } from '../../log.js';
import { getXmppAgentIdentity } from './identity.js';
import { getOrchestratorAgentByGroupId, parseOrchestratorSpawnEnv } from './orchestrator-store.js';

export const XMPP_AGENT_PROMPT_ADDENDUM =
  "**Destinations name human chat peers only.** Other NanoClaw agents are remote MCP endpoints. Use `agents.discover_endpoints` with the agent name or JID, then `agents.call_tool` with the returned endpoint and its `conversation.respond` operation when you need that agent's answer in this turn. Return the remote result to the requesting human; do not stop after merely saying you will look it up.";

export function getXmppContainerContribution(agentGroupId: string): ContainerContribution | undefined {
  const identity = getXmppAgentIdentity(agentGroupId);
  const orchestratorAgent = getOrchestratorAgentByGroupId(agentGroupId);
  if (!orchestratorAgent) {
    return identity ? { env: { XMPP_AGENT_JID: identity.jid }, promptAddendum: XMPP_AGENT_PROMPT_ADDENDUM } : undefined;
  }

  const spawnEnv = parseOrchestratorSpawnEnv(orchestratorAgent.spawn_env);
  if (!spawnEnv) {
    log.warn('Ignoring malformed orchestrator spawn_env', { agentGroupId });
    return identity ? { env: { XMPP_AGENT_JID: identity.jid }, promptAddendum: XMPP_AGENT_PROMPT_ADDENDUM } : undefined;
  }

  const blockedHosts =
    spawnEnv.BLOCKED_HOSTS?.split(',')
      .map((host) => host.trim())
      .filter(Boolean) ?? [];
  const env = Object.fromEntries(Object.entries(spawnEnv).filter(([key, value]) => key !== 'BLOCKED_HOSTS' && value));
  return {
    env,
    blockedHosts,
    ...(identity ? { promptAddendum: XMPP_AGENT_PROMPT_ADDENDUM } : {}),
  };
}
