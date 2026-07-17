import type { AgentApiManifest } from '@agent-xmpp/protocol';

export interface McpServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface NanoclawAgentProvision {
  name: string;
  agentId: string;
  tenantId: string;
  displayName: string;
  jid: string;
  personality?: {
    instructions?: string;
    assistantName?: string;
  };
  provider?: string;
  model?: string;
  mockScenario?: string;
  skills?: string[] | 'all';
  mcpServers?: McpServerSpec[];
  spawnEnv?: Record<string, string>;
  agentApiManifest: AgentApiManifest;
}

export interface NanoclawAgentProvisionResult {
  orchestratorId: string;
  agentGroupId: string;
  folder: string;
  messagingGroupId: string;
}

export interface NanoclawAgentRecord {
  orchestratorId: string;
  agentGroupId: string;
  name: string | null;
  folder: string | null;
  jid: string | null;
  tenantId: string | null;
  mockScenario: string | null;
  spawnEnv: Record<string, string>;
  createdAt: string;
}

/** NanoClaw runtime and XMPP binding operations required by this orchestrator. */
export interface XmppAgentHost {
  provisionAgent(request: NanoclawAgentProvision): Promise<NanoclawAgentProvisionResult>;
  deleteAgent(orchestratorId: string): Promise<void>;
  getAgent(orchestratorId: string): NanoclawAgentRecord | undefined;
  listAgents(): NanoclawAgentRecord[];
}
