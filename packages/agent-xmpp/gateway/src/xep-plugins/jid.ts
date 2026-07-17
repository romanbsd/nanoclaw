/** Shared JID helpers (kept cycle-free so both message.ts and muc.ts can import it). */

/** Bare JID (localpart@domain) — strips any /resource. */
export function bareJid(jid: string): string {
  return jid.split('/')[0];
}

/** True for MUC room JIDs on the conventional `conference.` / `groups.` service domains. */
export function isMucJid(jid: string): boolean {
  return jid.includes('@conference.') || jid.includes('@groups.');
}
