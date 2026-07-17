import { createHash } from 'crypto';

import { AGENT_API_SPEC_VERSION, type AgentApiManifest, type JsonSchema } from '@agent-xmpp/protocol';

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digestJson(value: unknown): string {
  return `sha-256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function validateManifest(value: unknown, expectedSpecVersion = AGENT_API_SPEC_VERSION): AgentApiManifest {
  if (!value || typeof value !== 'object') throw new Error('manifest must be an object');
  const manifest = value as AgentApiManifest;
  if (manifest.specVersion !== expectedSpecVersion) throw new Error(`unsupported specVersion: ${manifest.specVersion}`);
  if (!manifest.agent?.jid?.includes('@')) throw new Error('agent.jid must be a bare JID');
  if (manifest.agent.jid.includes('/')) throw new Error('agent.jid must not contain a resource');
  if (!manifest.agent.name || !manifest.agent.version) throw new Error('agent.name and agent.version are required');
  if (!Array.isArray(manifest.operations)) throw new Error('operations must be an array');
  const names = new Set<string>();
  for (const operation of manifest.operations) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(operation.name)) {
      throw new Error(`invalid operation name: ${operation.name}`);
    }
    if (names.has(operation.name)) throw new Error(`duplicate operation: ${operation.name}`);
    names.add(operation.name);
    if (!operation.description) throw new Error(`operation ${operation.name} requires description`);
    if (!operation.inputSchema || operation.inputSchema.type !== 'object') {
      throw new Error(`operation ${operation.name} inputSchema must have an object root`);
    }
    assertSafeSchema(operation.inputSchema, `operation ${operation.name} inputSchema`);
    if (operation.outputSchema) assertSafeSchema(operation.outputSchema, `operation ${operation.name} outputSchema`);
  }
  return manifest;
}

function assertSafeSchema(schema: JsonSchema, label: string): void {
  const encoded = JSON.stringify(schema);
  if (encoded.length > 256_000) throw new Error(`${label} exceeds 256KB`);
  if (/"\$ref"\s*:\s*"(?:https?|file):/i.test(encoded)) throw new Error(`${label} contains an external $ref`);
}

export function validateJson(schema: JsonSchema, value: unknown, path = '$'): string[] {
  const errors: string[] = [];
  const type = schema.type;
  if (typeof type === 'string' && !matchesType(type, value)) return [`${path} must be ${type}`];
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => canonicalJson(item) === canonicalJson(value))) {
    errors.push(`${path} must be one of the allowed values`);
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${path} is too short`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${path} is too long`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path} is below minimum`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path} is above maximum`);
  }
  if (Array.isArray(value)) {
    const itemSchema = schema.items as JsonSchema | undefined;
    if (itemSchema) value.forEach((item, index) => errors.push(...validateJson(itemSchema, item, `${path}[${index}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const required of (schema.required ?? []) as string[]) {
      if (!(required in object)) errors.push(`${path}.${required} is required`);
    }
    for (const [key, item] of Object.entries(object)) {
      if (properties[key]) errors.push(...validateJson(properties[key], item, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
    }
  }
  return errors;
}

function matchesType(type: string, value: unknown): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return !!value && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}
