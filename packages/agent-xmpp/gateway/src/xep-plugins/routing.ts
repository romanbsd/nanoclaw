export function shouldDeliverInbound(stanzaType: string, isGroup: boolean, isMention: boolean): boolean {
  if (!isGroup) return true;
  return isMention;
}

function detectMention(body: string, agentNick?: string): boolean {
  if (!agentNick) return false;
  return new RegExp(`@${agentNick}\\b`, 'i').test(body);
}

export function isMentionForAgent(stanzaType: string, body: string, agentNick: string): boolean {
  if (stanzaType === 'chat') return true;
  return detectMention(body, agentNick);
}
