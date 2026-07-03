import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { gatewayPost } from './gateway-client.js';
import { gatewayTools } from './tools.js';

function gatewayErrorResult(err: unknown): CallToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
}

async function invokeTool(path: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return gatewayPost(path, args)
    .then(
      (result): CallToolResult => ({
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }),
    )
    .catch(gatewayErrorResult);
}

function registerGatewayTools(mcp: McpServer): void {
  for (const tool of gatewayTools) {
    mcp.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args) => invokeTool(tool.path, args as Record<string, unknown>),
    );
  }
}

async function main(): Promise<void> {
  const mcp = new McpServer({ name: 'agent-xmpp-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });
  registerGatewayTools(mcp);
  await mcp.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error('[agent-xmpp-mcp] fatal:', err);
  process.exit(1);
});
