import { SessionDbAgentInboundTransport } from './session-db-transport.js';
import type { AgentInboundTransport, AgentInboundTransportFactory } from './types.js';

const factories = new Map<string, AgentInboundTransportFactory>([
  ['session_db', () => new SessionDbAgentInboundTransport()],
]);

let active: AgentInboundTransport | null = null;

export function registerAgentInboundTransport(kind: string, factory: AgentInboundTransportFactory): void {
  factories.set(kind, factory);
  if (active?.kind === kind) {
    active = null;
  }
}

export function getAgentInboundTransport(): AgentInboundTransport {
  if (active) return active;

  const kind = process.env.AGENT_INBOUND_TRANSPORT?.trim() || 'session_db';
  const factory = factories.get(kind);
  if (!factory) {
    throw new Error(`Unknown AGENT_INBOUND_TRANSPORT="${kind}". Registered: ${[...factories.keys()].join(', ')}`);
  }
  active = factory();
  return active;
}

/** Test helper — force the next getAgentInboundTransport() to re-resolve. */
export function resetAgentInboundTransportForTests(): void {
  active = null;
}
