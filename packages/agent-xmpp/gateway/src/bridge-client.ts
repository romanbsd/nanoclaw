import type { BridgeInboundPayload } from '@agent-xmpp/protocol';

import type { GatewayConfig } from './config.js';

export async function pushToBridge(config: GatewayConfig, payload: BridgeInboundPayload): Promise<void> {
  const res = await fetch(config.bridgeWebhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.bridgeWebhookSecret}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Bridge webhook failed: ${res.status} ${text}`);
  }
}
