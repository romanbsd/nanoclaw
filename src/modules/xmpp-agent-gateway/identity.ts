import type { AgentGroup } from '../../types.js';
import { getDb } from '../../db/connection.js';

export interface XmppAgentIdentity {
  agent_group_id: string;
  jid: string;
  created_at: string;
}

export function createXmppAgentIdentity(identity: XmppAgentIdentity): void {
  getDb()
    .prepare(
      `INSERT INTO xmpp_agent_identities (agent_group_id, jid, created_at)
       VALUES (@agent_group_id, @jid, @created_at)`,
    )
    .run(identity);
}

export function getXmppAgentIdentity(agentGroupId: string): XmppAgentIdentity | undefined {
  return getDb().prepare('SELECT * FROM xmpp_agent_identities WHERE agent_group_id = ?').get(agentGroupId) as
    | XmppAgentIdentity
    | undefined;
}

export function getAgentGroupByXmppJid(jid: string): AgentGroup | undefined {
  return getDb()
    .prepare(
      `SELECT ag.* FROM agent_groups ag
       JOIN xmpp_agent_identities xi ON xi.agent_group_id = ag.id
       WHERE xi.jid = ?`,
    )
    .get(jid) as AgentGroup | undefined;
}
