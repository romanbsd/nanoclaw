import type { BridgeWebhookPayload } from '@agent-xmpp/protocol';

/**
 * Hands normalized inbound XMPP traffic to the agent runtime.
 *
 * Default: HTTP webhook to the NanoClaw host bridge, which routes into the
 * session inbound.db via AgentInboundTransport on the host.
 */
export interface RuntimeInboundPort {
  readonly kind: string;
  deliver(payload: BridgeWebhookPayload): Promise<void>;
}

export type RuntimeInboundPortFactory = (config: import('../config.js').GatewayConfig) => RuntimeInboundPort;
