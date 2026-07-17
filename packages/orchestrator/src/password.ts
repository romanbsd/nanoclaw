import { randomBytes } from 'node:crypto';

/** URL-safe password suitable for XMPP SASL (32 bytes → 43 chars base64url). */
export function generatePassword(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}
