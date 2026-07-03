import Fastify from 'fastify';

import type {
  OutboundDeliverRequest,
  OutboundDeliverResponse,
  XmppAckInput,
  XmppDiscoverAgentsInput,
  XmppGetArchiveInput,
  XmppJoinRoomInput,
  XmppLeaveRoomInput,
  XmppPublishEventInput,
  XmppReplyInput,
  XmppSendMessageInput,
  XmppSendRoomMessageInput,
  XmppSetPresenceInput,
  XmppShareFileInput,
  XmppUploadFileInput,
} from '@agent-xmpp/protocol';

import type { GatewayConfig } from './config.js';
import type { Mailbox } from './mailbox.js';
import { resolveReplyTarget } from './reply.js';
import { AgentRegistry } from './xep-plugins/discovery.js';
import { buildSlotRequest, buildFileShareStanza, decodeUploadInput, parseSlotResponse, sha256Hex, uploadBytes } from './xep-plugins/file-upload.js';
import { buildMamQuery } from './xep-plugins/mam.js';
import { MamQueryAwaiter } from './xep-plugins/mam-query.js';
import { applyStoreHints, buildOutboundStanza } from './xep-plugins/message.js';
import { buildJoinPresence, buildLeavePresence, buildRoomMessage } from './xep-plugins/muc.js';
import { defaultPubsubService, buildPublish } from './xep-plugins/pubsub.js';
import { buildAckStanza } from './xep-plugins/receipts.js';
import type { SendStanzaFn } from './stanza-router.js';
import { xml } from './xmpp-component.js';

export interface HttpServerDeps {
  config: GatewayConfig;
  mailbox: Mailbox;
  send: SendStanzaFn;
  agentRegistry: AgentRegistry;
  pendingIq: Map<string, { resolve: (stanza: unknown) => void; reject: (e: Error) => void }>;
  mamAwaiter: MamQueryAwaiter;
}

export async function createHttpServer(deps: HttpServerDeps) {
  const app = Fastify({ logger: true });
  const { config, mailbox, send, agentRegistry, pendingIq, mamAwaiter } = deps;

  app.get('/health', async () => ({ ok: true, gatewayId: config.gatewayId }));

  app.post<{ Body: OutboundDeliverRequest & { from?: string } }>('/v1/outbound/deliver', async (req, reply) => {
    const body = req.body;
    const fromJid = body.from || config.defaultAgentJid;
    let stanza = buildOutboundStanza({ ...body, from: fromJid }, fromJid);
    stanza = applyStoreHints(stanza);
    await send(stanza);
    const messageId = (stanza.attrs.id as string) || '';
    const res: OutboundDeliverResponse = { messageId };
    return reply.send(res);
  });

  app.post<{ Body: XmppReplyInput & { from?: string; to?: string } }>('/v1/tools/xmpp.reply', async (req, reply) => {
    const { inReplyTo, body, threadId, from, to } = req.body;
    const fromJid = from || config.defaultAgentJid;
    const original = mailbox.resolveMessage(inReplyTo);
    const target = resolveReplyTarget(original, to, threadId);
    if (!target) {
      return reply.status(400).send({ error: `Unknown inReplyTo: ${inReplyTo}` });
    }
    const stanza = buildOutboundStanza(
      {
        from: fromJid,
        to: target.to,
        threadId: target.threadId,
        content: body,
        inReplyTo,
      },
      fromJid,
    );
    await send(applyStoreHints(stanza, req.body.policy));
    return reply.send({ messageId: stanza.attrs.id });
  });

  app.post<{ Body: XmppSendMessageInput & { from?: string } }>('/v1/tools/xmpp.send_message', async (req, reply) => {
    const fromJid = req.body.from || config.defaultAgentJid;
    const stanza = buildOutboundStanza(
      {
        from: fromJid,
        to: req.body.to,
        threadId: req.body.threadId,
        content: req.body.body,
        inReplyTo: req.body.replyTo,
      },
      fromJid,
    );
    await send(applyStoreHints(stanza, req.body.policy));
    return reply.send({ messageId: stanza.attrs.id });
  });

  app.post<{ Body: XmppJoinRoomInput & { from?: string } }>('/v1/tools/xmpp.join_room', async (req, reply) => {
    const fromJid = req.body.from || config.defaultAgentJid;
    await send(buildJoinPresence(req.body, fromJid));
    return reply.send({ ok: true });
  });

  app.post<{ Body: XmppLeaveRoomInput & { from?: string } }>('/v1/tools/xmpp.leave_room', async (req, reply) => {
    const fromJid = req.body.from || config.defaultAgentJid;
    await send(buildLeavePresence(req.body, fromJid));
    return reply.send({ ok: true });
  });

  app.post<{ Body: XmppSendRoomMessageInput & { from?: string } }>('/v1/tools/xmpp.send_room_message', async (req, reply) => {
    const fromJid = req.body.from || config.defaultAgentJid;
    const stanza = buildRoomMessage(req.body, fromJid);
    await send(stanza);
    return reply.send({ messageId: stanza.attrs.id });
  });

  app.post<{ Body: XmppPublishEventInput & { from?: string } }>('/v1/tools/xmpp.publish_event', async (req, reply) => {
    const fromJid = req.body.from || config.defaultAgentJid;
    const service = defaultPubsubService(config.agentDomain);
    await send(buildPublish(fromJid, service, req.body));
    return reply.send({ ok: true, itemId: req.body.id || 'published' });
  });

  app.post<{ Body: XmppUploadFileInput & { from?: string; uploadService?: string } }>(
    '/v1/tools/xmpp.upload_file',
    async (req, reply) => {
      const fromJid = req.body.from || config.defaultAgentJid;
      const uploadService = req.body.uploadService || `upload.${config.agentDomain}`;
      const { bytes, name, mediaType } = decodeUploadInput(req.body);
      const hash = sha256Hex(bytes);
      const iq = buildSlotRequest(fromJid, uploadService, bytes.length, mediaType, name);
      const iqId = iq.attrs.id as string;

      const slotPromise = new Promise<{ putUrl: string; getUrl: string }>((resolve, reject) => {
        pendingIq.set(iqId, {
          resolve: (stanza) => {
            const parsed = parseSlotResponse(stanza as ReturnType<typeof xml>);
            if (parsed) resolve(parsed);
            else reject(new Error('Invalid slot response'));
          },
          reject,
        });
        setTimeout(() => {
          if (pendingIq.has(iqId)) {
            pendingIq.delete(iqId);
            reject(new Error('Upload slot request timed out'));
          }
        }, 15000);
      });

      await send(iq);
      const slot = await slotPromise;
      await uploadBytes(slot.putUrl, bytes, mediaType);
      return reply.send({
        file: {
          name,
          url: slot.getUrl,
          mediaType,
          sizeBytes: bytes.length,
          sha256: hash,
        },
      });
    },
  );

  app.post<{ Body: XmppShareFileInput & { from?: string } }>('/v1/tools/xmpp.share_file', async (req, reply) => {
    const fromJid = req.body.from || config.defaultAgentJid;
    const stanza = buildFileShareStanza(req.body.to, fromJid, req.body.file, req.body.note, req.body.threadId);
    await send(applyStoreHints(stanza, req.body.policy));
    return reply.send({ messageId: stanza.attrs.id });
  });

  app.post<{ Body: XmppDiscoverAgentsInput }>('/v1/tools/xmpp.discover_agents', async (req, reply) => {
    agentRegistry.register({
      jid: config.defaultAgentJid,
      name: 'Default Agent',
      capabilities: ['chat', 'muc', 'pubsub', 'mam', 'file-upload'],
      status: 'available',
    });
    return reply.send({ agents: agentRegistry.discover(req.body) });
  });

  app.post<{ Body: XmppGetArchiveInput & { from?: string } }>('/v1/tools/xmpp.get_archive', async (req, reply) => {
    const fromJid = req.body.from || config.defaultAgentJid;
    const iq = buildMamQuery(fromJid, req.body);
    const queryId = iq.attrs.id as string;
    mamAwaiter.begin(queryId);
    await send(iq);
    const result = await mamAwaiter.waitFor(queryId, config.agentDomain);
    return reply.send(result);
  });

  app.post<{ Body: XmppSetPresenceInput & { from?: string } }>('/v1/tools/xmpp.set_presence', async (req, reply) => {
    const fromJid = req.body.from || config.defaultAgentJid;
    const show = req.body.status === 'away' ? 'away' : req.body.status === 'busy' ? 'dnd' : undefined;
    const type = req.body.status === 'offline' ? 'unavailable' : undefined;
    const children = req.body.message ? [xml('status', {}, req.body.message)] : [];
    if (show) children.unshift(xml('show', {}, show));
    await send(xml('presence', { from: fromJid, type }, ...children));
    return reply.send({ ok: true });
  });

  app.post<{ Body: XmppAckInput & { from?: string; to?: string } }>('/v1/tools/xmpp.ack', async (req, reply) => {
    const fromJid = req.body.from || config.defaultAgentJid;
    const toJid = req.body.to;
    mailbox.markAcked(req.body.messageId, req.body.status === 'failed' ? 'failed' : 'acked');
    if (toJid) {
      await send(buildAckStanza(toJid, fromJid, req.body.messageId, req.body.status));
    }
    return reply.send({ ok: true });
  });

  await app.listen({ host: config.httpHost, port: config.httpPort });
  return app;
}
