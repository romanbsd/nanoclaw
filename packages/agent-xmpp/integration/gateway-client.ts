/**
 * HTTP client for the agent-xmpp-gateway API surface.
 */
import type {
  OutboundDeliverRequest,
  OutboundDeliverResponse,
  PublishAgentDescriptorRequest,
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

export class GatewayClient {
  constructor(private baseUrl: string) {}

  private async post<T>(path: string, body: unknown): Promise<{ status: number; json: T }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: T;
    try {
      json = text ? (JSON.parse(text) as T) : ({} as T);
    } catch {
      throw new Error(`${path} returned non-JSON (${res.status}): ${text}`);
    }
    return { status: res.status, json };
  }

  async health(): Promise<{ ok: boolean; gatewayId?: string }> {
    const res = await fetch(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`health failed: ${res.status}`);
    return res.json() as Promise<{ ok: boolean; gatewayId?: string }>;
  }

  deliver(body: OutboundDeliverRequest & { from?: string }) {
    return this.post<OutboundDeliverResponse>('/v1/outbound/deliver', body);
  }

  reply(body: XmppReplyInput & { from?: string; to?: string }) {
    return this.post<{ messageId: string }>('/v1/tools/xmpp.reply', body);
  }

  sendMessage(body: XmppSendMessageInput & { from?: string }) {
    return this.post<{ messageId: string }>('/v1/tools/xmpp.send_message', body);
  }

  joinRoom(body: XmppJoinRoomInput & { from?: string }) {
    return this.post<{ ok: boolean }>('/v1/tools/xmpp.join_room', body);
  }

  leaveRoom(body: XmppLeaveRoomInput & { from?: string }) {
    return this.post<{ ok: boolean }>('/v1/tools/xmpp.leave_room', body);
  }

  sendRoomMessage(body: XmppSendRoomMessageInput & { from?: string }) {
    return this.post<{ messageId: string }>('/v1/tools/xmpp.send_room_message', body);
  }

  publishEvent(body: XmppPublishEventInput & { from?: string }) {
    return this.post<{ ok: boolean; itemId?: string }>('/v1/tools/xmpp.publish_event', body);
  }

  uploadFile(body: XmppUploadFileInput & { from?: string; uploadService?: string }) {
    return this.post<{ file: { name: string; url: string; mediaType: string; sizeBytes: number; sha256: string } }>(
      '/v1/tools/xmpp.upload_file',
      body,
    );
  }

  shareFile(body: XmppShareFileInput & { from?: string }) {
    return this.post<{ messageId: string }>('/v1/tools/xmpp.share_file', body);
  }

  discoverAgents(body: XmppDiscoverAgentsInput = {}) {
    return this.post<{ agents: Array<{ jid: string; capabilities: string[] }> }>(
      '/v1/tools/xmpp.discover_agents',
      body,
    );
  }

  getArchive(body: XmppGetArchiveInput & { from?: string }) {
    return this.post<{ messages: unknown[]; paging?: { complete?: boolean } }>('/v1/tools/xmpp.get_archive', body);
  }

  setPresence(body: XmppSetPresenceInput & { from?: string }) {
    return this.post<{ ok: boolean }>('/v1/tools/xmpp.set_presence', body);
  }

  ack(body: XmppAckInput & { from?: string; to?: string }) {
    return this.post<{ ok: boolean }>('/v1/tools/xmpp.ack', body);
  }

  publishDescriptor(body: PublishAgentDescriptorRequest) {
    return this.post<{ ok: boolean; jid: string }>('/v1/agents/publish_descriptor', body);
  }

  registerInbox(jid: string, password: string) {
    return this.post<{ ok: boolean; jid: string; ingress: string }>('/v1/agents/register_inbox', { jid, password });
  }

  unregisterAgent(jid: string) {
    return this.post<{ ok: boolean; jid: string }>('/v1/agents/unregister', { jid });
  }
}
