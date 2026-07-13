export interface GatewayConfig {
  gatewayId: string;
  /** Component JID, e.g. gateway.agents.example */
  componentJid: string;
  /** Delegated domain for virtual agent JIDs, e.g. agents.example */
  agentDomain: string;
  /** XMPP server domain used as the XEP-0199 keepalive target. */
  serverDomain: string;
  /** xmpp://host:5275 or xmpps://host:5347 */
  componentService: string;
  componentSecret: string;
  defaultAgentJid: string;
  /** XEP-0184: how long to wait for a <received/> before a resend is due (ms). */
  receiptTimeoutMs: number;
  /**
   * XEP-0184: max resends of an un-acked message before giving up.
   * Default 0 (observe-only): absence of a receipt is NOT evidence of failure — many
   * clients/servers don't implement receipts and XMPP doesn't guarantee dedup of equal
   * stanza/origin ids, so resending would duplicate ordinary messages. Only raise this
   * for a deployment where every peer is known to support XEP-0184 and dedups.
   */
  receiptMaxResends: number;
  /** How often the resend sweep runs (ms). */
  receiptSweepMs: number;
  /** Initial reconnect delay; subsequent failures back off exponentially. */
  reconnectInitialMs: number;
  /** Maximum reconnect delay. */
  reconnectMaxMs: number;
  /** Send XEP-0199 after this much connection inactivity. */
  pingIntervalMs: number;
  /** Time allowed for an XEP-0199 response. */
  pingTimeoutMs: number;
  /** Consecutive ping failures before forcing a reconnect. */
  pingFailureThreshold: number;
}

/** Non-negative integer (0 is meaningful, e.g. observe-only resends). */
function envNonNegInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Strictly-positive integer — for interval/timeout values where 0 would busy-loop. */
function envPosInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env: ${name}`);
}

export function loadConfig(): GatewayConfig {
  const componentJid = env('XMPP_COMPONENT_JID');
  const agentDomain = process.env.XMPP_AGENT_DOMAIN || componentJid.split('.').slice(1).join('.') || componentJid;
  const inferredServerDomain = componentJid.split('.').slice(1).join('.') || componentJid;
  const reconnectInitialMs = envPosInt('XMPP_RECONNECT_INITIAL_MS', 1_000);
  const reconnectMaxMs = Math.max(reconnectInitialMs, envPosInt('XMPP_RECONNECT_MAX_MS', 60_000));

  return {
    gatewayId: process.env.XMPP_GATEWAY_ID || 'gw-1',
    componentJid,
    agentDomain,
    serverDomain: process.env.XMPP_SERVER_DOMAIN || inferredServerDomain,
    componentService: env('XMPP_COMPONENT_SERVICE', 'xmpp://127.0.0.1:5275'),
    componentSecret: env('XMPP_COMPONENT_SECRET'),
    defaultAgentJid: process.env.XMPP_DEFAULT_AGENT_JID || `assistant@${agentDomain}`,
    receiptTimeoutMs: envPosInt('XMPP_RECEIPT_TIMEOUT_MS', 30_000),
    receiptMaxResends: envNonNegInt('XMPP_RECEIPT_MAX_RESENDS', 0),
    receiptSweepMs: envPosInt('XMPP_RECEIPT_SWEEP_MS', 10_000),
    reconnectInitialMs,
    reconnectMaxMs,
    pingIntervalMs: envPosInt('XMPP_PING_INTERVAL_MS', 60_000),
    pingTimeoutMs: envPosInt('XMPP_PING_TIMEOUT_MS', 10_000),
    pingFailureThreshold: envPosInt('XMPP_PING_FAILURE_THRESHOLD', 2),
  };
}
