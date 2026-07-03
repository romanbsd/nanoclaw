# Remove XMPP Channel

Reverse every change from `/add-xmpp`:

1. Unload gateway service (`launchctl unload` / `systemctl --user stop nanoclaw-xmpp-gateway`)
2. Remove XMPP env keys from `.env`
3. Remove `import './xmpp-bridge.js';` from `src/channels/index.ts`
4. Delete `src/channels/xmpp-bridge.ts` and `src/channels/xmpp-bridge-registration.test.ts`
5. Remove MCP server from container config: `ncl groups config remove-mcp-server --id <group> --name xmpp`
6. Rebuild: `pnpm run build`
7. Restart NanoClaw service

Optional: remove `packages/agent-xmpp/` if no longer needed.
