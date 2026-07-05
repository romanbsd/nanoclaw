import path from 'path';

export interface GatewayConfig {
  gatewayId: string;
  /** Component JID, e.g. gateway.agents.example */
  componentJid: string;
  /** Delegated domain for virtual agent JIDs, e.g. agents.example */
  agentDomain: string;
  /** xmpp://host:5275 or xmpps://host:5347 */
  componentService: string;
  /** Client (c2s) service for agent inbox sessions, e.g. xmpp://host:5222 */
  c2sService: string;
  componentSecret: string;
  httpHost: string;
  httpPort: number;
  bridgeWebhookUrl: string;
  bridgeWebhookSecret: string;
  dataDir: string;
  defaultAgentJid: string;
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

  return {
    gatewayId: process.env.XMPP_GATEWAY_ID || 'gw-1',
    componentJid,
    agentDomain,
    componentService: env('XMPP_COMPONENT_SERVICE', 'xmpp://127.0.0.1:5275'),
    c2sService: env('XMPP_C2S_SERVICE', process.env.XMPP_SERVICE || 'xmpp://127.0.0.1:5222'),
    componentSecret: env('XMPP_COMPONENT_SECRET'),
    httpHost: process.env.XMPP_GATEWAY_HOST || '127.0.0.1',
    httpPort: Number(process.env.XMPP_GATEWAY_PORT || '9220'),
    bridgeWebhookUrl: env('XMPP_BRIDGE_WEBHOOK_URL', 'http://127.0.0.1:9221/internal/xmpp/inbound'),
    bridgeWebhookSecret: env('XMPP_BRIDGE_WEBHOOK_SECRET', 'dev-secret'),
    dataDir: process.env.XMPP_GATEWAY_DATA_DIR || path.join(process.cwd(), 'data', 'xmpp-gateway'),
    defaultAgentJid: process.env.XMPP_DEFAULT_AGENT_JID || `assistant@${agentDomain}`,
  };
}
