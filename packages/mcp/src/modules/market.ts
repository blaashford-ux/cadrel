import { registerMarketTools, SERVER_INSTRUCTIONS, type ToolContext } from '@cadrel/market-mcp';
import type { McpModule } from '../server.js';

/** Market: the Amazon research library (Cadrel Market's tools). Loaded on demand, because it needs the app's native modules. */
export function marketModule(ctx: ToolContext): McpModule {
  return {
    id: 'market',
    title: 'Market research (the Amazon library)',
    instructions: SERVER_INSTRUCTIONS,
    register: (server) => registerMarketTools(server, ctx)
  };
}
