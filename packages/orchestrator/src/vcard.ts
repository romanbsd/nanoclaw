/** Identity-only vCard XML (FN + optional avatar URL). Runtime descriptor is published via gateway, not vCard. */
export function buildIdentityVcard(displayName: string, avatarUrl?: string): string {
  const url = avatarUrl ? `<URL>${escapeXml(avatarUrl)}</URL>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<vCard xmlns="vcard-temp">
  <FN>${escapeXml(displayName)}</FN>${url}
</vCard>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
