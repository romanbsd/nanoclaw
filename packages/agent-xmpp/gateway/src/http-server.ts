import { timingSafeEqual } from 'crypto';

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';

import {
  registrationFromDescriptor,
  type OutboundDeliverRequest,
  type OutboundDeliverResponse,
  type PublishAgentDescriptorRequest,
  type XmppAckInput,
  type XmppDiscoverAgentsInput,
  type XmppGetArchiveInput,
  type XmppJoinRoomInput,
  type XmppLeaveRoomInput,
  type XmppPublishEventInput,
  type XmppReplyInput,
  type XmppSendMessageInput,
  type XmppSendRoomMessageInput,
  type XmppSetPresenceInput,
  type XmppShareFileInput,
  type XmppUploadFileInput,
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
import { deliverLocalAgentMessage } from './agent-local-delivery.js';
import {
  createAgentSender,
  sendAgentStanzaRequired,
  sendComposingForAgent,
  sendPausedForAgent,
} from './agent-send.js';
import { isMucJid } from './xep-plugins/muc.js';
import { bareJid } from './xep-plugins/jid.js';
import type { AgentIngress } from './ingress/index.js';
import { buildPublishAgentCard } from './xep-plugins/a2a-binding.js';
import { xml } from './xmpp-component.js';

/** Strip a `Bearer ` scheme prefix if present, else return the raw header value. */
function bearerToken(header?: string): string {
  if (!header) return '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1] : header;
}

/** Constant-time secret comparison. Returns false on length mismatch (never throws). */
function secretMatches(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

export interface HttpServerDeps {
  config: GatewayConfig;
  mailbox: Mailbox;
  send: SendStanzaFn;
  agentRegistry: AgentRegistry;
  c2sIngress: AgentIngress;
  pendingIq: Map<string, { resolve: (stanza: unknown) => void; reject: (e: Error) => void }>;
  mamAwaiter: MamQueryAwaiter;
}

export async function createHttpServer(deps: HttpServerDeps) {
  const app = Fastify({ logger: true });
  const { config, mailbox, send, agentRegistry, c2sIngress, pendingIq, mamAwaiter } = deps;
  const sendOutbound = createAgentSender(c2sIngress, send);

  // Control-plane endpoints (register/unregister/publish descriptor) require this secret when set.
  // When unset, they are only reachable on a loopback bind (enforced before listen below).
  const requireControl = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!config.controlSecret) return true;
    if (secretMatches(bearerToken(req.headers.authorization), config.controlSecret)) return true;
    reply.status(401).send({ error: 'Unauthorized' });
    return false;
  };

  app.get('/health', async () => ({ ok: true, gatewayId: config.gatewayId }));

  app.post<{ Body: { from?: string; to: string; threadId?: string | null; state?: 'composing' | 'paused' } }>(
    '/v1/outbound/typing',
    async (req, reply) => {
      const fromJid = req.body.from || config.defaultAgentJid;
      const to = req.body.to;
      if (!to) {
        return reply.status(400).send({ error: 'to required' });
      }
      const targets = {
        to,
        threadId: req.body.threadId ?? null,
        groupchat: isMucJid(to),
      };
      if (req.body.state === 'paused') {
        await sendPausedForAgent((stanza) => sendOutbound(fromJid, stanza), fromJid, targets);
      } else {
        await sendComposingForAgent((stanza) => sendOutbound(fromJid, stanza), fromJid, targets);
      }
      return reply.send({ ok: true });
    },
  );

  app.post<{ Body: OutboundDeliverRequest & { from?: string } }>('/v1/outbound/deliver', async (req, reply) => {
    const body = req.body;
    const fromJid = body.from || config.defaultAgentJid;
    let stanza = buildOutboundStanza({ ...body, from: fromJid }, fromJid);
    stanza = applyStoreHints(stanza);
    await sendOutbound(fromJid, stanza);
    const messageId = (stanza.attrs.id as string) || '';
    // OpenFire may deliver agent→agent stanzas to user sessions; loop back through the bridge locally.
    await deliverLocalAgentMessage(config, mailbox, c2sIngress, agentRegistry, {
      fromJid,
      toJid: body.to,
      messageId,
      body: body.content,
      threadId: body.threadId ?? undefined,
      replyTo: body.inReplyTo ?? undefined,
    }).catch((err) => {
      console.error('[xmpp-gateway] agent loopback delivery failed:', err);
    });
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
    await sendOutbound(fromJid, applyStoreHints(stanza, req.body.policy));
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
    await sendOutbound(fromJid, applyStoreHints(stanza, req.body.policy));
    await deliverLocalAgentMessage(config, mailbox, c2sIngress, agentRegistry, {
      fromJid,
      toJid: req.body.to,
      messageId: stanza.attrs.id as string,
      body: req.body.body,
      threadId: req.body.threadId,
      replyTo: req.body.replyTo,
    }).catch((err) => {
      console.error('[xmpp-gateway] agent loopback delivery failed:', err);
    });
    return reply.send({ messageId: stanza.attrs.id });
  });

  app.post<{ Body: XmppJoinRoomInput & { from?: string } }>('/v1/tools/xmpp.join_room', async (req, reply) => {
    const fromJid = req.body.from || config.defaultAgentJid;
    const stanza = buildJoinPresence(req.body, fromJid);
    await sendOutbound(fromJid, stanza);
    return reply.send({ ok: true });
  });

  app.post<{ Body: XmppLeaveRoomInput & { from?: string } }>('/v1/tools/xmpp.leave_room', async (req, reply) => {
    const fromJid = req.body.from || config.defaultAgentJid;
    const stanza = buildLeavePresence(req.body, fromJid, req.body.nickname);
    await sendOutbound(fromJid, stanza);
    return reply.send({ ok: true });
  });

  app.post<{ Body: XmppSendRoomMessageInput & { from?: string } }>('/v1/tools/xmpp.send_room_message', async (req, reply) => {
    const fromJid = req.body.from || config.defaultAgentJid;
    const stanza = buildRoomMessage(req.body, fromJid);
    await sendOutbound(fromJid, stanza);
    return reply.send({ messageId: stanza.attrs.id });
  });

  app.post<{ Body: XmppPublishEventInput & { from?: string } }>('/v1/tools/xmpp.publish_event', async (req, reply) => {
    const fromJid = req.body.from || config.defaultAgentJid;
    const service = defaultPubsubService(config.agentDomain);
    await sendAgentStanzaRequired(fromJid, buildPublish(fromJid, service, req.body), c2sIngress);
    return reply.send({ ok: true, itemId: req.body.id || 'published' });
  });

  app.post<{ Body: XmppUploadFileInput & { from?: string; uploadService?: string } }>(
    '/v1/tools/xmpp.upload_file',
    async (req, reply) => {
      // Slot IQ results must return to the component JID, not a virtual user JID.
      const fromJid = req.body.from || config.componentJid;
      const uploadService = req.body.uploadService || `httpfileupload.${config.agentDomain}`;
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
    await sendOutbound(fromJid, applyStoreHints(stanza, req.body.policy));
    return reply.send({ messageId: stanza.attrs.id });
  });

  app.post<{ Body: XmppDiscoverAgentsInput }>('/v1/tools/xmpp.discover_agents', async (req, reply) => {
    return reply.send({ agents: agentRegistry.discover(req.body) });
  });

  app.get<{ Params: { jid: string } }>('/v1/agents/:jid/agentcard', async (req, reply) => {
    const jid = decodeURIComponent(req.params.jid);
    const card = agentRegistry.getAgentCard(jid);
    if (!card) {
      return reply.status(404).send({ error: `No Agent Card for ${jid}` });
    }
    return reply.send(card);
  });

  app.post<{ Body: PublishAgentDescriptorRequest }>('/v1/agents/publish_descriptor', async (req, reply) => {
    if (!requireControl(req, reply)) return;
    // Called by agent-runner on wake; feeds xmpp.discover_agents and capability-based routing.
    const descriptor = req.body;
    if (!descriptor.jid || !descriptor.tools || !descriptor.model || !descriptor.provider) {
      return reply.status(400).send({ error: 'Invalid descriptor: jid, tools, model, and provider are required' });
    }

    const { agent, agentCard } = registrationFromDescriptor(descriptor);
    agentRegistry.register(agent);

    const show = agent.status === 'busy' ? 'dnd' : undefined;
    const type = agent.status === 'offline' ? 'unavailable' : undefined;
    const children = [xml('status', {}, `health:${descriptor.health}`)];
    if (show) children.unshift(xml('show', {}, show));
    await sendAgentStanzaRequired(descriptor.jid, xml('presence', { from: descriptor.jid, type }, ...children), c2sIngress);

    const service = defaultPubsubService(config.agentDomain);
    const node = `agent-descriptor/${descriptor.jid.replace('@', '/')}`;
    await sendAgentStanzaRequired(
      descriptor.jid,
      buildPublish(descriptor.jid, service, {
        node,
        eventType: 'agent.runtime_descriptor',
        id: descriptor.publishedAt,
        body: descriptor,
        contentType: 'application/vnd.agent-xmpp.runtime-descriptor+json',
      }),
      c2sIngress,
    );

    await sendAgentStanzaRequired(descriptor.jid, buildPublishAgentCard(descriptor.jid, service, agentCard), c2sIngress);

    return reply.send({ ok: true, jid: descriptor.jid, agentCard });
  });

  app.post<{ Body: { jid: string; password: string } }>('/v1/agents/register_inbox', async (req, reply) => {
    if (!requireControl(req, reply)) return;
    const { jid, password } = req.body ?? {};
    if (!jid || typeof jid !== 'string' || !password || typeof password !== 'string') {
      return reply.status(400).send({ error: 'jid and password required' });
    }
    try {
      await c2sIngress.register(jid, password);
      return reply.send({ ok: true, jid: bareJid(jid), ingress: c2sIngress.kind });
      // eslint-disable-next-line no-catch-all/no-catch-all -- escalate to SIGKILL when register fails
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: message });
    }
  });

  app.post<{ Body: { jid: string } }>('/v1/agents/unregister', async (req, reply) => {
    if (!requireControl(req, reply)) return;
    const jid = req.body?.jid;
    if (!jid || typeof jid !== 'string') {
      return reply.status(400).send({ error: 'jid required' });
    }
    agentRegistry.unregister(jid);
    const bare = bareJid(jid);
    if (c2sIngress.hasSession?.(bare)) {
      await sendAgentStanzaRequired(bare, xml('presence', { from: bare, type: 'unavailable' }), c2sIngress);
    }
    await c2sIngress.unregister(jid);
    return reply.send({ ok: true, jid });
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
    await sendAgentStanzaRequired(fromJid, xml('presence', { from: fromJid, type }, ...children), c2sIngress);
    return reply.send({ ok: true });
  });

  app.post<{ Body: XmppAckInput & { from?: string; to?: string } }>('/v1/tools/xmpp.ack', async (req, reply) => {
    const fromJid = req.body.from || config.defaultAgentJid;
    const toJid = req.body.to;
    mailbox.markAcked(req.body.messageId, req.body.status === 'failed' ? 'failed' : 'acked');
    if (toJid) {
      const ack = buildAckStanza(toJid, fromJid, req.body.messageId, req.body.status);
      if (ack) await sendOutbound(fromJid, ack);
    }
    return reply.send({ ok: true });
  });

  if (!isLoopbackHost(config.httpHost) && !config.controlSecret) {
    throw new Error(
      `Refusing to bind XMPP gateway control API to non-loopback host ${config.httpHost} without XMPP_DESCRIPTOR_SECRET set`,
    );
  }

  await app.listen({ host: config.httpHost, port: config.httpPort });
  return app;
}
