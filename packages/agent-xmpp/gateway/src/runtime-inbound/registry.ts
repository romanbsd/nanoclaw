import type { GatewayConfig } from '../config.js';
import { BridgeWebhookRuntimeInbound } from './bridge-webhook.js';
import type { RuntimeInboundPort, RuntimeInboundPortFactory } from './types.js';

const factories = new Map<string, RuntimeInboundPortFactory>([
  ['bridge_webhook', (config) => new BridgeWebhookRuntimeInbound(config)],
]);

const cache = new WeakMap<GatewayConfig, RuntimeInboundPort>();

export function registerRuntimeInboundPort(kind: string, factory: RuntimeInboundPortFactory): void {
  factories.set(kind, factory);
}

export function getRuntimeInboundPort(config: GatewayConfig): RuntimeInboundPort {
  const cached = cache.get(config);
  if (cached) return cached;

  const kind = process.env.XMPP_RUNTIME_INBOUND?.trim() || 'bridge_webhook';
  const factory = factories.get(kind);
  if (!factory) {
    throw new Error(
      `Unknown XMPP_RUNTIME_INBOUND="${kind}". Registered: ${[...factories.keys()].join(', ')}`,
    );
  }
  const port = factory(config);
  cache.set(config, port);
  return port;
}
