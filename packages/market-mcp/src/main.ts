#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Library } from '@cadrel/market-library';
import { resolveLibraryRoot } from './config.js';
import { embedderForModel } from './embedders.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { SERVER_CAPABILITIES, SERVER_INFO, SERVER_INSTRUCTIONS, createServer } from './server.js';

// `--print-handshake`: what this server answers to `initialize`, without opening a library. The app puts it in the Claude Desktop extension's
// launcher so Claude gets its answer at once while this process is still starting.
if (process.argv.includes('--print-handshake')) {
  process.stdout.write(JSON.stringify({ serverInfo: SERVER_INFO, capabilities: SERVER_CAPABILITIES, instructions: SERVER_INSTRUCTIONS, protocolVersions: SUPPORTED_PROTOCOL_VERSIONS }));
  process.exit(0);
}

const root = resolveLibraryRoot(process.argv.slice(2), process.env);
if (!root) {
  console.error('BookScout MCP: no library found. Pass --library <folder>, set BOOKSCOUT_LIBRARY, or choose a library in the BookScout app first.');
  process.exit(2);
}
const lib = Library.open(root);
const server = createServer({ lib, embedderFor: (m) => embedderForModel(m, root) });
await server.connect(new StdioServerTransport());
process.on('SIGINT', () => { lib.close(); process.exit(0); });
