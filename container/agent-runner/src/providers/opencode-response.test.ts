import { describe, expect, it } from 'bun:test';

import { extractLatestAssistantText, latestAssistantFailed } from './opencode.js';

describe('extractLatestAssistantText', () => {
  it('returns the latest non-empty assistant text from the completed session', () => {
    expect(
      extractLatestAssistantText([
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
        { info: { role: 'assistant' }, parts: [{ type: 'reasoning', text: 'thinking' }] },
        {
          info: { role: 'assistant' },
          parts: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'from Jane.' },
          ],
        },
      ]),
    ).toBe('Hello from Jane.');
  });

  it('returns null when OpenCode emitted no assistant text', () => {
    expect(
      extractLatestAssistantText([{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] }]),
    ).toBeNull();
  });
});

describe('latestAssistantFailed', () => {
  it('detects an assistant turn that OpenCode completed as an error', () => {
    expect(
      latestAssistantFailed([
        { info: { role: 'user' } },
        { info: { role: 'assistant', finish: 'error' }, parts: [{ type: 'step-finish' }] },
      ]),
    ).toBeTrue();
  });

  it('ignores earlier failures when the latest assistant turn succeeded', () => {
    expect(
      latestAssistantFailed([
        { info: { role: 'assistant', finish: 'error' } },
        { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'ok' }] },
      ]),
    ).toBeFalse();
  });
});
