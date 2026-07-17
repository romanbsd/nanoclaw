/**
 * Plain-text @nick matching is the compatibility fallback for clients that do
 * not send XEP-0513 Explicit Mentions.
 * @see https://xmpp.org/extensions/xep-0513.html
 */
export function shouldDeliverInbound(stanzaType: string, isGroup: boolean, isMention: boolean): boolean {
  if (!isGroup) return true;
  return isMention;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectMention(body: string, agentNick?: string): boolean {
  if (!agentNick) return false;
  // Escape metachars: a JID localpart can contain '.', '(', etc. Unescaped, they
  // either false-match or make new RegExp throw and drop the stanza.
  return new RegExp(`@${escapeRegExp(agentNick)}\\b`, 'i').test(body);
}

export function isMentionForAgent(stanzaType: string, body: string, agentNick: string): boolean {
  if (stanzaType === 'chat') return true;
  return detectMention(body, agentNick);
}
