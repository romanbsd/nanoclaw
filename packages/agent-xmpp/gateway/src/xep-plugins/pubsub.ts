/** XEP-0060 Publish-Subscribe */

import { xml, type Element } from '@xmpp/xml';
import { ulid } from 'ulid';

import type { XmppPublishEventInput } from '@agent-xmpp/protocol';

const PUBSUB_NS = 'http://jabber.org/protocol/pubsub';

export function buildPublish(from: string, pubsubService: string, input: XmppPublishEventInput): Element {
  const itemId = input.id || `item-${ulid()}`;
  const payload = JSON.stringify({
    eventType: input.eventType,
    body: input.body,
    contentType: input.contentType || 'application/json',
    trace: input.trace,
    policy: input.policy,
  });

  return xml(
    'iq',
    { type: 'set', from, to: pubsubService, id: `pubsub-${itemId}` },
    xml(
      'pubsub',
      { xmlns: PUBSUB_NS },
      xml(
        'publish',
        { node: input.node },
        xml('item', { id: itemId }, xml('event', { xmlns: 'urn:xmpp:agent-event:0' }, payload)),
      ),
    ),
  );
}

export function defaultPubsubService(agentDomain: string): string {
  return `pubsub.${agentDomain}`;
}
