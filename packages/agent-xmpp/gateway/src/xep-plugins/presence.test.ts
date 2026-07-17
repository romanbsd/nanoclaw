import { describe, expect, it } from 'vitest';
import { xml } from '@xmpp/xml';

import { presenceResponses } from './presence.js';

const agent = { jid: 'jane@agents.test', name: 'Jane' };

describe('virtual-agent presence', () => {
  it('answers a probe with available presence', () => {
    const [response] = presenceResponses(
      xml('presence', { type: 'probe', from: 'john@example.test/desktop', to: agent.jid }),
      agent,
    );
    expect(response.attrs.from).toBe(agent.jid);
    expect(response.attrs.to).toBe('john@example.test/desktop');
    expect(response.attrs.type).toBeUndefined();
    expect(response.getChildText('show')).toBe('chat');
  });

  it('accepts a subscription before publishing presence', () => {
    const responses = presenceResponses(
      xml('presence', { type: 'subscribe', from: 'john@example.test/desktop', to: agent.jid }),
      agent,
    );
    expect(responses.map((response) => response.attrs.type)).toEqual(['subscribed', undefined]);
  });
});
