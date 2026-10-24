import { registerWriteTools, WRITE_INSTRUCTIONS, type ServerOptions as WriteOptions } from '@cadrel/write/mcp/server';
import type { McpModule } from '../server.js';

/** Write: the manuscripts, chapters and review notes in the projects folder (MDEdit's own tools, unchanged). */
export function writeModule(o: WriteOptions): McpModule {
  return {
    id: 'write',
    title: 'Writing (manuscripts and review notes)',
    instructions: WRITE_INSTRUCTIONS,
    register: (server) => registerWriteTools(server, o),
    prompts: true
  };
}
