/** XEP-0432-inspired JSON, XEP-0481, XEP-0461, XEP-0334, XEP-0359 */

import { xml, type Element } from '@xmpp/xml';
import { ulid } from 'ulid';

import type {
  AgentMessage,
  InboundMessage,
  MessageKind,
  MessagePolicy,
  OutboundDeliverRequest,
  XmppSourceMetadata,
} from '@agent-xmpp/protocol';

const JSON_NS = 'urn:xmpp:json-msg:0';
const ORIGIN_ID_NS = 'urn:xmpp:sid:0';
const REPLY_NS = 'urn:xmpp:reply:0';
const STORE_NS = 'urn:xmpp:hints';
const CONTENT_TYPE_NS = 'urn:xmpp:content-type:0';

export function extractStableId(stanza: Element): string {
  const attrId = stanza.attrs.id as string | undefined;
  if (attrId) return attrId;
  const origin = stanza.getChild('origin-id', ORIGIN_ID_NS);
  if (origin?.attrs.id) return origin.attrs.id as string;
  return ulid();
}

function payloadText(stanza: Element): string | null {
  const payload = stanza.getChild('payload', JSON_NS);
  if (!payload) return null;
  for (const child of payload.children) {
    if (typeof child === 'string' && child.trim()) return child;
  }
  const text = payload.getChildText('');
  return text || null;
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
  const threadId = threadEl?.getChildText('') || (threadEl?.attrs as { id?: string })?.id;

  const replyEl = stanza.getChild('reply', REPLY_NS);
  const replyTo = replyEl?.attrs.id as string | undefined;

  const json = parseJsonPayload(stanza);
  const text = bodyText(stanza);
  const isMuc = type === 'groupchat';
  const roomId = isMuc ? from.split('/')[0] : undefined;
  const fromBare = from.split('/')[0];

  let kind: MessageKind = json?.kind || 'text';
  let contentType = json?.contentType || 'text/plain';
  let body: unknown = json?.body ?? text;

  const ctEl = stanza.getChild('content-type', CONTENT_TYPE_NS);
  if (ctEl?.attrs.type) contentType = ctEl.attrs.type as string;

  if (!json && text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed.kind) kind = parsed.kind;
      if (parsed.contentType) contentType = parsed.contentType;
      body = parsed.body ?? parsed;
    } catch {
      /* plain text */
    }
  }

  const mentions = stanza.getChild('mentions');
  const extensions: Record<string, unknown> = {};
  if (mentions) extensions.mentions = mentions.toString();

  return {
    id,
    from: isMuc ? from : fromBare,
    to: to.split('/')[0],
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
  const bare = jid.split('/')[0];
  return bare.endsWith(`@${agentDomain}`);
}

export function resolveTargetAgentJid(to: string, agentDomain: string, defaultAgent: string): string {
  const bare = to.split('/')[0];
  if (isAgentJid(bare, agentDomain)) return bare;
  return defaultAgent;
}

export function buildOutboundStanza(req: OutboundDeliverRequest, fromJid: string): Element {
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

  if (req.threadId) {
    children.push(xml('thread', {}, req.threadId));
  }

  if (req.inReplyTo) {
    children.push(xml('reply', { xmlns: REPLY_NS, id: req.inReplyTo }));
  }

  children.push(
    xml('origin-id', { xmlns: ORIGIN_ID_NS, id: id }),
    xml('content-type', { xmlns: CONTENT_TYPE_NS, type: contentType }),
    xml('payload', { xmlns: JSON_NS, datatype: contentType }, JSON.stringify(payload)),
  );

  const to = req.threadId && req.to.includes('conference') ? req.to : req.to.split('/')[0];
  const type = req.to.includes('conference') ? 'groupchat' : 'chat';

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
