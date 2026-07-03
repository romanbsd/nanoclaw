import { describe, expect, it } from 'vitest';
import { xml } from '@xmpp/xml';

import { MamQueryAwaiter } from './mam-query.js';

describe('MamQueryAwaiter', () => {
  it('collects forwarded messages until fin', () => {
    const awaiter = new MamQueryAwaiter();
    const queryId = 'mam-q1';
    awaiter.begin(queryId);

    const resultMsg = xml(
      'message',
      { from: 'archive@agents.test', to: 'bot@agents.test' },
      xml(
        'result',
        { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'r1' },
        xml(
          'forwarded',
          { xmlns: 'urn:xmpp:forward:0' },
          xml(
            'message',
            { id: 'm1', type: 'chat', from: 'human@example.com', to: 'bot@agents.test' },
            xml('body', {}, 'archived hello'),
          ),
        ),
      ),
    );

    const finMsg = xml(
      'message',
      { from: 'archive@agents.test', to: 'bot@agents.test' },
      xml('fin', { xmlns: 'urn:xmpp:mam:2', queryid: queryId, complete: 'true' }),
    );

    expect(awaiter.handleStanza(resultMsg, 'agents.test')).toBe(true);
    const done = awaiter.handleStanza(finMsg, 'agents.test');
    expect(done).toBe(true);

    const out = awaiter.takeResult(queryId, 'agents.test');
    expect(out?.messages).toHaveLength(1);
    expect(out?.messages[0].body).toBe('archived hello');
    expect(out?.paging?.complete).toBe(true);
  });
});
