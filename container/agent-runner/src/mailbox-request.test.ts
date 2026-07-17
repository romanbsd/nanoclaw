import { describe, expect, it } from 'bun:test';

import { requestThroughMailbox } from './mailbox-request.js';

describe('requestThroughMailbox', () => {
  it('sends once, consumes the matching response, and parses it', async () => {
    let sends = 0;
    let polls = 0;
    const completed: string[] = [];

    const result = await requestThroughMailbox({
      send: () => sends++,
      findResponse: () => (++polls < 2 ? undefined : { id: 'response-1', content: '{"value":42}' }),
      complete: (id) => completed.push(id),
      parse: (content) => (JSON.parse(content) as { value: number }).value,
      timeoutMs: 100,
      pollIntervalMs: 1,
      timeoutMessage: 'timed out',
    });

    expect(result).toBe(42);
    expect(sends).toBe(1);
    expect(completed).toEqual(['response-1']);
  });

  it('times out without consuming a response', async () => {
    const completed: string[] = [];
    await expect(
      requestThroughMailbox({
        send: () => {},
        findResponse: () => undefined,
        complete: (id) => completed.push(id),
        parse: () => null,
        timeoutMs: 2,
        pollIntervalMs: 1,
        timeoutMessage: 'custom timeout',
      }),
    ).rejects.toThrow('custom timeout');
    expect(completed).toEqual([]);
  });

  it('marks a found response complete even when parsing fails', async () => {
    const completed: string[] = [];
    await expect(
      requestThroughMailbox({
        send: () => {},
        findResponse: () => ({ id: 'malformed', content: 'not-json' }),
        complete: (id) => completed.push(id),
        parse: JSON.parse,
        timeoutMs: 100,
        timeoutMessage: 'timed out',
      }),
    ).rejects.toThrow();
    expect(completed).toEqual(['malformed']);
  });
});
