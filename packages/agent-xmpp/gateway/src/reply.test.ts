import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@agent-xmpp/protocol';

import { resolveReplyTarget } from './reply.js';

const original: AgentMessage = {
  id: 'msg_parent',
  from: 'human@example.com',
  to: 'assistant@agents.test',
  threadId: 't1',
  kind: 'text',
  contentType: 'text/plain',
  body: 'hello',
};

describe('resolveReplyTarget', () => {
  it('uses explicit to when provided', () => {
    expect(resolveReplyTarget(original, 'other@example.com')).toEqual({
      to: 'other@example.com',
      threadId: 't1',
    });
  });

  it('replies to DM sender when to omitted', () => {
    expect(resolveReplyTarget(original)).toEqual({
      to: 'human@example.com',
      threadId: 't1',
    });
  });

  it('replies to MUC room when roomId set', () => {
    const roomMsg: AgentMessage = {
      ...original,
      from: 'room@conference.example/nick',
      roomId: 'room@conference.example',
    };
    expect(resolveReplyTarget(roomMsg)).toEqual({
      to: 'room@conference.example',
      threadId: 't1',
    });
  });

  it('returns null when original missing and to omitted', () => {
    expect(resolveReplyTarget(null)).toBeNull();
  });
});
