# Remove XMPP Channel

1. Remove the XMPP imports from `src/channels/index.ts`, `src/modules/index.ts`, and both container MCP-tool barrels.
2. Delete `src/channels/xmpp-bridge.ts`, `src/modules/xmpp-agent-gateway/`, the XMPP migration, and XMPP container tool/instructions.
3. Remove `@agent-xmpp/gateway` and `@agent-xmpp/protocol` from the root dependencies.
4. Remove the XMPP environment keys from `.env`.
5. Optionally delete `packages/agent-xmpp/{gateway,protocol}/` and XMPP-specific orchestrator files.
6. Run `pnpm install`, `pnpm run build`, and restart NanoClaw.

Existing agent-group and session rows are not deleted automatically. Remove provisioned XMPP agents through the orchestrator first when their data should also be removed.
