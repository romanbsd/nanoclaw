import type { AgentMessage } from '@agent-xmpp/protocol';

import { bareJid } from './xep-plugins/jid.js';

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
    to: original.roomId || bareJid(original.from),
    threadId: explicitThreadId ?? original.threadId,
  };
}
