import type { AgentApiManifest, RegisteredAgent, RegisteredOperation } from '@agent-xmpp/protocol';
import { xml, type Element } from '@xmpp/xml';

export const DISCO_INFO_NS = 'http://jabber.org/protocol/disco#info';
export const DISCO_ITEMS_NS = 'http://jabber.org/protocol/disco#items';
export const DATA_FORMS_NS = 'jabber:x:data';
export const AGENT_DIRECTORY_NS = 'urn:businessos:agent-directory:1';
export const AGENT_API_NS = 'urn:businessos:agent-api:1';
export const AGENT_OPERATION_NS = 'urn:businessos:agent-operation:1';
export const MCP_ENDPOINT_NS = 'urn:businessos:mcp-endpoint:1';
export const AGENT_TASK_NS = 'urn:businessos:agent-task:1';

function resultIq(request: Element, from: string, child: Element): Element {
  return xml('iq', { type: 'result', id: request.attrs.id, from, to: request.attrs.from }, child);
}

function field(name: string, value: string, type?: string): Element {
  return xml('field', { var: name, ...(type ? { type } : {}) }, xml('value', {}, value));
}

function resultForm(formType: string, fields: Element[]): Element {
  return xml('x', { xmlns: DATA_FORMS_NS, type: 'result' }, field('FORM_TYPE', formType, 'hidden'), ...fields);
}

function features(...values: string[]): Element[] {
  return values.map((value) => xml('feature', { var: value }));
}

export function buildGatewayInfo(request: Element, componentJid: string): Element {
  return resultIq(
    request,
    componentJid,
    xml(
      'query',
      { xmlns: DISCO_INFO_NS },
      xml('identity', { category: 'automation', type: 'agent-gateway', name: 'NanoClaw XMPP Agent Gateway' }),
      ...features(DISCO_INFO_NS, DISCO_ITEMS_NS, AGENT_DIRECTORY_NS, AGENT_API_NS, AGENT_TASK_NS, MCP_ENDPOINT_NS),
    ),
  );
}

export function buildAgentDirectory(request: Element, componentJid: string, agents: RegisteredAgent[]): Element {
  return resultIq(
    request,
    componentJid,
    xml(
      'query',
      { xmlns: DISCO_ITEMS_NS, node: AGENT_DIRECTORY_NS },
      ...agents.map((agent) =>
        xml('item', {
          jid: agent.manifest.agent.jid,
          node: MCP_ENDPOINT_NS,
          name: agent.manifest.agent.title ?? agent.manifest.agent.name,
        }),
      ),
    ),
  );
}

export function buildAgentInfo(request: Element, agent: RegisteredAgent): Element {
  const identity = agent.manifest.agent;
  return resultIq(
    request,
    identity.jid,
    xml(
      'query',
      { xmlns: DISCO_INFO_NS, node: MCP_ENDPOINT_NS },
      xml('identity', { category: 'automation', type: 'mcp-endpoint', name: identity.title ?? identity.name }),
      ...features(MCP_ENDPOINT_NS, AGENT_API_NS, AGENT_TASK_NS),
      resultForm('urn:businessos:mcp-endpoint-info:1', [
        field('endpoint_id', `xmpp+mcp://${identity.jid}`),
        field('server_name', identity.name),
        field('server_title', identity.title ?? identity.name),
        field('description', identity.description ?? ''),
        field('version', identity.version),
        field('manifest_digest', agent.manifestDigest),
        field('availability', agent.availability),
        field('cold_start_supported', 'true'),
      ]),
    ),
  );
}

export function buildOperationItems(request: Element, agent: RegisteredAgent): Element {
  return resultIq(
    request,
    agent.manifest.agent.jid,
    xml(
      'query',
      { xmlns: DISCO_ITEMS_NS, node: AGENT_API_NS },
      ...agent.operations.map((operation) =>
        xml('item', {
          jid: agent.manifest.agent.jid,
          node: operationNode(operation.name),
          name: operation.title ?? operation.name,
        }),
      ),
    ),
  );
}

export function buildOperationInfo(request: Element, agent: RegisteredAgent, operation: RegisteredOperation): Element {
  const jid = agent.manifest.agent.jid;
  return resultIq(
    request,
    jid,
    xml(
      'query',
      { xmlns: DISCO_INFO_NS, node: operationNode(operation.name) },
      xml('identity', { category: 'automation', type: 'mcp-tool', name: operation.title ?? operation.name }),
      ...features(AGENT_OPERATION_NS, AGENT_TASK_NS),
      resultForm('urn:businessos:mcp-tool-info:1', [
        field('name', operation.name),
        field('title', operation.title ?? operation.name),
        field('description', operation.description),
        field('api_version', agent.manifest.agent.version),
        field('input_schema_digest', operation.inputSchemaDigest),
        ...(operation.outputSchemaDigest ? [field('output_schema_digest', operation.outputSchemaDigest)] : []),
        field('read_only', String(operation.annotations?.readOnlyHint === true)),
        field('destructive', String(operation.annotations?.destructiveHint === true)),
        field('idempotent', String(operation.annotations?.idempotentHint === true)),
      ]),
    ),
  );
}

export function buildSchemaResult(
  request: Element,
  agent: RegisteredAgent,
  operation: RegisteredOperation,
  direction: 'input' | 'output',
): Element {
  const schema = direction === 'input' ? operation.inputSchema : operation.outputSchema;
  const digest = direction === 'input' ? operation.inputSchemaDigest : operation.outputSchemaDigest;
  return resultIq(
    request,
    agent.manifest.agent.jid,
    xml(
      'schema',
      {
        xmlns: AGENT_API_NS,
        operation: operation.name,
        version: agent.manifest.agent.version,
        direction,
        'media-type': 'application/schema+json',
        digest: digest ?? '',
      },
      JSON.stringify(schema ?? {}),
    ),
  );
}

export function operationNode(name: string): string {
  return `${AGENT_OPERATION_NS}#${encodeURIComponent(name)}`;
}

export function operationFromNode(node: string): string | null {
  const prefix = `${AGENT_OPERATION_NS}#`;
  return node.startsWith(prefix) ? decodeURIComponent(node.slice(prefix.length)) : null;
}

export function parseManifestRegistration(request: Element): AgentApiManifest | null {
  if (request.name !== 'iq' || request.attrs.type !== 'set') return null;
  const manifest = request.getChild('register', AGENT_API_NS)?.getChild('manifest');
  if (!manifest) return null;
  try {
    return JSON.parse(manifest.getText()) as AgentApiManifest;
  } catch {
    return null;
  }
}

export function buildManifestRegistrationResult(request: Element, agent: RegisteredAgent): Element {
  return resultIq(
    request,
    agent.manifest.agent.jid,
    xml('registered', {
      xmlns: AGENT_API_NS,
      jid: agent.manifest.agent.jid,
      version: agent.manifest.agent.version,
      'manifest-digest': agent.manifestDigest,
    }),
  );
}
