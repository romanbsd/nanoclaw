import type { BridgeFormResponsePayload, BridgeInboundPayload } from '@agent-xmpp/protocol';
import type { ParsedTaskInvocation, TaskWireEvent } from './task-stanza-codec.js';

/**
 * Last-mile transport between the XMPP gateway and an agent runtime.
 *
 * NanoClaw implements this with per-session inbound.db writes. The interface
 * intentionally contains no HTTP or provider concepts so another mailbox can
 * replace it later without changing XMPP routing.
 */
export interface GatewayRuntimeMailbox {
  deliverInbound(payload: BridgeInboundPayload): Promise<void>;
  deliverFormResponse(payload: BridgeFormResponsePayload): Promise<void>;
  deliverTaskInvocation(task: ParsedTaskInvocation): Promise<void>;
  deliverTaskEvent(event: TaskWireEvent): Promise<void>;
}
