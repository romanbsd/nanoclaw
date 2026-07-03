import type { AgentMessage } from '@agent-xmpp/protocol';

export function resolveReplyTarget(
  original: AgentMessage | null,
  explicitTo?: string,
  explicitThreadId?: string | null,
): { to: string; threadId?: string } | null {
  if (explicitTo) {
    return { to: explicitTo, threadId: explicitThreadId ?? original?.threadId };
  }
  if (!original) return null;
  return {
    to: original.roomId || original.from.split('/')[0],
    threadId: explicitThreadId ?? original.threadId,
  };
}
