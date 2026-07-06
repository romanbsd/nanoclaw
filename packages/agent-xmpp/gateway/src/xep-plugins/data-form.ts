/** XEP-0004 Data Forms — ask_user_question multiple-choice via list-single fields. */

import { xml, type Element } from '@xmpp/xml';
import { ulid } from 'ulid';

import type { AskQuestionPayload, OutboundDeliverRequest } from '@agent-xmpp/protocol';

import { bareJid, isMucJid } from './jid.js';

export const DATA_FORM_NS = 'jabber:x:data';
export const ASK_QUESTION_FORM_TYPE = 'urn:xmpp:nanoclaw:ask-question:0';

const ORIGIN_ID_NS = 'urn:xmpp:sid:0';
const REPLY_NS = 'urn:xmpp:reply:0';

export interface AskQuestionSubmit {
  questionId: string;
  selectedIndex: number;
}

function optionLabel(raw: AskQuestionPayload['options'][number]): string {
  return typeof raw === 'string' ? raw : raw.label;
}

function buildBodyFallback(payload: AskQuestionPayload): string {
  const labels = payload.options.map(optionLabel);
  return `${payload.title}\n\n${payload.question}\n\nOptions: ${labels.join(', ')}`;
}

function hiddenField(varName: string, value: string): Element {
  return xml('field', { var: varName, type: 'hidden' }, xml('value', {}, value));
}

function listSingleField(payload: AskQuestionPayload): Element {
  const options = payload.options.map((raw, idx) =>
    xml('option', { label: optionLabel(raw) }, xml('value', {}, String(idx))),
  );
  return xml(
    'field',
    { var: 'response', type: 'list-single', label: 'Choose one' },
    ...options,
  );
}

export function isAskQuestionContent(content: unknown): content is AskQuestionPayload {
  if (!content || typeof content !== 'object') return false;
  const c = content as Record<string, unknown>;
  return (
    c.type === 'ask_question' &&
    typeof c.questionId === 'string' &&
    typeof c.title === 'string' &&
    typeof c.question === 'string' &&
    Array.isArray(c.options) &&
    c.options.length > 0
  );
}

export function buildAskQuestionFormStanza(req: OutboundDeliverRequest, fromJid: string, payload: AskQuestionPayload): Element {
  const id = ulid();
  const children: Element[] = [
    xml('body', {}, buildBodyFallback(payload)),
    xml(
      'x',
      { xmlns: DATA_FORM_NS, type: 'form' },
      xml('title', {}, payload.title),
      xml('instructions', {}, payload.question),
      hiddenField('FORM_TYPE', ASK_QUESTION_FORM_TYPE),
      hiddenField('questionId', payload.questionId),
      listSingleField(payload),
    ),
    xml('origin-id', { xmlns: ORIGIN_ID_NS, id }),
  ];

  if (req.threadId) {
    children.unshift(xml('thread', {}, req.threadId));
  }

  if (req.inReplyTo) {
    children.push(xml('reply', { xmlns: REPLY_NS, id: req.inReplyTo }));
  }

  const isMuc = isMucJid(req.to);
  const to = req.threadId && isMuc ? req.to : bareJid(req.to);
  const type = isMuc ? 'groupchat' : 'chat';

  return xml('message', { type, id, to, from: fromJid }, ...children);
}

function dataFormFieldValue(form: Element, varName: string): string | null {
  for (const child of form.children) {
    if (typeof child === 'string') continue;
    if (child.name !== 'field' || child.attrs.var !== varName) continue;
    const value = child.getChildText('value');
    return value ?? null;
  }
  return null;
}

export function parseAskQuestionSubmit(stanza: Element): AskQuestionSubmit | null {
  if (stanza.name !== 'message') return null;

  const form = stanza.getChild('x', DATA_FORM_NS);
  if (!form || form.attrs.type !== 'submit') return null;

  const formType = dataFormFieldValue(form, 'FORM_TYPE');
  if (formType !== ASK_QUESTION_FORM_TYPE) return null;

  const questionId = dataFormFieldValue(form, 'questionId');
  const responseRaw = dataFormFieldValue(form, 'response');
  if (!questionId || responseRaw === null) return null;

  const selectedIndex = Number(responseRaw);
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0) return null;

  return { questionId, selectedIndex };
}
