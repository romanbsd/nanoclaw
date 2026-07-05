import { getAgentGroup } from '../db/agent-groups.js';
import { getSession } from '../db/sessions.js';
import { wakeContainer } from '../container-runner.js';
import { startTypingRefresh, stopTypingRefresh } from '../modules/typing/index.js';
import { isXmppAgentInboxSession, writeSessionMessage, writeSessionReplyRouting } from '../session-manager.js';
import { ensureXmppPeerDestination } from './xmpp-peer-destination.js';
import type { AgentInboundDeliveryOptions, AgentInboundTransport } from './types.js';

/** NanoClaw default: inbound.db write + optional container wake. */
export class SessionDbAgentInboundTransport implements AgentInboundTransport {
  readonly kind = 'session_db';

  async deliver(options: AgentInboundDeliveryOptions): Promise<void> {
    const { session, message, wake, typing } = options;

    writeSessionMessage(session.agent_group_id, session.id, {
      id: message.id,
      kind: message.kind,
      timestamp: message.timestamp,
      platformId: message.platformId,
      channelType: message.channelType,
      threadId: message.threadId,
      content: message.content,
      processAfter: message.processAfter,
      recurrence: message.recurrence,
      trigger: message.trigger ?? (wake ? 1 : 0),
      sourceSessionId: message.sourceSessionId,
      onWake: message.onWake,
    });

    if (
      message.platformId &&
      message.channelType &&
      isXmppAgentInboxSession(session.agent_group_id, session.messaging_group_id)
    ) {
      writeSessionReplyRouting(session.agent_group_id, session.id, {
        channelType: message.channelType,
        platformId: message.platformId,
        threadId: message.threadId ?? null,
      });
      await ensureXmppPeerDestination(session.agent_group_id, session.id, message.platformId);
    }

    if (!wake) return;

    if (typing) {
      startTypingRefresh(
        session.id,
        session.agent_group_id,
        typing.channelType,
        typing.platformId,
        typing.threadId,
        typing.adapterInstance,
      );
    }

    const fresh = getSession(session.id);
    if (!fresh) return;

    const woke = await wakeContainer(fresh);
    if (!woke && typing) {
      stopTypingRefresh(fresh.id);
    }
  }
}
