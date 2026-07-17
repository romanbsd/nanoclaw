/** Ensure each human XMPP peer is a named delivery destination. */
import { getDb, hasTable } from '../../db/connection.js';
import { createMessagingGroup, getMessagingGroup, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import {
  createDestination,
  getDestinationByName,
  getDestinationByTarget,
  normalizeName,
} from '../agent-to-agent/db/agent-destinations.js';
import { getXmppAgentIdentity } from './identity.js';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Register `peerJid` as a deliverable destination for this agent session. */
export async function ensureXmppPeerDestination(agentGroupId: string, peerJid: string): Promise<void> {
  if (!hasTable(getDb(), 'agent_destinations')) return;

  const identity = getXmppAgentIdentity(agentGroupId);
  if (!identity) return;

  const peerBare = peerJid.split('/')[0];
  if (!peerBare.includes('@') || peerBare === identity.jid) return;

  let messagingGroup = getMessagingGroupByPlatform('xmpp', peerBare, 'xmpp');
  if (!messagingGroup) {
    const messagingGroupId = generateId('mg');
    createMessagingGroup({
      id: messagingGroupId,
      channel_type: 'xmpp',
      platform_id: peerBare,
      instance: 'xmpp',
      name: peerBare.split('@')[0] ?? peerBare,
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: new Date().toISOString(),
    });
    messagingGroup = getMessagingGroup(messagingGroupId);
  }
  if (!messagingGroup || getDestinationByTarget(agentGroupId, 'channel', messagingGroup.id)) return;

  const baseName = normalizeName(messagingGroup.name || peerBare.split('@')[0] || 'peer') || 'peer';
  let localName = baseName;
  let suffix = 2;
  while (getDestinationByName(agentGroupId, localName)) {
    localName = `${baseName}-${suffix}`;
    suffix++;
  }
  createDestination({
    agent_group_id: agentGroupId,
    local_name: localName,
    target_type: 'channel',
    target_id: messagingGroup.id,
    created_at: new Date().toISOString(),
  });
}
