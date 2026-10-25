import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_INSTRUCTIONS, TOOLS, type ToolContext } from './tools.js';

export { SERVER_INSTRUCTIONS };

const MAX_CHARS = 60000;

/** What the server says about itself in `initialize`. The Claude Desktop extension's launcher answers the handshake with these (from `--print-handshake`) while the server is still starting. */
export const SERVER_INFO = { name: 'bookscout', version: '0.6.3' };
export const SERVER_CAPABILITIES = { tools: { listChanged: true } };

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  registerMarketTools(server, ctx);
  return server;
}

/** Cadrel Market's tools, registered on any MCP server (so one server can carry several modules' tools). */
export function registerMarketTools(server: McpServer, ctx: ToolContext): void {
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.shape, annotations: { readOnlyHint: t.readOnly, openWorldHint: false, destructiveHint: false } },
      async (args: any) => {
        try {
          const r = await t.run(ctx, args);
          if ('error' in r) return { isError: true, content: [{ type: 'text' as const, text: r.error }] };
          const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [];
          if ('image' in r) content.push({ type: 'image', data: r.image.base64, mimeType: r.image.mimeType });
          if (r.data !== undefined) {
            let text = JSON.stringify(r.data, null, 1);
            if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '\n…truncated; narrow the query (smaller limit, one category, one kind)';
            content.push({ type: 'text', text });
          }
          return { content };
        } catch (e) {
          return { isError: true, content: [{ type: 'text' as const, text: `tool failed: ${(e as Error).message}` }] };
        }
      },
    );
  }
}
