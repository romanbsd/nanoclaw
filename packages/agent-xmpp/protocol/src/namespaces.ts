/**
 * Gateway-private XMPP namespaces. Single source of truth — the gateway package
 * (agent-api-disco.ts) and the host store re-import these rather than redefining
 * the literals. Kept as `as const` so consumers can use `typeof X` literal types.
 */
export const AGENT_DIRECTORY_NS = 'urn:businessos:agent-directory:1' as const;
export const AGENT_API_NS = 'urn:businessos:agent-api:1' as const;
export const AGENT_OPERATION_NS = 'urn:businessos:agent-operation:1' as const;
export const MCP_ENDPOINT_NS = 'urn:businessos:mcp-endpoint:1' as const;
export const AGENT_TASK_NS = 'urn:businessos:agent-task:1' as const;

/** The agent-API manifest spec version equals the agent-API namespace. */
export const AGENT_API_SPEC_VERSION = AGENT_API_NS;
