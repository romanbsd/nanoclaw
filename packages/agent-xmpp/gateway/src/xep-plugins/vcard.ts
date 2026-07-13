/** vCard-temp identity for virtual agents. @see https://xmpp.org/extensions/xep-0054.html */
import type { RegisteredAgent } from '@agent-xmpp/protocol';
import { xml, type Element } from '@xmpp/xml';

export const VCARD_TEMP_NS = 'vcard-temp';

export function buildAgentVcard(request: Element, agent: RegisteredAgent): Element {
  const identity = agent.manifest.agent;
  const children = [
    xml('FN', {}, identity.title ?? identity.name),
    xml('NICKNAME', {}, identity.name),
    xml('JABBERID', {}, identity.jid),
    ...(identity.description ? [xml('DESC', {}, identity.description)] : []),
    ...(identity.homepage ? [xml('URL', {}, identity.homepage)] : []),
  ];
  return xml(
    'iq',
    { type: 'result', id: request.attrs.id, from: identity.jid, to: request.attrs.from },
    xml('vCard', { xmlns: VCARD_TEMP_NS }, ...children),
  );
}
