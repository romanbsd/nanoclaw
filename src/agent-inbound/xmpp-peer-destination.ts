/**
 * XMPP agent inbox: ensure each human DM peer is a named delivery destination.
 *
 * Orchestrator agents use one messaging_group per agent JID (the inbox).
 * Auto-wiring that inbox also created a destination pointing at the agent's
 * own JID — agents reply with `<message to="spark">` and loop. Peers get a
 * per-JID messaging group + agent_destinations row instead.
 */
import { getAgentGroup } from '../db/agent-groups.js';
import { getDb, hasTable } from '../db/connection.js';
import { createMessagingGroup, getMessagingGroup, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import {
  createDestination,
  getDestinationByName,
  getDestinationByTarget,
  normalizeName,
} from '../modules/agent-to-agent/db/agent-destinations.js';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Skip projecting the agent's own inbox JID as a send target. */
export function isXmppAgentInboxMessagingGroup(agentGroupId: string, messagingGroupId: string): boolean {
  const ag = getAgentGroup(agentGroupId);
  const mg = getMessagingGroup(messagingGroupId);
  if (!ag?.xmpp_jid || !mg) return false;
  return mg.channel_type === 'xmpp' && mg.platform_id === ag.xmpp_jid;
}

/**
 * Register `peerJid` as a deliverable destination for this agent session.
 * Idempotent — safe on every inbound DM.
 */
export async function ensureXmppPeerDestination(
  agentGroupId: string,
  sessionId: string,
  peerJid: string,
): Promise<void> {
  if (!hasTable(getDb(), 'agent_destinations')) return;

  const ag = getAgentGroup(agentGroupId);
  if (!ag?.xmpp_jid) return;

  const peerBare = peerJid.split('/')[0];
  if (!peerBare.includes('@') || peerBare === ag.xmpp_jid) return;

  let mg = getMessagingGroupByPlatform('xmpp', peerBare, 'xmpp');
  if (!mg) {
    const now = new Date().toISOString();
    const mgId = generateId('mg');
    createMessagingGroup({
      id: mgId,
      channel_type: 'xmpp',
      platform_id: peerBare,
      instance: 'xmpp',
      name: peerBare.split('@')[0] ?? peerBare,
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now,
    });
    mg = getMessagingGroup(mgId);
  }
  if (!mg) return;

  if (!getDestinationByTarget(agentGroupId, 'channel', mg.id)) {
    const base = normalizeName(mg.name || peerBare.split('@')[0] || 'peer') || 'peer';
    let localName = base;
    let suffix = 2;
    while (getDestinationByName(agentGroupId, localName)) {
      localName = `${base}-${suffix}`;
      suffix++;
    }
    createDestination({
      agent_group_id: agentGroupId,
      local_name: localName,
      target_type: 'channel',
      target_id: mg.id,
      created_at: new Date().toISOString(),
    });
  }

  const { writeDestinations } = await import('../modules/agent-to-agent/write-destinations.js');
  writeDestinations(agentGroupId, sessionId);
}
