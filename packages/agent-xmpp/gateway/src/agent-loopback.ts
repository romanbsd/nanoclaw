import type { AgentIngress } from './ingress/types.js';
import { bareJid } from './xep-plugins/jid.js';
import { isAgentJid } from './xep-plugins/message.js';
import { isMucJid } from './xep-plugins/muc.js';

export type AgentLoopbackReason =
  | 'agent-inbox'
  | 'self-send'
  | 'muc-target'
  | 'external-jid'
  | 'no-agent-inbox';

export type AgentLoopbackDecision = {
  loopback: boolean;
  reason: AgentLoopbackReason;
};

export interface AgentLoopbackRegistry {
  hasAgent(jid: string): boolean;
}

/** Whether an outbound agent send should be mirrored to the bridge as inbound for the target agent. */
export function decideAgentLoopback(
  fromJid: string,
  toJid: string,
  agentDomain: string,
  c2sIngress: AgentIngress,
  agentRegistry?: AgentLoopbackRegistry,
): AgentLoopbackDecision {
  const fromBare = bareJid(fromJid);
  const toBare = bareJid(toJid);
  if (!fromBare || !toBare || fromBare === toBare) {
    return { loopback: false, reason: 'self-send' };
  }
  if (isMucJid(toBare)) {
    return { loopback: false, reason: 'muc-target' };
  }
  if (!isAgentJid(toBare, agentDomain)) {
    return { loopback: false, reason: 'external-jid' };
  }
  const hasInbox = c2sIngress.hasSession?.(toBare) || agentRegistry?.hasAgent(toBare);
  if (!hasInbox) {
    return { loopback: false, reason: 'no-agent-inbox' };
  }
  return { loopback: true, reason: 'agent-inbox' };
}

export function logAgentLoopback(decision: AgentLoopbackDecision, fromJid: string, toJid: string): void {
  const detail = `${bareJid(fromJid)} → ${bareJid(toJid)} (${decision.reason})`;
  if (decision.loopback) {
    console.error(`[xmpp-gateway] agent loopback: ${detail}`);
  } else {
    console.error(`[xmpp-gateway] agent loopback skipped: ${detail}`);
  }
}

export function logOutboundRoute(fromJid: string, via: 'c2s' | 'component', stanzaName: string): void {
  if (stanzaName !== 'message') return;
  console.error(
    `[xmpp-gateway] outbound ${stanzaName} from ${bareJid(fromJid)} via ${via}`,
  );
}
