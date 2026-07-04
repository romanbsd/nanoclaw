/** A2A-over-XMPP binding identification (Agent Card supportedInterfaces). */

import type { AgentDescriptor } from './mcp-tools.js';
import type { PublishAgentDescriptorRequest } from './runtime-descriptor.js';

export const A2A_XMPP_BINDING_URI = 'urn:xmpp:a2a:binding:1.0';
export const A2A_XMPP_PROTOCOL_VERSION = '1.0';
export const A2A_NS = 'urn:xmpp:a2a:0';
export const A2A_AGENTCARD_PEP_NODE = 'urn:xmpp:a2a:agentcard:0';
export const A2A_AGENTCARD_MEDIA_TYPE = 'application/vnd.a2a.agentcard+json';
export const A2A_DEFAULT_MODES = ['text/plain', 'application/vnd.a2a+json'] as const;

/** Disco features advertised by agents speaking this binding. */
export const A2A_AGENT_DISCO_FEATURES = [
  A2A_XMPP_BINDING_URI,
  A2A_AGENTCARD_PEP_NODE,
  'urn:xmpp:mam:2',
  'urn:xmpp:json-msg:0',
] as const;

export interface A2aAgentInterface {
  url: string;
  protocolBinding: string;
  protocolVersion: string;
  tenant?: string;
}

export interface A2aAgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  extendedAgentCard?: boolean;
}

export interface A2aAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

/** Subset of A2A AgentCard fields required for XMPP binding identification. */
export interface A2aAgentCard {
  name: string;
  description: string;
  version: string;
  supportedInterfaces: A2aAgentInterface[];
  capabilities: A2aAgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2aAgentSkill[];
}

export function localpartFromJid(jid: string): string {
  return jid.split('@')[0] || 'agent';
}

export function xmppAgentUrl(bareJid: string): string {
  return `xmpp:${bareJid}`;
}

export function buildA2aAgentInterface(bareJid: string, tenant?: string): A2aAgentInterface {
  const iface: A2aAgentInterface = {
    url: xmppAgentUrl(bareJid),
    protocolBinding: A2A_XMPP_BINDING_URI,
    protocolVersion: A2A_XMPP_PROTOCOL_VERSION,
  };
  if (tenant) iface.tenant = tenant;
  return iface;
}

export interface BuildA2aAgentCardInput {
  jid: string;
  name?: string;
  description?: string;
  version?: string;
  tenantId?: string;
  capabilities?: A2aAgentCapabilities;
  skills?: A2aAgentSkill[];
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
}

export function buildA2aAgentCard(input: BuildA2aAgentCardInput): A2aAgentCard {
  const localpart = localpartFromJid(input.jid);
  const name = input.name || localpart;
  return {
    name,
    description: input.description || `XMPP agent ${input.jid}`,
    version: input.version || '1.0.0',
    supportedInterfaces: [buildA2aAgentInterface(input.jid, input.tenantId)],
    capabilities: {
      streaming: input.capabilities?.streaming ?? true,
      pushNotifications: input.capabilities?.pushNotifications ?? false,
      extendedAgentCard: input.capabilities?.extendedAgentCard ?? false,
    },
    defaultInputModes: input.defaultInputModes ?? [...A2A_DEFAULT_MODES],
    defaultOutputModes: input.defaultOutputModes ?? [...A2A_DEFAULT_MODES],
    skills: input.skills ?? [
      {
        id: `${localpart}-chat`,
        name,
        description: input.description || `Communicate with ${name} over A2A via XMPP`,
        tags: ['xmpp', 'a2a'],
      },
    ],
  };
}

export function agentCardFromDescriptor(descriptor: PublishAgentDescriptorRequest): A2aAgentCard {
  const skills: A2aAgentSkill[] = descriptor.tools.map((t) => ({
    id: t.name,
    name: t.name,
    description: t.description || t.name,
    tags: ['mcp-tool'],
  }));
  return buildA2aAgentCard({
    jid: descriptor.jid,
    name: localpartFromJid(descriptor.jid),
    description: `${descriptor.provider} agent (${descriptor.model})`,
    tenantId: descriptor.tenantId,
    version: descriptor.softwareVersion,
    skills,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false,
    },
  });
}

export function registrationFromDescriptor(descriptor: PublishAgentDescriptorRequest): {
  agent: AgentDescriptor;
  agentCard: A2aAgentCard;
} {
  const agentCard = agentCardFromDescriptor(descriptor);
  const toolNames = descriptor.tools.map((t) => t.name);
  const status: NonNullable<AgentDescriptor['status']> =
    descriptor.availability === 'busy'
      ? 'busy'
      : descriptor.availability === 'offline'
        ? 'offline'
        : 'available';

  return {
    agentCard,
    agent: {
      jid: descriptor.jid,
      name: localpartFromJid(descriptor.jid),
      capabilities: [...new Set([...toolNames, ...descriptor.supportedProtocols, A2A_XMPP_BINDING_URI])],
      status,
      metadata: { runtimeDescriptor: descriptor },
      agentCard,
    },
  };
}
