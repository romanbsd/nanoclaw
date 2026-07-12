import { randomUUID } from 'crypto';

import type { GatewayMailboxResponse } from '@agent-xmpp/protocol';

import { findSystemResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(action: string, payload: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const requestId = `gateway-${randomUUID()}`;
  writeMessageOut({
    id: requestId,
    kind: 'system',
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: JSON.stringify({ action, requestId, payload }),
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = findSystemResponse(requestId);
    if (row) {
      markCompleted([row.id]);
      const content = JSON.parse(row.content) as { response: GatewayMailboxResponse };
      if (!content.response.ok) throw new Error(content.response.error?.message ?? 'Gateway request failed');
      return content.response.result;
    }
    await sleep(250);
  }
  throw new Error(`${action} timed out after ${Math.round(timeoutMs / 1000)}s`);
}

function result(value: unknown) {
  const structuredContent = value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent };
}

function tool(
  name: string,
  description: string,
  inputSchema: McpToolDefinition['tool']['inputSchema'],
  action = name,
  timeout?: (args: Record<string, unknown>) => number,
): McpToolDefinition {
  return {
    tool: { name, description, inputSchema },
    async handler(args) {
      try {
        return result(await request(action, args, timeout?.(args) ?? DEFAULT_TIMEOUT_MS));
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  };
}

const endpointId = { type: 'string' as const, description: 'Canonical xmpp+mcp:// endpoint ID' };
const taskId = { type: 'string' as const };

export const xmppAgentGatewayTools: McpToolDefinition[] = [
  tool('agent_api.register', 'Register this agent MCP-compatible API manifest.', {
    type: 'object', properties: { manifest: { type: 'object' } }, required: ['manifest'], additionalProperties: false,
  }),
  tool('agents.discover_endpoints', 'Find authorized virtual MCP endpoints and their tools.', {
    type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query'], additionalProperties: false,
  }),
  tool('agents.describe_endpoint', 'Describe one virtual MCP endpoint.', {
    type: 'object', properties: { endpointId, apiVersion: { type: 'string' } }, required: ['endpointId'], additionalProperties: false,
  }),
  tool('agents.list_tools', 'List tools exposed by one virtual MCP endpoint.', {
    type: 'object', properties: { endpointId, apiVersion: { type: 'string' } }, required: ['endpointId'], additionalProperties: false,
  }),
  tool('agents.start_tool', 'Start a durable remote-agent operation and return its task handle.', {
    type: 'object', properties: {
      endpointId, tool: { type: 'string' }, arguments: { type: 'object' }, apiVersion: { type: 'string' },
      timeoutSeconds: { type: 'integer', minimum: 1 }, idempotencyKey: { type: 'string' }, parentTaskId: { type: 'string' },
    }, required: ['endpointId', 'tool', 'arguments'], additionalProperties: false,
  }),
  tool('agents.call_tool', 'Invoke a durable remote-agent operation and wait for its structured result.', {
    type: 'object', properties: {
      endpointId, tool: { type: 'string' }, arguments: { type: 'object' }, apiVersion: { type: 'string' },
      timeoutSeconds: { type: 'integer', minimum: 1 }, idempotencyKey: { type: 'string' }, parentTaskId: { type: 'string' },
    }, required: ['endpointId', 'tool', 'arguments'], additionalProperties: false,
  }, 'agents.call_tool', (args) => ((args.timeoutSeconds as number | undefined) ?? 600) * 1000),
  tool('agents.get_task', 'Get durable task state.', {
    type: 'object', properties: { taskId }, required: ['taskId'], additionalProperties: false,
  }),
  tool('agents.get_result', 'Get a durable task result.', {
    type: 'object', properties: { taskId }, required: ['taskId'], additionalProperties: false,
  }),
  tool('agents.cancel_task', 'Request cooperative cancellation of a durable task.', {
    type: 'object', properties: { taskId, reason: { type: 'string' } }, required: ['taskId'], additionalProperties: false,
  }),
  tool('agents.answer_input', 'Answer a clarification requested by a remote task.', {
    type: 'object', properties: { taskId, requestId: { type: 'string' }, input: {} }, required: ['taskId', 'requestId', 'input'], additionalProperties: false,
  }),
  tool('task.report_progress', 'Report progress for the current inbound agent task.', {
    type: 'object', properties: { taskId, percent: { type: 'number', minimum: 0, maximum: 100 }, stage: { type: 'string' }, message: { type: 'string' } }, required: ['taskId'], additionalProperties: false,
  }),
  tool('task.request_input', 'Pause the current task and request structured caller input.', {
    type: 'object', properties: { taskId, requestId: { type: 'string' }, question: { type: 'string' }, inputSchema: { type: 'object' } }, required: ['taskId', 'question', 'inputSchema'], additionalProperties: false,
  }),
  tool('task.complete', 'Complete the current task with a result matching its pinned output schema.', {
    type: 'object', properties: { taskId, result: {}, summary: { type: 'string' } }, required: ['taskId', 'result'], additionalProperties: false,
  }),
  tool('task.fail', 'Fail the current task with a structured error.', {
    type: 'object', properties: { taskId, code: { type: 'string' }, message: { type: 'string' }, retryable: { type: 'boolean' } }, required: ['taskId', 'code', 'message'], additionalProperties: false,
  }),
  tool('task.cancelled', 'Confirm that cooperative cancellation of the current task has completed.', {
    type: 'object', properties: { taskId }, required: ['taskId'], additionalProperties: false,
  }),
];

registerTools(xmppAgentGatewayTools);
