import { describe, expect, it } from 'vitest';

import { buildComposingStanza, buildInactiveStanza, isChatStateStanza } from './chatstate.js';

describe('chatstate plugin', () => {
  it('builds a DM composing stanza', () => {
    const stanza = buildComposingStanza({
      from: 'agent@agents.test',
      to: 'human@example.com',
    });
    expect(stanza.name).toBe('message');
    expect(stanza.attrs.type).toBe('chat');
    expect(stanza.attrs.from).toBe('agent@agents.test');
    expect(stanza.attrs.to).toBe('human@example.com');
    expect(stanza.getChild('composing', 'http://jabber.org/protocol/chatstates')).not.toBeNull();
  });

  it('builds a MUC composing stanza with thread', () => {
    const stanza = buildComposingStanza({
      from: 'agent@agents.test',
      to: 'room@conference.agents.test',
      threadId: 'room@conference.agents.test',
      groupchat: true,
    });
    expect(stanza.attrs.type).toBe('groupchat');
    expect(stanza.getChildText('thread')).toBe('room@conference.agents.test');
  });

  it('detects composing-only stanzas', () => {
    const stanza = buildComposingStanza({
      from: 'human@example.com',
      to: 'agent@agents.test',
    });
    expect(isChatStateStanza(stanza)).toBe(true);
  });

  it('builds an inactive stanza to terminate composing state', () => {
    const stanza = buildInactiveStanza({
      from: 'agent@agents.test',
      to: 'human@example.com',
    });
    expect(stanza.getChild('inactive', 'http://jabber.org/protocol/chatstates')).not.toBeNull();
  });

  it('sends chat state to the originating full JID', () => {
    const stanza = buildInactiveStanza({
      from: 'agent@agents.test',
      to: 'human@example.com/client-1',
    });
    expect(stanza.attrs.to).toBe('human@example.com/client-1');
  });
});
