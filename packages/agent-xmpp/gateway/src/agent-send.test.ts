import { xml } from '@xmpp/xml';
import { describe, expect, it, vi } from 'vitest';

import { sendAgentStanzaRequired, sendStanzaForAgent } from './agent-send.js';
import type { AgentIngress } from './ingress/types.js';

const ingress = (sessions: string[]): AgentIngress => ({
  kind: 'c2s',
  register: vi.fn(),
  unregister: vi.fn(),
  stopAll: vi.fn(),
  hasSession: (jid) => sessions.includes(jid.split('/')[0]),
  sendStanza: vi.fn().mockResolvedValue(undefined),
});

describe('sendAgentStanzaRequired', () => {
  it('throws when agent has no C2S session', async () => {
    await expect(
      sendAgentStanzaRequired('jane@example.org', xml('presence', { from: 'jane@example.org' }), ingress([])),
    ).rejects.toThrow(/register_inbox first/);
  });

  it('sends on the agent C2S session when registered', async () => {
    const c2s = ingress(['jane@example.org']);
    const stanza = xml('presence', { from: 'jane@example.org' });
    await sendAgentStanzaRequired('jane@example.org', stanza, c2s);
    expect(c2s.sendStanza).toHaveBeenCalledWith('jane@example.org', stanza);
  });
});

describe('sendStanzaForAgent', () => {
  it('uses C2S when sender has an inbox session', async () => {
    const c2s = ingress(['jane@example.org']);
    const componentSend = vi.fn().mockResolvedValue(undefined);
    const stanza = xml('message', { from: 'jane@example.org', to: 'john@example.org' });
    await sendStanzaForAgent('jane@example.org', stanza, c2s, componentSend);
    expect(c2s.sendStanza).toHaveBeenCalledWith('jane@example.org', stanza);
    expect(componentSend).not.toHaveBeenCalled();
  });

  it('falls back to component when sender has no inbox session', async () => {
    const c2s = ingress([]);
    const componentSend = vi.fn().mockResolvedValue(undefined);
    const stanza = xml('message', { from: 'jane@example.org', to: 'john@example.org' });
    await sendStanzaForAgent('jane@example.org', stanza, c2s, componentSend);
    expect(c2s.sendStanza).not.toHaveBeenCalled();
    expect(componentSend).toHaveBeenCalledWith(stanza);
  });
});
