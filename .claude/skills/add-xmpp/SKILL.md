---
name: add-xmpp
description: Add XMPP channel via agent-xmpp-gateway and thin bridge adapter.
---

# Add XMPP Channel

Installs the hybrid XMPP stack: always-on gateway + NanoClaw bridge adapter + container MCP tools.

## Pre-flight (idempotent)

Skip to **Credentials** if all are present:

- `packages/agent-xmpp/{protocol,gateway,mcp}/` exist and build
- `src/channels/xmpp-bridge.ts` exists
- `src/channels/index.ts` contains `import './xmpp-bridge.js';`
- `.env` has `XMPP_DEFAULT_AGENT_JID`, `XMPP_COMPONENT_JID`, `XMPP_COMPONENT_SECRET`

## Install

### 1. Build workspace packages

```bash
pnpm install
pnpm --filter @agent-xmpp/protocol build
pnpm --filter @agent-xmpp/gateway build
pnpm --filter @agent-xmpp/mcp build
pnpm run build
pnpm exec vitest run src/channels/xmpp-bridge-registration.test.ts
```

### 2. Configure environment

Add to `.env`:

```bash
XMPP_COMPONENT_JID=gateway.agents.example
XMPP_AGENT_DOMAIN=agents.example
XMPP_COMPONENT_SERVICE=xmpp://127.0.0.1:5275
XMPP_COMPONENT_SECRET=<openfire-component-secret>
XMPP_DEFAULT_AGENT_JID=assistant@agents.example
XMPP_GATEWAY_URL=http://127.0.0.1:9220
XMPP_BRIDGE_WEBHOOK_SECRET=<random-secret>
XMPP_BRIDGE_WEBHOOK_URL=http://127.0.0.1:9221/internal/xmpp/inbound
XMPP_BRIDGE_WEBHOOK_PORT=9221
```

See [docs/xmpp-setup.md](../../docs/xmpp-setup.md) for Openfire component registration.

### 3. Install gateway service

macOS (launchd) — create `~/Library/LaunchAgents/com.nanoclaw.xmpp-gateway.plist` pointing at:

```bash
node /path/to/clawdike/packages/agent-xmpp/gateway/dist/index.js
```

Load with `launchctl load`.

Linux: user systemd unit `nanoclaw-xmpp-gateway.service`.

Or run manually: `pnpm --filter @agent-xmpp/gateway start`

### 4. Wire MCP server for agent containers

```bash
ncl groups config add-mcp-server --id <group-id> \
  --name xmpp \
  --command node \
  --args "$(pwd)/packages/agent-xmpp/mcp/dist/index.js"
```

Ensure container env includes `XMPP_GATEWAY_URL=http://host.docker.internal:9220`.

### 5. Restart NanoClaw

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                 # Linux
```

## Pairing

Send an XMPP message from your client to the agent JID. On first contact, run setup pairing or `/manage-channels` to register the messaging group.

Pairing code flow: `pnpm exec tsx setup/index.ts --step pair-xmpp`

## Container skill

`container/skills/xmpp-formatting/` is mounted automatically. Agents learn when to use `xmpp.*` MCP tools vs `send_message`.

## Remove

See [REMOVE.md](REMOVE.md).
