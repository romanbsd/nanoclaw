import { xml } from '@xmpp/xml';
import { describe, expect, it } from 'vitest';

import type { AskQuestionPayload } from '@agent-xmpp/protocol';

import {
  ASK_QUESTION_FORM_TYPE,
  buildAskQuestionFormStanza,
  DATA_FORM_NS,
  isAskQuestionContent,
  parseAskQuestionSubmit,
} from './data-form.js';

const payload: AskQuestionPayload = {
  type: 'ask_question',
  questionId: 'msg-test-1',
  title: 'Task selection',
  question: 'Which task would you like to start?',
  options: [
    { label: 'Review code changes', value: 'Review code changes' },
    { label: 'Run tests', value: 'Run tests' },
  ],
};

describe('data-form plugin', () => {
  it('detects ask_question content', () => {
    expect(isAskQuestionContent(payload)).toBe(true);
    expect(isAskQuestionContent({ type: 'card', card: {} })).toBe(false);
  });

  it('builds an XEP-0004 form stanza with body fallback', () => {
    const stanza = buildAskQuestionFormStanza(
      { from: 'agent@agents.test', to: 'human@example.com', content: payload },
      'agent@agents.test',
      payload,
    );
    expect(stanza.name).toBe('message');
    expect(stanza.attrs.type).toBe('chat');
    expect(stanza.getChildText('body')).toContain('Task selection');
    expect(stanza.getChildText('body')).toContain('Review code changes');

    const form = stanza.getChild('x', DATA_FORM_NS);
    expect(form?.attrs.type).toBe('form');
    expect(form?.getChildText('title')).toBe('Task selection');
    expect(form?.getChildText('instructions')).toBe('Which task would you like to start?');
  });

  it('parses ask_question form submits', () => {
    const submitStanza = xml(
      'message',
      { type: 'chat', from: 'human@example.com', to: 'agent@agents.test' },
      xml(
        'x',
        { xmlns: DATA_FORM_NS, type: 'submit' },
        xml('field', { var: 'FORM_TYPE' }, xml('value', {}, ASK_QUESTION_FORM_TYPE)),
        xml('field', { var: 'questionId' }, xml('value', {}, 'msg-test-1')),
        xml('field', { var: 'response' }, xml('value', {}, '1')),
      ),
    );
    expect(parseAskQuestionSubmit(submitStanza)).toEqual({
      questionId: 'msg-test-1',
      selectedIndex: 1,
    });
  });

  it('ignores unrelated data forms', () => {
    const other = xml(
      'message',
      { type: 'chat', from: 'human@example.com', to: 'agent@agents.test' },
      xml(
        'x',
        { xmlns: DATA_FORM_NS, type: 'submit' },
        xml('field', { var: 'FORM_TYPE' }, xml('value', {}, 'urn:other:form:0')),
      ),
    );
    expect(parseAskQuestionSubmit(other)).toBeNull();
  });

  it('builds groupchat stanzas for conference JIDs', () => {
    const stanza = buildAskQuestionFormStanza(
      {
        from: 'agent@agents.test',
        to: 'room@conference.agents.test',
        threadId: 'room@conference.agents.test',
        content: payload,
      },
      'agent@agents.test',
      payload,
    );
    expect(stanza.attrs.type).toBe('groupchat');
    expect(stanza.getChildText('thread')).toBe('room@conference.agents.test');
  });
});
