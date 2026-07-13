/**
 * Message normalization and construction.
 *
 * The JSON payload nests its content in a <json xmlns='urn:xmpp:json:0'>
 * child per XEP-0335; `datatype` still carries a MIME type rather than a
 * schema namespace, and the JSON body is the gateway's own
 * kind/contentType/body envelope, not caller-defined XEP-0432 content —
 * both are deliberate gateway conventions, not spec violations. The reply
 * marker carries `to` per XEP-0461, but always uses `req.inReplyTo` as the
 * id regardless of 1:1 vs groupchat context; the spec's groupchat-specific
 * stanza-id-selection rule is not implemented. The content-type marker,
 * XEP-0334 processing hints, and XEP-0359 origin IDs use their standard
 * namespaces.
 *
 * @see https://xmpp.org/extensions/xep-0432.html
 * @see https://xmpp.org/extensions/xep-0481.html
 * @see https://xmpp.org/extensions/xep-0461.html
 * @see https://xmpp.org/extensions/xep-0334.html
 * @see https://xmpp.org/extensions/xep-0359.html
 * @see https://xmpp.org/extensions/xep-0335.html
 */

import { createHash } from 'crypto';

import { xml, type Element } from '@xmpp/xml';
import { ulid } from 'ulid';

import { bareJid, isMucJid } from './jid.js';

import type {
  AgentMessage,
  InboundMessage,
  MessageKind,
  MessagePolicy,
  OutboundDeliverRequest,
  XmppSourceMetadata,
} from '@agent-xmpp/protocol';

import { buildAskQuestionFormStanza, isAskQuestionContent } from './data-form.js';

const JSON_NS = 'urn:xmpp:json-msg:0';
const ORIGIN_ID_NS = 'urn:xmpp:sid:0';
const REPLY_NS = 'urn:xmpp:reply:0';
const STORE_NS = 'urn:xmpp:hints';
const CONTENT_TYPE_NS = 'urn:xmpp:content';

export function extractStableId(stanza: Element): string {
  const attrId = stanza.attrs.id as string | undefined;
  if (attrId) return attrId;
  const origin = stanza.getChild('origin-id', ORIGIN_ID_NS);
  if (origin?.attrs.id) return origin.attrs.id as string;
  // No stanza id: derive a deterministic id from content so a redelivered stanza
  // dedups instead of being processed twice. ponytail: content hash — two identical
  // id-less messages collide; acceptable since servers virtually always stamp `id`.
  const from = (stanza.attrs.from as string) || '';
  const to = (stanza.attrs.to as string) || '';
  const body = stanza.getChildText('body') || '';
  const thread = stanza.getChild('thread')?.getText() || '';
  const digest = createHash('sha256').update(`${from}\n${to}\n${thread}\n${body}`).digest('hex');
  return `derived-${digest.slice(0, 26)}`;
}

function payloadText(stanza: Element): string | null {
  const payload = stanza.getChild('payload', JSON_NS);
  if (!payload) return null;
  return payload.getChildText('json', 'urn:xmpp:json:0') || null;
}

function parseJsonPayload(stanza: Element): { kind: MessageKind; contentType: string; body: unknown } | null {
  const payload = stanza.getChild('payload', JSON_NS);
  if (!payload) return null;
  const datatype = (payload.attrs.datatype as string) || 'application/json';
  const raw = payloadText(stanza);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      kind?: MessageKind;
      contentType?: string;
      body?: unknown;
    };
    return {
      kind: parsed.kind || 'text',
      contentType: parsed.contentType || datatype,
      body: parsed.body ?? parsed,
    };
    // eslint-disable-next-line no-catch-all/no-catch-all -- malformed JSON payload falls back to raw text
  } catch {
    return { kind: 'text', contentType: datatype, body: raw };
  }
}

function bodyText(stanza: Element): string {
  return stanza.getChildText('body') || '';
}

export function stanzaToAgentMessage(stanza: Element, agentDomain: string): AgentMessage | null {
  if (stanza.name !== 'message') return null;
  const type = (stanza.attrs.type as string) || 'chat';
  if (type === 'error' || type === 'headline') return null;

  const from = stanza.attrs.from as string;
  const to = stanza.attrs.to as string;
  if (!from || !to) return null;

  const id = extractStableId(stanza);
  const threadEl = stanza.getChild('thread');
  // XEP-0201: the thread id is the element's text content, not a child or attribute.
  const threadId = threadEl?.getText()?.trim() || (threadEl?.attrs as { id?: string })?.id;

  const replyEl = stanza.getChild('reply', REPLY_NS);
  const replyTo = replyEl?.attrs.id as string | undefined;

  const json = parseJsonPayload(stanza);
  const text = bodyText(stanza);
  const isMuc = type === 'groupchat';
  const roomId = isMuc ? bareJid(from) : undefined;
  const fromBare = bareJid(from);

  let kind: MessageKind = json?.kind || 'text';
  let contentType = json?.contentType || 'text/plain';
  let body: unknown = json?.body ?? text;

  const ctEl = stanza.getChild('content', CONTENT_TYPE_NS);
  if (ctEl?.attrs.type) contentType = ctEl.attrs.type as string;

  if (!json && text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed.kind) kind = parsed.kind;
      if (parsed.contentType) contentType = parsed.contentType;
      body = parsed.body ?? parsed;
      // eslint-disable-next-line no-catch-all/no-catch-all -- body looks like JSON but isn't; keep as plain text
    } catch {
      /* plain text */
    }
  }

  const mentions = stanza
    .getChildren('mention', 'urn:xmpp:mentions:0')
    .map((el) => el.attrs.jid as string)
    .filter(Boolean);
  const extensions: Record<string, unknown> = {};
  if (mentions.length) extensions.mentions = mentions;

  return {
    id,
    from: isMuc ? from : fromBare,
    to: bareJid(to),
    threadId: threadId || undefined,
    roomId,
    kind,
    contentType,
    body,
    replyTo,
    extensions: Object.keys(extensions).length ? extensions : undefined,
  };
}

export function buildInboundEnvelope(
  msg: AgentMessage,
  gatewayId: string,
  deliveryId: string,
  xmppMeta: XmppSourceMetadata,
  redelivered?: boolean,
): InboundMessage {
  return {
    type: 'inbound.message',
    message: msg,
    delivery: {
      receivedAt: new Date().toISOString(),
      gatewayId,
      deliveryId,
      redelivered,
    },
    xmpp: xmppMeta,
  };
}

export function isAgentJid(jid: string, agentDomain: string): boolean {
  const bare = bareJid(jid);
  return bare.endsWith(`@${agentDomain}`);
}

export function resolveTargetAgentJid(to: string, agentDomain: string, defaultAgent: string): string {
  const bare = bareJid(to);
  if (isAgentJid(bare, agentDomain)) return bare;
  // Traffic to the bare component address is attributed to the default agent for this gateway.
  return defaultAgent;
}

export function buildOutboundStanza(req: OutboundDeliverRequest, fromJid: string): Element {
  if (isAskQuestionContent(req.content)) {
    return buildAskQuestionFormStanza(req, fromJid, req.content);
  }

  const id = ulid();
  const text =
    typeof req.content === 'string'
      ? req.content
      : (req.content as { text?: string })?.text ||
        (typeof req.content === 'object' && req.content !== null
          ? JSON.stringify(req.content)
          : String(req.content));

  const contentType = 'text/plain';
  const payload = {
    kind: 'text',
    contentType,
    body: req.content,
  };

  const children: Element[] = [xml('body', {}, text)];
  const isMuc = isMucJid(req.to);

  if (req.threadId) {
    children.push(xml('thread', {}, req.threadId));
  }

  if (req.inReplyTo) {
    // XEP-0461: bare JID is only a MAY for 1:1; groupchat wants the full JID.
    children.push(xml('reply', { xmlns: REPLY_NS, id: req.inReplyTo, to: isMuc ? req.to : bareJid(req.to) }));
  }

  children.push(
    xml('origin-id', { xmlns: ORIGIN_ID_NS, id: id }),
    xml('content', { xmlns: CONTENT_TYPE_NS, type: contentType }),
    xml(
      'payload',
      { xmlns: JSON_NS, datatype: contentType },
      xml('json', { xmlns: 'urn:xmpp:json:0' }, JSON.stringify(payload)),
    ),
  );

  // RFC 6121 section 8.5.2.1: preserve a full JID when replying to the
  // resource that originated a 1:1 chat. Proactive sends can still use bare JIDs.
  const to = req.threadId && isMuc ? req.to : isMuc ? bareJid(req.to) : req.to;
  const type = isMuc ? 'groupchat' : 'chat';

  return xml('message', { type, id, to, from: fromJid }, ...children);
}

export function applyStoreHints(stanza: Element, policy?: MessagePolicy): Element {
  if (policy?.store === false) {
    return xml(
      'message',
      stanza.attrs,
      ...stanza.children,
      xml('no-store', { xmlns: STORE_NS }),
    );
  }
  if (policy?.store === true) {
    return xml(
      'message',
      stanza.attrs,
      ...stanza.children,
      xml('store', { xmlns: STORE_NS }),
    );
  }
  return stanza;
}
