import { describe, expect, it } from 'vitest';

import { decideAgentLoopback } from './agent-loopback.js';
import type { AgentIngress } from './ingress/types.js';

const ingress = (sessions: string[]): AgentIngress => ({
  kind: 'c2s',
  register: async () => {},
  unregister: async () => {},
  stopAll: async () => {},
  hasSession: (jid) => sessions.includes(jid.split('/')[0]),
});

const registry = (jids: string[]) => ({
  hasAgent: (jid: string) => jids.includes(jid.split('/')[0]),
});

describe('decideAgentLoopback', () => {
  it('skips human peers on the agent domain (no gateway inbox)', () => {
    expect(
      decideAgentLoopback(
        'jane@example.org',
        'john@example.org',
        'example.org',
        ingress(['jane@example.org']),
      ),
    ).toEqual({ loopback: false, reason: 'no-agent-inbox' });
  });

  it('loops back to provisioned agents with C2S sessions', () => {
    expect(
      decideAgentLoopback(
        'jane@example.org',
        'mike@example.org',
        'example.org',
        ingress(['jane@example.org', 'mike@example.org']),
      ),
    ).toEqual({ loopback: true, reason: 'agent-inbox' });
  });

  it('loops back when target is in the agent registry before C2S connects', () => {
    expect(
      decideAgentLoopback(
        'jane@example.org',
        'mike@example.org',
        'example.org',
        ingress(['jane@example.org']),
        registry(['mike@example.org']),
      ),
    ).toEqual({ loopback: true, reason: 'agent-inbox' });
  });

  it('skips MUC room targets', () => {
    expect(
      decideAgentLoopback(
        'jane@example.org',
        'agents-lounge@conference.example.org',
        'example.org',
        ingress(['jane@example.org']),
      ),
    ).toEqual({ loopback: false, reason: 'muc-target' });
  });

  it('skips external JIDs on another domain', () => {
    expect(
      decideAgentLoopback(
        'jane@example.org',
        'human@other.test',
        'example.org',
        ingress(['jane@example.org']),
      ),
    ).toEqual({ loopback: false, reason: 'external-jid' });
  });
});
