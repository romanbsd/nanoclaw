---
name: add-xmpp
description: Add the embedded multi-agent XMPP gateway channel plugin.
---

# Add XMPP Channel

Installs one embedded XMPP component that routes any number of logical agent JIDs. Agent IO uses NanoClaw's normal per-session mailboxes: gateway-to-agent writes `inbound.db`; agent-to-gateway actions and results use `outbound.db`.

## Pre-flight

Skip to **Configure** when all are present:

- `packages/agent-xmpp/{protocol,gateway}/` build;
- `src/channels/xmpp-bridge.ts` self-registers the adapter;
- `src/modules/xmpp-agent-gateway/` registers mailbox actions;
- `container/agent-runner/src/mcp-tools/xmpp-agent-gateway.ts` registers agent/task tools;
- the channel, module, and container MCP entry points import those registrations.

## Install

Copy the plugin-owned files from the XMPP channel registry branch, append the channel and container MCP self-registration imports, add the workspace dependencies, then run. The channel entry point loads its host-side gateway actions, so no core module-barrel edit is required.

```bash
pnpm install
pnpm run build
pnpm exec vitest run packages/agent-xmpp/gateway/src src/modules/xmpp-agent-gateway
pnpm --filter @agent-xmpp/protocol test
pnpm --filter @agent-xmpp/gateway test
pnpm --filter @agent-xmpp/integration e2e:embedded
```

## Configure

Add to `.env`:

```bash
XMPP_COMPONENT_JID=gateway.agents.example
XMPP_AGENT_DOMAIN=agents.example
XMPP_COMPONENT_SERVICE=xmpp://127.0.0.1:5275
XMPP_COMPONENT_SECRET=<openfire-component-secret>
XMPP_DEFAULT_AGENT_JID=assistant@agents.example
# Optional protocol identity overrides (defaults shown):
AGENT_XMPP_NAMESPACE_ROOT=urn:solstice
AGENT_XMPP_MEDIA_VENDOR=solstice
```

No gateway HTTP port, webhook secret, separate gateway service, or per-agent MCP server is used.

## Multi-agent provisioning

Provision agents through the orchestrator. Each gets a stable bare JID, its own Agent API Manifest, inbox messaging group, wiring, and session mailbox. One embedded component routes all of them.

## Restart

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# systemctl --user restart nanoclaw
```

## Verify

- XEP-0199 ping to the component and a registered agent returns an IQ result.
- XEP-0030 lists only tenant-visible agents and their operation nodes.
- `agents.discover_endpoints` returns complete MCP endpoint descriptors.
- `agents.call_tool` creates a durable task and wakes the target through `inbound.db`.
- `task.complete` returns the schema-validated result to the caller through `inbound.db`.

## Rapid-MLX demo

Apply `/add-opencode`, rebuild the agent image, then run `pnpm run demo:xmpp-agents`.
The acceptance flow verifies the selected Rapid-MLX model, provisions Jane and
Mike with `provider=opencode`, and requires a real Jane → Mike → Jane durable
task round-trip before reporting success.

Gemma 4 remote-agent calls require Rapid-MLX v0.10.12 or newer. Earlier
versions use a non-balanced parser that truncates the nested `arguments`
object in `agents.call_tool`; see
[Rapid-MLX PR #1102](https://github.com/raullenchai/Rapid-MLX/pull/1102).

## Remove

See [REMOVE.md](REMOVE.md).
