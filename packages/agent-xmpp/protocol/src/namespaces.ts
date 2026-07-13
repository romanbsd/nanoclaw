/**
 * Gateway-private XMPP namespaces. Single source of truth — the gateway package
 * (agent-api-disco.ts) and the host store re-import these rather than redefining
 * the literals. Template-literal types off NS_ROOT keep each value a string
 * literal type, so `typeof AGENT_API_SPEC_VERSION` still narrows.
 *
 * NS_ROOT is the only place the vendor prefix lives — change it here to rebrand.
 */
export const NS_ROOT = 'urn:businessos' as const;

export const AGENT_DIRECTORY_NS = `${NS_ROOT}:agent-directory:1` as const;
export const AGENT_API_NS = `${NS_ROOT}:agent-api:1` as const;
export const AGENT_OPERATION_NS = `${NS_ROOT}:agent-operation:1` as const;
export const MCP_ENDPOINT_NS = `${NS_ROOT}:mcp-endpoint:1` as const;
export const AGENT_TASK_NS = `${NS_ROOT}:agent-task:1` as const;

/** The agent-API manifest spec version equals the agent-API namespace. */
export const AGENT_API_SPEC_VERSION = AGENT_API_NS;
