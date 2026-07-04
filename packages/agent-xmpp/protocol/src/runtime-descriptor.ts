import type { Tool as MCPToolDefinition } from '@modelcontextprotocol/sdk/types.js';

export type { MCPToolDefinition };

export type AgentHealth = 'healthy' | 'degraded' | 'unhealthy';

export type AgentAvailability = 'idle' | 'busy' | 'offline';

export interface AgentRuntimeDescriptor {
  jid: string;
  tenantId?: string;
  tools: MCPToolDefinition[];
  model: string;
  provider: string;
  softwareVersion: string;
  health: AgentHealth;
  availability: AgentAvailability;
  supportedProtocols: string[];
  publishedAt: string;
  sessionId?: string;
}

export interface PublishAgentDescriptorRequest extends AgentRuntimeDescriptor {}

export interface PublishAgentDescriptorResponse {
  ok: true;
  jid: string;
}
