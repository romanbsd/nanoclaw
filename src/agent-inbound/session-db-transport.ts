import { getSession } from '../db/sessions.js';
import { wakeContainer } from '../container-runner.js';
import { startTypingRefresh, stopTypingRefresh } from '../modules/typing/index.js';
import { writeSessionMessage } from '../session-manager.js';
import type { AgentInboundDeliveryOptions } from './types.js';

/** Deliver agent work through NanoClaw's canonical inbound.db + container wake path. */
export async function deliverAgentInbound(options: AgentInboundDeliveryOptions): Promise<void> {
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
