import { ackStatuses, outboundMessageKinds, presenceStatuses } from '@agent-xmpp/protocol';
import { z } from 'zod';

const messageKind = z.enum(outboundMessageKinds);
const presenceStatus = z.enum(presenceStatuses);
const ackStatus = z.enum(ackStatuses);

export interface GatewayTool {
  name: string;
  description: string;
  path: string;
  inputSchema: z.ZodType;
}

export const gatewayTools: GatewayTool[] = [
  {
    name: 'xmpp.reply',
    description: 'Reply to an inbound XMPP message by ID.',
    path: '/v1/tools/xmpp.reply',
    inputSchema: z.object({
      inReplyTo: z.string(),
      body: z.unknown(),
      threadId: z.string().optional(),
      contentType: z.string().optional(),
      kind: messageKind.optional(),
    }),
  },
  {
    name: 'xmpp.send_message',
    description: 'Send a direct XMPP message to a JID.',
    path: '/v1/tools/xmpp.send_message',
    inputSchema: z.object({
      to: z.string(),
      kind: messageKind,
      contentType: z.string(),
      body: z.unknown(),
      threadId: z.string().optional(),
      replyTo: z.string().optional(),
    }),
  },
  {
    name: 'xmpp.publish_event',
    description: 'Publish an event to a PubSub node.',
    path: '/v1/tools/xmpp.publish_event',
    inputSchema: z.object({
      node: z.string(),
      eventType: z.string(),
      body: z.unknown(),
      id: z.string().optional(),
    }),
  },
  {
    name: 'xmpp.upload_file',
    description: 'Upload a file via XEP-0363 and return a FileRef.',
    path: '/v1/tools/xmpp.upload_file',
    inputSchema: z.object({
      bytesBase64: z.string().optional(),
      name: z.string(),
      mediaType: z.string(),
      description: z.string().optional(),
    }),
  },
  {
    name: 'xmpp.share_file',
    description: 'Share an existing file reference with a recipient.',
    path: '/v1/tools/xmpp.share_file',
    inputSchema: z.object({
      to: z.string(),
      file: z.record(z.string(), z.unknown()),
      note: z.string().optional(),
      threadId: z.string().optional(),
    }),
  },
  {
    name: 'xmpp.join_room',
    description: 'Join a MUC room.',
    path: '/v1/tools/xmpp.join_room',
    inputSchema: z.object({
      roomJid: z.string(),
      nickname: z.string().optional(),
      password: z.string().optional(),
    }),
  },
  {
    name: 'xmpp.leave_room',
    description: 'Leave a MUC room.',
    path: '/v1/tools/xmpp.leave_room',
    inputSchema: z.object({
      roomJid: z.string(),
      reason: z.string().optional(),
    }),
  },
  {
    name: 'xmpp.send_room_message',
    description: 'Send a message to a MUC room.',
    path: '/v1/tools/xmpp.send_room_message',
    inputSchema: z.object({
      roomJid: z.string(),
      body: z.unknown(),
      threadId: z.string().optional(),
      mentions: z.array(z.string()).optional(),
    }),
  },
  {
    name: 'xmpp.discover_agents',
    description: 'Discover agents by query and capabilities.',
    path: '/v1/tools/xmpp.discover_agents',
    inputSchema: z.object({
      query: z.string().optional(),
      capabilities: z.array(z.string()).optional(),
      includeUnavailable: z.boolean().optional(),
    }),
  },
  {
    name: 'xmpp.get_archive',
    description: 'Query MAM message archive.',
    path: '/v1/tools/xmpp.get_archive',
    inputSchema: z.object({
      with: z.string().optional(),
      roomId: z.string().optional(),
      threadId: z.string().optional(),
      limit: z.number().optional(),
      before: z.string().optional(),
      after: z.string().optional(),
    }),
  },
  {
    name: 'xmpp.set_presence',
    description: 'Set agent presence status.',
    path: '/v1/tools/xmpp.set_presence',
    inputSchema: z.object({
      status: presenceStatus,
      message: z.string().optional(),
    }),
  },
  {
    name: 'xmpp.ack',
    description: 'Acknowledge message processing status.',
    path: '/v1/tools/xmpp.ack',
    inputSchema: z.object({
      messageId: z.string(),
      status: ackStatus,
      to: z.string().optional(),
    }),
  },
];
