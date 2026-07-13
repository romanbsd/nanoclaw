import { describe, expect, it } from 'vitest';
import { xml } from '@xmpp/xml';

import type { RegisteredAgent } from '@agent-xmpp/protocol';

import { buildAgentVcard, VCARD_TEMP_NS } from './vcard.js';

describe('virtual-agent vCard', () => {
  it('renders identity from the registered manifest', () => {
    const agent = {
      manifest: {
        agent: {
          jid: 'jane@agents.test',
          name: 'jane',
          title: 'Jane',
          description: 'Thoughtful assistant',
          homepage: 'https://example.test/jane',
        },
      },
    } as RegisteredAgent;
    const response = buildAgentVcard(
      xml('iq', { type: 'get', id: 'v1', from: 'john@example.test/desktop', to: agent.manifest.agent.jid }),
      agent,
    );
    const card = response.getChild('vCard', VCARD_TEMP_NS);
    expect(response.attrs.from).toBe(agent.manifest.agent.jid);
    expect(card?.getChildText('FN')).toBe('Jane');
    expect(card?.getChildText('DESC')).toBe('Thoughtful assistant');
    expect(card?.getChildText('URL')).toBe('https://example.test/jane');
  });
});
