export type JsonSchema = Record<string, unknown>;

export interface AgentOperation {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  execution?: {
    mode?: 'task';
    supportsProgress?: boolean;
    supportsCancellation?: boolean;
    supportsInputRequired?: boolean;
    defaultTimeoutSeconds?: number;
    maximumTimeoutSeconds?: number;
    estimatedDurationSeconds?: number;
  };
  authorization?: {
    requiredPermissions?: string[];
    approvalRequired?: boolean;
  };
  tags?: string[];
}

export interface AgentApiManifest {
  /** Namespace selected by the gateway's protocol profile. */
  specVersion: string;
  agent: {
    jid: string;
    name: string;
    title?: string;
    description?: string;
    version: string;
    vendor?: string;
    homepage?: string;
  };
  capabilities: {
    tools?: { listChanged?: boolean };
    progress?: boolean;
    cancellation?: boolean;
    inputRequired?: boolean;
    structuredOutput?: boolean;
  };
  operations: AgentOperation[];
}

export interface RegisteredOperation extends AgentOperation {
  inputSchemaDigest: string;
  outputSchemaDigest?: string;
}

export interface RegisteredAgent {
  manifest: AgentApiManifest;
  manifestDigest: string;
  operations: RegisteredOperation[];
  tenantId: string;
  availability: 'available' | 'busy' | 'dormant' | 'unavailable';
  registeredAt: string;
}

export interface VirtualMcpEndpoint {
  endpointId: string;
  transport: { kind: 'xmpp-gateway'; gateway: string };
  server: {
    name: string;
    title?: string;
    description?: string;
    version: string;
  };
  capabilities: AgentApiManifest['capabilities'];
  xmpp: {
    jid: string;
    endpointNode: string;
    toolsNode: string;
    features: string[];
  };
  authorization: { visible: boolean; invocable: boolean; approvalRequired: boolean };
  availability: { state: RegisteredAgent['availability']; coldStartSupported: boolean };
  tools: RegisteredOperation[];
}
