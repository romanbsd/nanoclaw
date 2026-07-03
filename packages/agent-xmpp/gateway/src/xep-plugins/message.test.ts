import { describe, expect, it } from 'vitest';
import { xml } from '@xmpp/xml';

import { extractStableId, isAgentJid, stanzaToAgentMessage } from './message.js';

describe('message plugin', () => {
  it('extracts stable id from stanza id attribute', () => {
    const stanza = xml('message', { id: 'msg-123', from: 'a@example.com', to: 'b@agents.test' });
    expect(extractStableId(stanza)).toBe('msg-123');
  });

  it('normalizes plain text DM', () => {
    const stanza = xml(
      'message',
      { id: 'm1', type: 'chat', from: 'human@example.com', to: 'assistant@agents.test' },
      xml('body', {}, 'Hello agent'),
    );
    const msg = stanzaToAgentMessage(stanza, 'agents.test');
    expect(msg).not.toBeNull();
    expect(msg!.kind).toBe('text');
    expect(msg!.body).toBe('Hello agent');
    expect(msg!.from).toBe('human@example.com');
  });

  it('detects agent JIDs on delegated domain', () => {
    expect(isAgentJid('planner@agents.test', 'agents.test')).toBe(true);
    expect(isAgentJid('human@example.com', 'agents.test')).toBe(false);
  });

  it('parses JSON payload namespace', () => {
    const stanza = xml(
      'message',
      { id: 'm2', type: 'chat', from: 'a@example.com', to: 'b@agents.test' },
      xml('body', {}, 'Task fallback'),
      xml(
        'payload',
        { xmlns: 'urn:xmpp:json-msg:0', datatype: 'application/json' },
        JSON.stringify({
          kind: 'task',
          contentType: 'application/vnd.businessos.agent-task+json',
          body: { task: 'Do something' },
        }),
      ),
    );
    const msg = stanzaToAgentMessage(stanza, 'agents.test');
    expect(msg!.kind).toBe('task');
    expect((msg!.body as { task: string }).task).toBe('Do something');
  });
});
