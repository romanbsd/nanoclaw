/**
 * MCP server bootstrap + tool self-registration.
 *
 * Each tool module calls `registerTools([...])` at import time. The
 * barrel (`index.ts`) imports every tool module for side effects, then
 * calls `startMcpServer()` which uses whatever was registered.
 *
 * Default when only `core.ts` is imported: the core `send_message` /
 * `send_file` / `edit_message` / `add_reaction` tools are available.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

const allTools: McpToolDefinition[] = [];
const toolMap = new Map<string, McpToolDefinition>();

function enabledTools(): McpToolDefinition[] {
  const configured = process.env.NANOCLAW_MCP_TOOL_ALLOWLIST;
  if (!configured) return allTools;
  const allowed = new Set(configured.split(',').map((name) => name.trim()).filter(Boolean));
  return allTools.filter((definition) => allowed.has(definition.tool.name));
}

export function registerTools(tools: McpToolDefinition[]): void {
  for (const t of tools) {
    if (toolMap.has(t.tool.name)) {
      log(`Warning: tool "${t.tool.name}" already registered, skipping duplicate`);
      continue;
    }
    allTools.push(t);
    toolMap.set(t.tool.name, t);
  }
}

export function listRegisteredTools(): import('@modelcontextprotocol/sdk/types.js').Tool[] {
  return enabledTools().map((t) => t.tool);
}

export async function startMcpServer(): Promise<void> {
  const server = new Server({ name: 'nanoclaw', version: '2.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: enabledTools().map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = enabledTools().find((definition) => definition.tool.name === name);
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
    return tool.handler(args ?? {});
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const tools = enabledTools();
  log(`MCP server started with ${tools.length} tools: ${tools.map((t) => t.tool.name).join(', ')}`);
}
