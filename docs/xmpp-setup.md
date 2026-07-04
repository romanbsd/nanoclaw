# XMPP Gateway E2E Checklist

Use with `packages/agent-xmpp/integration/docker-compose.yml`.

## Prerequisites

1. Openfire admin console: http://localhost:9090
2. Register external component:
   - JID: `gateway.agents.local`
   - Secret: `component-secret`
   - Port: 5275
3. Enable plugins: MUC, MAM, HTTP File Upload, PubSub

## Environment (.env)

```bash
XMPP_COMPONENT_JID=gateway.agents.local
XMPP_AGENT_DOMAIN=agents.local
XMPP_COMPONENT_SERVICE=xmpp://127.0.0.1:5275
XMPP_COMPONENT_SECRET=component-secret
XMPP_DEFAULT_AGENT_JID=assistant@agents.local
XMPP_GATEWAY_URL=http://127.0.0.1:9220
XMPP_BRIDGE_WEBHOOK_SECRET=dev-secret
XMPP_BRIDGE_WEBHOOK_PORT=9221
```

## Manual E2E Steps

1. Start Openfire + gateway: `docker compose -f packages/agent-xmpp/integration/docker-compose.yml up -d`
2. Start NanoClaw host with XMPP bridge enabled
3. Wire messaging group for `human@example.com` → agent group
4. Send XMPP message to `assistant@agents.local` from an XMPP client
5. Verify agent receives message and reply appears in client
6. Join MUC room, @mention agent, verify mention routing
7. Call `xmpp.upload_file` from agent container MCP
8. Call `xmpp.get_archive` and `xmpp.publish_event`

## Automated Tests

Unit tests:

```bash
pnpm --filter @agent-xmpp/protocol test
pnpm --filter @agent-xmpp/gateway test
pnpm exec vitest run src/channels/xmpp-bridge-registration.test.ts
pnpm exec vitest run src/channels/xmpp-bridge.test.ts
```

## Automated E2E (full API surface)

```bash
pnpm run test:xmpp-e2e
```

Ping-only subset:

```bash
pnpm --filter @agent-xmpp/integration e2e:ping
```

Full HTTP API coverage (`e2e-api-surface.ts`):

```bash
pnpm --filter @agent-xmpp/integration e2e:api
```

Covers `GET /health`, `POST /v1/outbound/deliver`, and all `POST /v1/tools/xmpp.*` endpoints (send_message, reply, ack, set_presence, discover_agents, join/send/leave room, publish_event, get_archive, share_file, plus ping/pong via the mock bridge). `upload_file` requires HTTP binding enabled on Openfire (see bootstrap).

Build or refresh the Openfire image (monitoring + HTTP File Upload + REST API plugins):

```bash
./packages/agent-xmpp/integration/openfire/build.sh
# or: docker compose -f packages/agent-xmpp/integration/docker-compose.yml build openfire
```

Image tag: `clawdike-openfire:5.1.0-e2e`. Plugins: monitoring 2.7.0, httpfileupload 1.5.0, restAPI 1.12.0. Java [REST API Client](https://github.com/igniterealtime/REST-API-Client) 1.1.5 is bundled at `/opt/rest-api-client/` inside the image.

This uses `packages/agent-xmpp/integration/docker-compose.yml` with Openfire **demoboot**
(`command: ["-demoboot"]`, see `../openfire/documentation/demoboot-guide.html` and
`distribution/src/bin/openfire.sh`).

On first boot, autosetup provisions:

- XMPP domain `example.org` (virtual host — connect to `127.0.0.1:15222`, not public DNS)
- Users `john` / `assistant` (password `secret`) via `openfire-demoboot.xml`
- Admin `admin` / `admin`

The test then:

1. Sets the external component default secret via the admin API (`connection-settings-external-components.jsp`, `permissionUpdate` + CSRF cookie — see `user-create.jsp` / `connection-settings-external-components.jsp` in Openfire sources)
2. Starts the XMPP gateway on the host (component `gateway.example.org`)
3. Runs a mock bridge that replies `pong` to `ping` through `POST /v1/outbound/deliver`
4. Connects `john@example.org` with `@xmpp/client`, sends `ping`, expects `pong`

Set `KEEP_E2E=1` to leave containers up after a failure. Debug auth only:

```bash
KEEP_E2E=1 pnpm run test:xmpp-e2e
# in another shell, after compose is up:
cd packages/agent-xmpp/integration
XMPP_DOMAIN=example.org XMPP_SERVICE=xmpp://127.0.0.1:15222 NODE_TLS_REJECT_UNAUTHORIZED=0 \
  node ../../../node_modules/tsx/dist/cli.mjs auth-probe.ts
```

Default E2E ports: XMPP `15222`, component `15275`, admin `19090`, gateway `19220`, bridge `19221`.

## Gateway Reconnection

1. Stop gateway process while component connected
2. Restart gateway — verify `@xmpp/reconnect` resumes stream (XEP-0198)
3. Resend message with same stanza id — mailbox should dedupe
