/**
 * Gateway-private XMPP namespaces. Single source of truth — the gateway package
 * (agent-api-disco.ts) and the host store re-import these rather than redefining
 * the literals. Template-literal types off NS_ROOT keep each value a string
 * literal type, so `typeof AGENT_API_SPEC_VERSION` still narrows.
 *
 * The default profile is Solstice. Deployments can derive the same namespace
 * set from a different root without mutating process-global state.
 */
export interface AgentXmppProtocolProfile {
  namespaceRoot: string;
  mediaVendor: string;
}

export interface AgentXmppNamespaces {
  directory: string;
  api: string;
  operation: string;
  endpoint: string;
  endpointInfo: string;
  toolInfo: string;
  task: string;
  taskMediaType: string;
  fileMediaType: string;
}

export const DEFAULT_PROTOCOL_PROFILE: Readonly<AgentXmppProtocolProfile> = Object.freeze({
  namespaceRoot: 'urn:solstice',
  mediaVendor: 'solstice',
});

export function createProtocolNamespaces(
  profile: AgentXmppProtocolProfile = DEFAULT_PROTOCOL_PROFILE,
): Readonly<AgentXmppNamespaces> {
  const namespaceRoot = profile.namespaceRoot.replace(/:+$/, '');
  const mediaVendor = profile.mediaVendor.trim();
  if (!namespaceRoot) throw new Error('protocol namespaceRoot is required');
  if (!/^[A-Za-z0-9.-]+$/.test(mediaVendor)) throw new Error('protocol mediaVendor is invalid');
  return Object.freeze({
    directory: `${namespaceRoot}:agent-directory:1`,
    api: `${namespaceRoot}:agent-api:1`,
    operation: `${namespaceRoot}:agent-operation:1`,
    endpoint: `${namespaceRoot}:mcp-endpoint:1`,
    endpointInfo: `${namespaceRoot}:mcp-endpoint-info:1`,
    toolInfo: `${namespaceRoot}:mcp-tool-info:1`,
    task: `${namespaceRoot}:agent-task:1`,
    taskMediaType: `application/vnd.${mediaVendor}.agent-task+json`,
    fileMediaType: `application/vnd.${mediaVendor}.file-message+json`,
  });
}

export const DEFAULT_PROTOCOL_NAMESPACES = createProtocolNamespaces();
export const NS_ROOT = DEFAULT_PROTOCOL_PROFILE.namespaceRoot;

export const AGENT_DIRECTORY_NS = DEFAULT_PROTOCOL_NAMESPACES.directory;
export const AGENT_API_NS = DEFAULT_PROTOCOL_NAMESPACES.api;
export const AGENT_OPERATION_NS = DEFAULT_PROTOCOL_NAMESPACES.operation;
export const MCP_ENDPOINT_NS = DEFAULT_PROTOCOL_NAMESPACES.endpoint;
export const AGENT_TASK_NS = DEFAULT_PROTOCOL_NAMESPACES.task;

/** The agent-API manifest spec version equals the agent-API namespace. */
export const AGENT_API_SPEC_VERSION = AGENT_API_NS;
