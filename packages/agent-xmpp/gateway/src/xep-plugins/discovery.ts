/** XEP-0030 Service Discovery, XEP-0115 Entity Capabilities (basic) */

import { xml, type Element } from '@xmpp/xml';

import { A2A_XMPP_BINDING_URI, type A2aAgentCard, type AgentDescriptor, type XmppDiscoverAgentsInput } from '@agent-xmpp/protocol';

const DISCO_NS = 'http://jabber.org/protocol/disco#info';

export function buildDiscoInfo(to: string, from: string): Element {
  return xml('iq', { type: 'get', from, to, id: `disco-${Date.now()}` }, xml('query', { xmlns: DISCO_NS }));
}

export function buildGatewayDiscoResponse(from: string, to: string, agentDomain: string, iqId: string): Element {
  return xml(
    'iq',
    { type: 'result', from, to, id: iqId },
    xml(
      'query',
      { xmlns: DISCO_NS },
      xml('identity', { category: 'gateway', type: 'agent', name: 'Agent XMPP Gateway' }),
      xml('feature', { var: A2A_XMPP_BINDING_URI }),
      xml('feature', { var: 'urn:xmpp:mam:2' }),
      xml('feature', { var: 'http://jabber.org/protocol/muc' }),
      xml('feature', { var: 'urn:xmpp:http:upload:0' }),
      xml('feature', { var: 'http://jabber.org/protocol/pubsub' }),
      xml('feature', { var: `agents.${agentDomain}` }),
    ),
  );
}

/** In-memory agent registry for discovery until full disco#items is wired. */
export class AgentRegistry {
  private agents = new Map<string, AgentDescriptor>();

  register(descriptor: AgentDescriptor): void {
    this.agents.set(descriptor.jid, descriptor);
  }

  unregister(jid: string): void {
    this.agents.delete(jid);
  }

  getAgentCard(jid: string): A2aAgentCard | undefined {
    return this.agents.get(jid)?.agentCard;
  }

  discover(input: XmppDiscoverAgentsInput): AgentDescriptor[] {
    let list = [...this.agents.values()];
    if (input.query) {
      const q = input.query.toLowerCase();
      list = list.filter(
        (a) =>
          a.jid.toLowerCase().includes(q) ||
          a.name?.toLowerCase().includes(q) ||
          a.description?.toLowerCase().includes(q),
      );
    }
    if (input.capabilities?.length) {
      list = list.filter((a) => {
        const toolNames =
          (a.metadata?.runtimeDescriptor as { tools?: Array<{ name: string }> } | undefined)?.tools?.map(
            (t) => t.name,
          ) ?? [];
        // Capability filter matches both declared caps and MCP tool names from the runtime descriptor.
        const caps = [...a.capabilities, ...toolNames];
        return input.capabilities!.every((c) => caps.includes(c));
      });
    }
    if (!input.includeUnavailable) {
      list = list.filter((a) => a.status !== 'offline' && a.status !== 'dormant');
    }
    return list;
  }
}

export function parseDiscoInfo(stanza: Element): { features: string[]; identities: Array<{ category: string; type: string; name?: string }> } {
  const query = stanza.getChild('query', DISCO_NS);
  const features: string[] = [];
  const identities: Array<{ category: string; type: string; name?: string }> = [];
  if (!query) return { features, identities };
  for (const child of query.children as Element[]) {
    if (child.name === 'feature' && child.attrs.var) features.push(child.attrs.var as string);
    if (child.name === 'identity') {
      identities.push({
        category: child.attrs.category as string,
        type: child.attrs.type as string,
        name: child.attrs.name as string | undefined,
      });
    }
  }
  return { features, identities };
}
