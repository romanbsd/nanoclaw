import type { Session } from '../types.js';

/** One row destined for a session's inbound.db (host-owned). */
export interface AgentInboundMessage {
  id: string;
  kind: string;
  timestamp: string;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  content: string;
  processAfter?: string | null;
  recurrence?: string | null;
  trigger?: 0 | 1;
  sourceSessionId?: string | null;
  onWake?: 0 | 1;
}

/** Options when handing work to an agent runtime via the inbound transport. */
export interface AgentInboundDeliveryOptions {
  session: Session;
  message: AgentInboundMessage;
  /** Wake the container and run typing-indicator side effects when supported. */
  wake: boolean;
  typing?: {
    channelType: string;
    platformId: string;
    threadId: string | null;
    adapterInstance: string;
  };
}

/**
 * Delivers inbound work to an agent runtime.
 *
 * Default implementation writes to the session inbound.db and wakes the
 * container; outbound replies still flow through outbound.db + host delivery.
 */
export interface AgentInboundTransport {
  readonly kind: string;
  deliver(options: AgentInboundDeliveryOptions): Promise<void>;
}

export type AgentInboundTransportFactory = () => AgentInboundTransport;
