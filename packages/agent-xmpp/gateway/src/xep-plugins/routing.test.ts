import { describe, expect, it } from 'vitest';

import { isMentionForAgent, shouldDeliverInbound } from './routing.js';

describe('shouldDeliverInbound', () => {
  it('delivers all direct chat messages', () => {
    expect(shouldDeliverInbound('chat', false, false)).toBe(true);
  });

  it('delivers MUC only when mentioned', () => {
    expect(shouldDeliverInbound('groupchat', true, false)).toBe(false);
    expect(shouldDeliverInbound('groupchat', true, true)).toBe(true);
  });
});

describe('isMentionForAgent', () => {
  it('treats direct chat as implicit mention', () => {
    expect(isMentionForAgent('chat', 'hello', 'planner')).toBe(true);
  });

  it('detects @nick in room messages', () => {
    expect(isMentionForAgent('groupchat', '@planner please help', 'planner')).toBe(true);
    expect(isMentionForAgent('groupchat', 'hello everyone', 'planner')).toBe(false);
  });
});
