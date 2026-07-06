/** A2A binding identification: Agent Card PEP, per-agent disco, IQ fetch. */

import { xml, type Element } from '@xmpp/xml';
import { ulid } from 'ulid';

import {
  A2A_AGENT_DISCO_FEATURES,
  A2A_AGENTCARD_PEP_NODE,
  A2A_NS,
  type A2aAgentCard,
} from '@agent-xmpp/protocol';

import type { GatewayConfig } from '../config.js';
import type { AgentRegistry } from './discovery.js';
import { bareJid } from './jid.js';
import { isAgentJid } from './message.js';

const DISCO_NS = 'http://jabber.org/protocol/disco#info';
const PUBSUB_NS = 'http://jabber.org/protocol/pubsub';
const STANZA_NS = 'urn:ietf:params:xml:ns:xmpp-stanzas';

function itemNotFoundIq(from: string, to: string, iqId: string): Element {
  return xml(
    'iq',
    { type: 'error', from, to, id: iqId },
    xml('error', { type: 'cancel' }, xml('item-not-found', { xmlns: STANZA_NS })),
  );
}

function agentCardElement(card: A2aAgentCard): Element {
  return xml('agentcard', { xmlns: A2A_AGENTCARD_PEP_NODE }, JSON.stringify(card));
}

export function buildAgentDiscoResponse(
  from: string,
  to: string,
  iqId: string,
  card: A2aAgentCard | undefined,
): Element {
  const name = card?.name || from.split('@')[0];
  return xml(
    'iq',
    { type: 'result', from, to, id: iqId },
    xml(
      'query',
      { xmlns: DISCO_NS },
      xml('identity', { category: 'automation', type: 'bot', name }),
      ...A2A_AGENT_DISCO_FEATURES.map((feature) => xml('feature', { var: feature })),
    ),
  );
}

export function buildAgentCardPubsubResponse(
  from: string,
  to: string,
  iqId: string,
  card: A2aAgentCard | undefined,
): Element {
  if (!card) return itemNotFoundIq(from, to, iqId);
  return xml(
    'iq',
    { type: 'result', from, to, id: iqId },
    xml(
      'pubsub',
      { xmlns: PUBSUB_NS },
      xml(
        'items',
        { node: A2A_AGENTCARD_PEP_NODE },
        xml('item', { id: 'current' }, agentCardElement(card)),
      ),
    ),
  );
}

export function buildAgentCardA2aIqResponse(
  from: string,
  to: string,
  iqId: string,
  card: A2aAgentCard | undefined,
): Element {
  if (!card) return itemNotFoundIq(from, to, iqId);
  return xml(
    'iq',
    { type: 'result', from, to, id: iqId },
    xml('query', { xmlns: A2A_NS }, xml('agentCard', {}, JSON.stringify(card))),
  );
}

export function buildPublishAgentCard(fromJid: string, pubsubService: string, card: A2aAgentCard): Element {
  return xml(
    'iq',
    { type: 'set', from: fromJid, to: pubsubService, id: `a2a-card-${ulid()}` },
    xml(
      'pubsub',
      { xmlns: PUBSUB_NS },
      xml(
        'publish',
        { node: A2A_AGENTCARD_PEP_NODE },
        xml('item', { id: 'current' }, agentCardElement(card)),
      ),
    ),
  );
}

function gatewayTarget(toBare: string, config: GatewayConfig): boolean {
  return toBare === bareJid(config.componentJid);
}

/** Handle A2A binding IQ gets routed to an agent bare JID or gateway. Returns null if unrelated. */
export function handleBindingIq(
  stanza: Element,
  config: GatewayConfig,
  registry: AgentRegistry,
): Element | null {
  if (stanza.name !== 'iq' || stanza.attrs.type !== 'get') return null;

  const toBare = ((stanza.attrs.to as string) || '').split('/')[0];
  const from = stanza.attrs.from as string;
  const iqId = stanza.attrs.id as string;
  if (!toBare || !from || !iqId) return null;

  const onAgent = isAgentJid(toBare, config.agentDomain);
  const onGateway = gatewayTarget(toBare, config);
  if (!onAgent && !onGateway) return null;

  const replyFrom = onAgent ? toBare : bareJid(config.componentJid);
  const card = onAgent ? registry.getAgentCard(toBare) : undefined;

  const pubsub = stanza.getChild('pubsub', PUBSUB_NS);
  if (pubsub && onAgent) {
    const items = pubsub.getChild('items');
    if (items?.attrs.node === A2A_AGENTCARD_PEP_NODE) {
      return buildAgentCardPubsubResponse(replyFrom, from, iqId, card);
    }
  }

  const a2aQuery = stanza.getChild('query', A2A_NS);
  if (a2aQuery && onAgent && a2aQuery.getChild('getAgentCard')) {
    return buildAgentCardA2aIqResponse(replyFrom, from, iqId, card);
  }

  const discoQuery = stanza.getChild('query', DISCO_NS);
  if (discoQuery) {
    if (onAgent) return buildAgentDiscoResponse(replyFrom, from, iqId, card);
    if (onGateway) return null;
  }

  return null;
}
