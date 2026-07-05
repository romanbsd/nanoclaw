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

interface DiscoverableAgent {
  jid: string;
  name?: string;
  status?: string;
  agentCard?: { name?: string; description?: string };
}

/** Fetch peer agents from the gateway registry for the system prompt. */
export async function fetchPeerAgentsSection(gatewayUrl: string, selfJid: string): Promise<string> {
  try {
    const res = await fetch(`${gatewayUrl.replace(/\/$/, '')}/v1/tools/xmpp.discover_agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeUnavailable: true }),
    });
    if (!res.ok) return '';

    const { agents } = (await res.json()) as { agents?: DiscoverableAgent[] };
    const selfBare = selfJid.split('/')[0];
    const peers = (agents ?? []).filter((a) => a.jid.split('/')[0] !== selfBare);
    if (peers.length === 0) {
      return [
        '## Peer agents on this gateway',
        '',
        'No other agents are registered right now. Call `xmpp.discover_agents` for an up-to-date list.',
      ].join('\n');
    }

    const lines = peers.map((p) => {
      const label = p.agentCard?.name || p.name || p.jid.split('@')[0] || p.jid;
      const status = p.status && p.status !== 'available' ? ` (${p.status})` : '';
      const desc = p.agentCard?.description ? ` — ${p.agentCard.description}` : '';
      return `- **${label}** \`${p.jid}\`${status}${desc}`;
    });

    return [
      '## Peer agents on this gateway',
      '',
      'These are other NanoClaw agents — not the same as **destinations** (human chat peers).',
      'Message them with `xmpp.send_message` using their JID as `to`, or call `xmpp.discover_agents` for a fresh list.',
      '',
      ...lines,
    ].join('\n');
  } catch (err) {
    log(`Peer agent discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
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
  await fetch(url, { method: 'POST', headers, body: JSON.stringify(descriptor) }).catch((err) => {
    log(`Offline runtime descriptor publish failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}
