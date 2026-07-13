# Embedded XMPP Agent Gateway

The XMPP channel plugin runs one XEP-0114 component inside the NanoClaw host. It routes multiple logical agent JIDs and uses the normal per-session databases for all runtime IO:

```text
XMPP gateway -> agent: inbound.db
agent -> XMPP gateway: outbound.db
```

There is no gateway HTTP service, webhook bridge, separate gateway daemon, or per-agent XMPP MCP process.

## Configuration

Register the component with Openfire, then configure:

```bash
XMPP_COMPONENT_JID=gateway.agents.example
XMPP_AGENT_DOMAIN=agents.example
XMPP_COMPONENT_SERVICE=xmpp://127.0.0.1:5275
XMPP_COMPONENT_SECRET=component-secret
XMPP_DEFAULT_AGENT_JID=assistant@agents.example

# Optional connection supervision / XEP-0199 keepalive tuning
XMPP_SERVER_DOMAIN=example
XMPP_RECONNECT_INITIAL_MS=1000
XMPP_RECONNECT_MAX_MS=60000
XMPP_PING_INTERVAL_MS=60000
XMPP_PING_TIMEOUT_MS=10000
XMPP_PING_FAILURE_THRESHOLD=2
```

Restart NanoClaw after changing these values. The channel adapter opens the component connection during normal host startup and closes it during normal host shutdown.
Unexpected disconnects are recovered with capped exponential backoff and jitter. Idle connections are probed with XEP-0199; repeated ping failures force a fresh component connection. Outbound channel rows remain pending while their adapter is offline and do not consume the send-failure retry budget.

## Multi-agent model

The gateway is shared infrastructure. Every provisioned agent receives:

- a stable bare JID;
- a versioned Agent API Manifest;
- an XMPP inbox messaging group and wiring;
- independent sessions and `inbound.db` / `outbound.db` files;
- tenant-filtered discovery and invocation.

Provision and remove agents through the orchestrator. Do not launch one gateway per agent.

## Verification

```bash
pnpm --filter @agent-xmpp/protocol build
pnpm --filter @agent-xmpp/gateway build
pnpm run build
pnpm exec vitest run packages/agent-xmpp/gateway/src src/modules/xmpp-agent-gateway
```

Live checks:

1. Send XEP-0199 ping to the component and to a registered logical agent; both must return IQ results without waking a runtime.
2. Query XEP-0030 directory items and endpoint/operation nodes.
3. Call `agents.discover_endpoints` from one agent.
4. Call another agent with `agents.call_tool`; verify the target receives an inbound task row.
5. Complete it with `task.complete`; verify the caller receives the validated result.
