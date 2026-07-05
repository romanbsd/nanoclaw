import type { BridgeInboundPayload } from '@agent-xmpp/protocol';

import type { GatewayConfig } from '../config.js';
import type { RuntimeInboundPort } from './types.js';

/** POST BridgeInboundPayload to the NanoClaw XMPP bridge webhook. */
export class BridgeWebhookRuntimeInbound implements RuntimeInboundPort {
  readonly kind = 'bridge_webhook';

  constructor(private readonly config: GatewayConfig) {}

  async deliver(payload: BridgeInboundPayload): Promise<void> {
    const res = await fetch(this.config.bridgeWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.bridgeWebhookSecret}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Bridge webhook failed: ${res.status} ${text}`);
    }
  }
}
