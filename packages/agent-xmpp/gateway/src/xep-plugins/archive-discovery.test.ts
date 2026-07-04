import { describe, expect, it } from 'vitest';

import { buildMamQuery } from './mam.js';
import { buildPublish, defaultPubsubService } from './pubsub.js';
import { AgentRegistry, buildDiscoInfo } from './discovery.js';

describe('mam plugin', () => {
  it('builds MAM query IQ', () => {
    const iq = buildMamQuery('bot@agents.test', { with: 'user@example.com', limit: 10 });
    expect(iq.name).toBe('iq');
  });
});

describe('pubsub plugin', () => {
  it('builds publish IQ', () => {
    const iq = buildPublish('bot@agents.test', defaultPubsubService('agents.test'), {
      node: 'events',
      eventType: 'workflow.completed',
      body: { ok: true },
    });
    expect(iq.getChild('pubsub', 'http://jabber.org/protocol/pubsub')).toBeDefined();
  });
});

describe('discovery plugin', () => {
  it('discovers registered agents', () => {
    const reg = new AgentRegistry();
    reg.register({ jid: 'a@agents.test', capabilities: ['chat'], status: 'available' });
    reg.register({ jid: 'b@agents.test', capabilities: ['muc'], status: 'offline' });
    const found = reg.discover({ query: 'a', includeUnavailable: false });
    expect(found).toHaveLength(1);
    expect(found[0].jid).toBe('a@agents.test');
  });

  it('builds disco info query', () => {
    const iq = buildDiscoInfo('bot@agents.test', 'user@example.com');
    expect(iq.name).toBe('iq');
  });

  it('filters by tool names in runtime descriptor metadata', () => {
    const reg = new AgentRegistry();
    reg.register({
      jid: 'crm@example.org',
      capabilities: ['xmpp'],
      status: 'available',
      metadata: {
        runtimeDescriptor: {
          tools: [{ name: 'lookup_contact' }],
        },
      },
    });
    expect(reg.discover({ capabilities: ['lookup_contact'] })).toHaveLength(1);
    expect(reg.discover({ capabilities: ['missing'] })).toHaveLength(0);
  });
});
