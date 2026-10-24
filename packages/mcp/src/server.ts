/**
 * The Cadrel MCP server: one connection that carries every module's tools. A module describes what it contributes
 * (`McpModule`); this composes them, names the server, and writes instructions that say what each part is for. The
 * module definitions live with the modules (Write's in packages/write/mcp, Market's in packages/market-mcp).
 *
 * Tool names are one flat list, and the SDK refuses a duplicate name, so a module that picks a name another module
 * already uses fails at start-up, not as a confusing call at run time (see test/server.test.ts).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const SERVER_NAME = 'cadrel';

/** What one module adds to the server. */
export interface McpModule {
  id: string;
  /** Heading for this module's part of the instructions, e.g. "Writing (manuscripts and review notes)". */
  title: string;
  /** What the AI should know about this module's tools. */
  instructions: string;
  /** Registers the module's tools (and prompts) on the server. */
  register(server: McpServer): void;
  /** True if `register` adds prompts, so the server advertises them. */
  prompts?: boolean;
}

/** What the AI is told, composed from the modules that are actually present. */
export function composeInstructions(modules: McpModule[]): string {
  const parts = [
    'Cadrel is a book studio: authors write in it, editors review in it, and its market research tells them what readers buy. ' +
      'This server carries the tools of each part that is available on this computer.'
  ];
  for (const m of modules) parts.push(`## ${m.title}\n${m.instructions}`);
  if (modules.length === 0) parts.push('No project folder and no market library were found, so there are no tools yet. Open Cadrel and set them up.');
  return parts.join('\n\n');
}

/** What the server advertises in `initialize`. */
export function capabilitiesOf(modules: McpModule[]): Record<string, unknown> {
  return { tools: { listChanged: true }, ...(modules.some((m) => m.prompts) ? { prompts: { listChanged: true } } : {}) };
}

export function createCadrelServer(o: { version?: string; modules: McpModule[] }): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: o.version ?? '0.0.0' }, { instructions: composeInstructions(o.modules) });
  for (const m of o.modules) m.register(server);
  return server;
}
