import { describe, expect, it } from 'vitest';
import { xml } from '@xmpp/xml';

import { buildPingResponse, isPingRequest, PING_NS } from './ping.js';

describe('XEP-0199 ping', () => {
  it('recognizes a ping and mirrors addressing in the result', () => {
    const request = xml(
      'iq',
      { type: 'get', id: 'ping-1', from: 'human@example.test/mobile', to: 'agent@agents.test' },
      xml('ping', { xmlns: PING_NS }),
    );
    expect(isPingRequest(request)).toBe(true);
    const response = buildPingResponse(request);
    expect(response.attrs).toMatchObject({
      type: 'result', id: 'ping-1', from: 'agent@agents.test', to: 'human@example.test/mobile',
    });
  });
});
