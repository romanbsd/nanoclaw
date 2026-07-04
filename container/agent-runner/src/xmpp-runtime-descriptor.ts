/**
 * Publish agent runtime descriptor to the XMPP gateway on container start.
 */
import './mcp-tools/register-all.js';
import { listRegisteredTools } from './mcp-tools/server.js';

const SOFTWARE_VERSION = '2.0.0';
const DEFAULT_PROTOCOLS = ['xmpp', 'mcp', 'mam', 'pubsub', 'muc'];

export interface RuntimeDescriptorInput {
  jid: string;
  tenantId?: string;
  provider: string;
  model: string;
  sessionId?: string;
}

function log(msg: string): void {
  console.error(`[xmpp-descriptor] ${msg}`);
}

export async function publishRuntimeDescriptor(input: RuntimeDescriptorInput): Promise<void> {
  const gatewayUrl = process.env.XMPP_GATEWAY_URL;
  const agentJid = process.env.XMPP_AGENT_JID || input.jid;
  if (!gatewayUrl) {
    log('XMPP_GATEWAY_URL not set — skipping descriptor publish');
    return;
  }

  const descriptor = {
    jid: agentJid,
    tenantId: input.tenantId,
    tools: listRegisteredTools(),
    model: input.model,
    provider: input.provider,
    softwareVersion: SOFTWARE_VERSION,
    health: 'healthy' as const,
    availability: 'idle' as const,
    supportedProtocols: DEFAULT_PROTOCOLS,
    publishedAt: new Date().toISOString(),
    sessionId: input.sessionId,
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const secret = process.env.XMPP_DESCRIPTOR_SECRET;
  if (secret) headers.Authorization = secret;

  const url = `${gatewayUrl.replace(/\/$/, '')}/v1/agents/publish_descriptor`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(descriptor),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to publish runtime descriptor: ${res.status} ${text}`);
  }

  log(`Published runtime descriptor for ${agentJid} (${descriptor.tools.length} tools)`);
}

export async function publishOfflineDescriptor(input: RuntimeDescriptorInput): Promise<void> {
  const gatewayUrl = process.env.XMPP_GATEWAY_URL;
  if (!gatewayUrl) return;

  const agentJid = process.env.XMPP_AGENT_JID || input.jid;
  const descriptor = {
    jid: agentJid,
    tenantId: input.tenantId,
    tools: listRegisteredTools(),
    model: input.model,
    provider: input.provider,
    softwareVersion: SOFTWARE_VERSION,
    health: 'healthy' as const,
    availability: 'offline' as const,
    supportedProtocols: DEFAULT_PROTOCOLS,
    publishedAt: new Date().toISOString(),
    sessionId: input.sessionId,
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const secret = process.env.XMPP_DESCRIPTOR_SECRET;
  if (secret) headers.Authorization = secret;

  const url = `${gatewayUrl.replace(/\/$/, '')}/v1/agents/publish_descriptor`;
  await fetch(url, { method: 'POST', headers, body: JSON.stringify(descriptor) }).catch(() => undefined);
}
