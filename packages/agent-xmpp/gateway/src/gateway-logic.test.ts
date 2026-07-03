import { describe, expect, it } from 'vitest';

import { isAgentJid, resolveTargetAgentJid } from './xep-plugins/message.js';
import { isMucJid, mucRoomFromStanza } from './xep-plugins/muc.js';
import { defaultPubsubService } from './xep-plugins/pubsub.js';

/** Pure-logic tests that do not require XMPP connection or SQLite bindings. */
describe('gateway pure logic', () => {
  it('resolves agent JIDs on delegated domain', () => {
    expect(isAgentJid('assistant@agents.test', 'agents.test')).toBe(true);
    expect(resolveTargetAgentJid('assistant@agents.test', 'agents.test', 'default@agents.test')).toBe(
      'assistant@agents.test',
    );
    expect(resolveTargetAgentJid('user@example.com', 'agents.test', 'default@agents.test')).toBe(
      'default@agents.test',
    );
  });

  it('detects MUC JIDs', () => {
    expect(isMucJid('room@conference.example.com')).toBe(true);
    expect(mucRoomFromStanza('room@conference.example.com/nick')).toBe('room@conference.example.com');
  });

  it('derives pubsub service JID', () => {
    expect(defaultPubsubService('agents.example')).toBe('pubsub.agents.example');
  });
});
