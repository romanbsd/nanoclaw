import { describe, expect, it } from 'vitest';
import { xml } from '@xmpp/xml';

import type { AskQuestionPayload } from '@agent-xmpp/protocol';

import { DATA_FORM_NS } from './data-form.js';
import { buildOutboundStanza, extractStableId, isAgentJid, stanzaToAgentMessage } from './message.js';

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
        xml(
          'json',
          { xmlns: 'urn:xmpp:json:0' },
          JSON.stringify({
            kind: 'task',
            contentType: 'application/vnd.businessos.agent-task+json',
            body: { task: 'Do something' },
          }),
        ),
      ),
    );
    const msg = stanzaToAgentMessage(stanza, 'agents.test');
    expect(msg!.kind).toBe('task');
    expect((msg!.body as { task: string }).task).toBe('Do something');
  });

  it('builds XEP-0004 form for ask_question payloads', () => {
    const payload: AskQuestionPayload = {
      type: 'ask_question',
      questionId: 'msg-1',
      title: 'Confirm',
      question: 'Proceed?',
      options: ['Yes', 'No'],
    };
    const stanza = buildOutboundStanza(
      { from: 'agent@agents.test', to: 'human@example.com', content: payload },
      'agent@agents.test',
    );
    expect(stanza.getChild('x', DATA_FORM_NS)).not.toBeNull();
    expect(stanza.getChildText('body')).toContain('Proceed?');
    expect(stanza.getChild('payload', 'urn:xmpp:json-msg:0')).toBeUndefined();
  });

  it('replies to the full JID that originated a DM', () => {
    const stanza = buildOutboundStanza(
      { from: 'agent@agents.test', to: 'human@example.com/client-1', content: 'Hello' },
      'agent@agents.test',
    );
    expect(stanza.attrs.to).toBe('human@example.com/client-1');
  });
});
