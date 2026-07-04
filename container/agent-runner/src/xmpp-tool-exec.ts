const TOOL_PATHS: Record<string, string> = {
  'xmpp.reply': '/v1/tools/xmpp.reply',
  'xmpp.send_message': '/v1/tools/xmpp.send_message',
  'xmpp.discover_agents': '/v1/tools/xmpp.discover_agents',
  'xmpp.publish_event': '/v1/tools/xmpp.publish_event',
  'xmpp.set_presence': '/v1/tools/xmpp.set_presence',
};

function gatewayUrl(): string {
  return (process.env.XMPP_GATEWAY_URL || 'http://127.0.0.1:9220').replace(/\/$/, '');
}

function agentJid(): string | undefined {
  return process.env.XMPP_AGENT_JID;
}

export async function executeXmppToolCall(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const path = TOOL_PATHS[tool];
  if (!path) {
    throw new Error(`Unknown XMPP tool: ${tool}`);
  }

  const body: Record<string, unknown> = { ...args };
  if (agentJid() && !body.from) {
    body.from = agentJid();
  }

  const res = await fetch(`${gatewayUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`XMPP tool ${tool} failed: ${res.status} ${text}`);
  }

  return res.json();
}
