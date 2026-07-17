import { DEFAULT_PROTOCOL_NAMESPACES, type AgentApiManifest, type AgentXmppNamespaces } from '@agent-xmpp/protocol';
import { provisionAgentIdentity } from './provision-identity.js';
import { OpenfireClient, loadOpenfireConfigFromEnv, usernameFromJid } from './openfire-client.js';
import type { OpenfireClientConfig } from './openfire-client.js';
import type { McpServerSpec, NanoclawAgentHost } from './nanoclaw-host.js';

export interface ProvisionNanoclawAgentRequest {
  name: string;
  agentId: string;
  tenantId: string;
  displayName: string;
  personality?: {
    instructions?: string;
    assistantName?: string;
  };
  provider?: string;
  model?: string;
  mockScenario?: string;
  skills?: string[] | 'all';
  mcpServers?: McpServerSpec[];
  groups?: string[];
  avatarUrl?: string;
  /** Extra env vars injected at container spawn (e.g. MOCK_ACCOUNTANT_JID). */
  spawnEnv?: Record<string, string>;
  /** Structured API advertised by this logical agent. Defaults to conversation.respond. */
  agentApiManifest?: Omit<AgentApiManifest, 'agent'> & { agent?: Partial<AgentApiManifest['agent']> };
}

export interface ProvisionNanoclawAgentResult {
  orchestratorId: string;
  agentGroupId: string;
  folder: string;
  jid: string;
  password: string;
  messagingGroupId: string;
}

export interface ProvisionNanoclawAgentOptions {
  host: NanoclawAgentHost;
  openfireClient?: OpenfireClient;
  openfireConfig?: OpenfireClientConfig;
  baseDomain?: string;
  protocolNamespaces?: AgentXmppNamespaces;
}

export async function provisionNanoclawAgent(
  request: ProvisionNanoclawAgentRequest,
  options: ProvisionNanoclawAgentOptions,
): Promise<ProvisionNanoclawAgentResult> {
  const baseDomain = options.baseDomain || request.tenantId;

  const identity = await provisionAgentIdentity(
    {
      tenantId: request.tenantId,
      agentId: request.agentId,
      displayName: request.displayName,
      groups: request.groups,
      avatarUrl: request.avatarUrl,
    },
    {
      client: options.openfireClient,
      baseDomain,
    },
  );

  try {
    const supplied = request.agentApiManifest;
    const manifest: AgentApiManifest = {
      specVersion: options.protocolNamespaces?.api ?? DEFAULT_PROTOCOL_NAMESPACES.api,
      capabilities: supplied?.capabilities ?? {
        tools: { listChanged: true },
        progress: true,
        cancellation: true,
        inputRequired: true,
        structuredOutput: true,
      },
      operations: supplied?.operations ?? [
        {
          name: 'conversation.respond',
          description: 'Ask this agent to handle a conversational request.',
          inputSchema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
            additionalProperties: false,
          },
          outputSchema: {
            type: 'object',
            properties: { response: { type: 'string' } },
            required: ['response'],
            additionalProperties: false,
          },
        },
      ],
      agent: {
        jid: identity.jid,
        name: supplied?.agent?.name ?? request.agentId,
        title: supplied?.agent?.title ?? request.displayName,
        description: supplied?.agent?.description,
        version: supplied?.agent?.version ?? '1.0.0',
        vendor: supplied?.agent?.vendor,
        homepage: supplied?.agent?.homepage,
      },
    };
    const result = await options.host.provisionAgent({
      ...request,
      jid: identity.jid,
      agentApiManifest: manifest,
    });

    return {
      ...result,
      jid: identity.jid,
      password: identity.password,
    };
  } catch (err) {
    if (process.env.ORCHESTRATOR_SKIP_OPENFIRE !== '1') {
      const client = options.openfireClient ?? new OpenfireClient(loadOpenfireConfigFromEnv());
      await client.deleteUser(usernameFromJid(identity.jid)).catch((cleanupErr) => {
        console.warn(
          '[provision-nanoclaw-agent] XMPP identity rollback failed:',
          cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,
        );
      });
    }
    throw err;
  }
}
