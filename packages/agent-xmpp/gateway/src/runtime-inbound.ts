import type { BridgeWebhookPayload } from '@agent-xmpp/protocol';

import type { GatewayConfig } from './config.js';

/**
 * Hand normalized inbound XMPP traffic to the agent runtime: POST to the NanoClaw
 * host bridge webhook, which routes into the session inbound.db on the host.
 */
export async function deliverToBridge(config: GatewayConfig, payload: BridgeWebhookPayload): Promise<void> {
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
