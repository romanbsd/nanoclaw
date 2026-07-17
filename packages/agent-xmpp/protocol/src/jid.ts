/** Return the addressable bare JID, stripping any resource suffix. */
export function bareJid(jid: string): string {
  return jid.split('/')[0] ?? jid;
}
