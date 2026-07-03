/** MCP tool input/output types from Agent XMPP Adapter API Surface §7 */

import type { AgentMessage, FileRef, MessagePolicy, TraceContext } from './agent-message.js';

export const outboundMessageKinds = ['text', 'task', 'result', 'error', 'file', 'command'] as const;
export type OutboundMessageKind = (typeof outboundMessageKinds)[number];

export interface XmppReplyInput {
  inReplyTo: string;
  threadId?: string;
  kind?: OutboundMessageKind;
  contentType?: string;
  body: unknown;
  attachments?: FileRef[];
  policy?: MessagePolicy;
}

export interface XmppSendMessageInput {
  to: string;
  threadId?: string;
  kind: OutboundMessageKind;
  contentType: string;
  body: unknown;
  attachments?: FileRef[];
  replyTo?: string;
  trace?: TraceContext;
  policy?: MessagePolicy;
}

export interface XmppPublishEventInput {
  node: string;
  eventType: string;
  id?: string;
  body: unknown;
  contentType?: string;
  trace?: TraceContext;
  policy?: MessagePolicy;
}

export interface XmppUploadFileInput {
  path?: string;
  bytesBase64?: string;
  name: string;
  mediaType: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface XmppUploadFileOutput {
  file: FileRef;
}

export interface XmppShareFileInput {
  to: string;
  threadId?: string;
  file: FileRef;
  note?: string;
  policy?: MessagePolicy;
}

export interface XmppJoinRoomInput {
  roomJid: string;
  nickname?: string;
  password?: string;
}

export interface XmppLeaveRoomInput {
  roomJid: string;
  reason?: string;
}

export interface XmppSendRoomMessageInput {
  roomJid: string;
  threadId?: string;
  body: unknown;
  contentType?: string;
  mentions?: string[];
  attachments?: FileRef[];
}

export interface XmppDiscoverAgentsInput {
  query?: string;
  capabilities?: string[];
  tenantId?: string;
  includeUnavailable?: boolean;
}

export interface AgentDescriptor {
  jid: string;
  name?: string;
  description?: string;
  capabilities: string[];
  status?: 'available' | 'busy' | 'offline' | 'dormant';
  metadata?: Record<string, unknown>;
}

export interface XmppGetArchiveInput {
  with?: string;
  roomId?: string;
  threadId?: string;
  query?: string;
  start?: string;
  end?: string;
  limit?: number;
  before?: string;
  after?: string;
}

export interface XmppGetArchiveOutput {
  messages: AgentMessage[];
  paging?: {
    before?: string;
    after?: string;
    complete?: boolean;
  };
}

export const presenceStatuses = ['available', 'away', 'busy', 'offline', 'dormant'] as const;
export type PresenceStatus = (typeof presenceStatuses)[number];

export interface XmppSetPresenceInput {
  status: PresenceStatus;
  message?: string;
  capabilities?: string[];
}

export const ackStatuses = ['received', 'seen', 'processing', 'completed', 'failed'] as const;
export type AckStatus = (typeof ackStatuses)[number];

export interface XmppAckInput {
  messageId: string;
  status: AckStatus;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}

export interface XmppRunCommandInput {
  target: string;
  command: string;
  args?: Record<string, unknown>;
}
