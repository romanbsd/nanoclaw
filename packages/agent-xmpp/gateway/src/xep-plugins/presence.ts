/**
 * Virtual-agent presence for an XEP-0114 component.
 *
 * Openfire cannot publish presence for virtual JIDs because they are not C2S
 * accounts. The component therefore completes roster subscriptions and
 * answers server probes itself.
 *
 * @see https://www.rfc-editor.org/rfc/rfc6121#section-3
 */
import { xml, type Element } from '@xmpp/xml';

import { bareJid } from './jid.js';

export interface VirtualAgentIdentity {
  jid: string;
  name: string;
}

export function buildAvailablePresence(agent: VirtualAgentIdentity, to: string): Element {
  return xml(
    'presence',
    { from: bareJid(agent.jid), to },
    xml('show', {}, 'chat'),
    xml('status', {}, `${agent.name} is available`),
  );
}

export function buildSubscriptionAccepted(agent: VirtualAgentIdentity, to: string): Element {
  return xml('presence', { type: 'subscribed', from: bareJid(agent.jid), to });
}

export function buildSubscriptionRemoved(agent: VirtualAgentIdentity, to: string): Element {
  return xml('presence', { type: 'unsubscribed', from: bareJid(agent.jid), to });
}

export function presenceResponses(stanza: Element, agent: VirtualAgentIdentity): Element[] {
  if (stanza.name !== 'presence') return [];
  const to = String(stanza.attrs.from ?? '');
  if (!to) return [];
  const type = String(stanza.attrs.type ?? '');
  if (type === 'subscribe') return [buildSubscriptionAccepted(agent, to), buildAvailablePresence(agent, to)];
  if (type === 'probe' || type === '') return [buildAvailablePresence(agent, to)];
  if (type === 'unsubscribe') return [buildSubscriptionRemoved(agent, to)];
  return [];
}
