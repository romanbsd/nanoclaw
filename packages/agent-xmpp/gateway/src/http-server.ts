import Fastify from 'fastify';

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
import { createAgentSender, sendComposingForAgent, sendStanzaForAgent } from './agent-send.js';
import { isMucJid } from './xep-plugins/muc.js';
import type { AgentIngress } from './ingress/index.js';
import { buildPublishAgentCard } from './xep-plugins/a2a-binding.js';
import { xml } from './xmpp-component.js';

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

  app.get('/health', async () => ({ ok: true, gatewayId: config.gatewayId }));

  app.post<{ Body: { from?: string; to: string; threadId?: string | null } }>(
    '/v1/outbound/typing',
    async (req, reply) => {
      const fromJid = req.body.from || config.defaultAgentJid;
      const to = req.body.to;
      if (!to) {
        return reply.status(400).send({ error: 'to required' });
      }
      await sendComposingForAgent(createAgentSender(c2sIngress, send), fromJid, {
        to,
        threadId: req.body.threadId ?? null,
        groupchat: isMucJid(to),
      });
      return reply.send({ ok: true });
    },
  );

  app.post<{ Body: OutboundDeliverRequest & { from?: string } }>('/v1/outbound/deliver', async (req, reply) => {
    const body = req.body;
    const fromJid = body.from || config.defaultAgentJid;
    let stanza = buildOutboundStanza({ ...body, from: fromJid }, fromJid);
    stanza = applyStoreHints(stanza);
    await send(stanza);
    const messageId = (stanza.attrs.id as string) || '';
    // OpenFire may deliver agent→agent stanzas to user sessions; loop back through the bridge locally.
    await deliverLocalAgentMessage(config, mailbox, {
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
    // Same loopback as /v1/outbound/deliver — xmpp.send_message targets other agents by JID.
    await deliverLocalAgentMessage(config, mailbox, {
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
    await sendStanzaForAgent(fromJid, stanza, c2sIngress, send);
    return reply.send({ ok: true });
  });

  app.post<{ Body: XmppLeaveRoomInput & { from?: string } }>('/v1/tools/xmpp.leave_room', async (req, reply) => {
    const fromJid = req.body.from || config.defaultAgentJid;
    const stanza = buildLeavePresence(req.body, fromJid, req.body.nickname);
    await sendStanzaForAgent(fromJid, stanza, c2sIngress, send);
    return reply.send({ ok: true });
  });

  app.post<{ Body: XmppSendRoomMessageInput & { from?: string } }>('/v1/tools/xmpp.send_room_message', async (req, reply) => {
    const fromJid = req.body.from || config.defaultAgentJid;
    const stanza = buildRoomMessage(req.body, fromJid);
    await sendStanzaForAgent(fromJid, stanza, c2sIngress, send);
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
    await send(applyStoreHints(stanza, req.body.policy));
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
    // Called by agent-runner on wake; feeds xmpp.discover_agents and capability-based routing.
    const descriptor = req.body;
    if (!descriptor.jid || !descriptor.tools || !descriptor.model || !descriptor.provider) {
      return reply.status(400).send({ error: 'Invalid descriptor: jid, tools, model, and provider are required' });
    }

    const secret = process.env.XMPP_DESCRIPTOR_SECRET;
    if (secret) {
      const auth = req.headers.authorization;
      if (auth !== secret) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
    }

    const { agent, agentCard } = registrationFromDescriptor(descriptor);
    agentRegistry.register(agent);

    const show = agent.status === 'busy' ? 'dnd' : undefined;
    const type = agent.status === 'offline' ? 'unavailable' : undefined;
    const children = [xml('status', {}, `health:${descriptor.health}`)];
    if (show) children.unshift(xml('show', {}, show));
    await send(xml('presence', { from: descriptor.jid, type }, ...children));

    const service = defaultPubsubService(config.agentDomain);
    const node = `agent-descriptor/${descriptor.jid.replace('@', '/')}`;
    await send(
      buildPublish(descriptor.jid, service, {
        node,
        eventType: 'agent.runtime_descriptor',
        id: descriptor.publishedAt,
        body: descriptor,
        contentType: 'application/vnd.agent-xmpp.runtime-descriptor+json',
      }),
    );

    await send(buildPublishAgentCard(descriptor.jid, service, agentCard));

    return reply.send({ ok: true, jid: descriptor.jid, agentCard });
  });

  app.post<{ Body: { jid: string; password: string } }>('/v1/agents/register_inbox', async (req, reply) => {
    const { jid, password } = req.body ?? {};
    if (!jid || typeof jid !== 'string' || !password || typeof password !== 'string') {
      return reply.status(400).send({ error: 'jid and password required' });
    }
    try {
      await c2sIngress.register(jid, password);
      return reply.send({ ok: true, jid: jid.split('/')[0], ingress: c2sIngress.kind });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: message });
    }
  });

  app.post<{ Body: { jid: string } }>('/v1/agents/unregister', async (req, reply) => {
    const jid = req.body?.jid;
    if (!jid || typeof jid !== 'string') {
      return reply.status(400).send({ error: 'jid required' });
    }
    agentRegistry.unregister(jid);
    await c2sIngress.unregister(jid);
    await send(xml('presence', { from: jid, type: 'unavailable' }));
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
