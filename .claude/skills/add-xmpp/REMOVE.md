# Remove XMPP Channel

1. Remove the XMPP imports from `src/channels/index.ts` and `container/agent-runner/src/mcp-tools/index.ts`.
2. Delete `src/channels/xmpp-bridge.ts`, `src/channels/xmpp-agent-iq.ts`,
   `src/modules/xmpp-agent-gateway/`, both XMPP migrations, and their migration
   barrel imports.
3. Delete `container/agent-runner/src/mcp-tools/xmpp-agent-gateway.ts`, the
   XMPP formatting skill, and the XMPP MCP barrel import.
4. Delete `packages/agent-xmpp/`, `packages/orchestrator/`, and the XMPP demo script.
5. Remove the XMPP workspace entries, scripts, and exact package dependencies,
   then refresh `pnpm-lock.yaml` and `container/agent-runner/bun.lock`.
6. Remove every `XMPP_*` and `AGENT_XMPP_*` key installed by this skill from `.env`.
7. Run `pnpm run build`, `pnpm test`, and restart NanoClaw.

Existing agent-group and session rows are not deleted automatically. Remove provisioned XMPP agents through the orchestrator first when their data should also be removed.
