/**
 * Starts MDEdit's MCP server. An MCP client (Claude Desktop, Claude Code, Codex, ...) launches this as a subprocess over stdio:
 *   node mdedit-mcp.js [--root <folder>] [--agent <name>]
 * With --http it listens on this PC instead (MCP at /mcp, REST at /api, both behind a token):
 *   node mdedit-mcp.js --http [--port 47831] [--token <secret>]
 * Over stdio nothing but protocol messages may go to stdout; diagnostics go to stderr.
 */
import { randomBytes } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { nodeFs } from '../electron/nodeFs';
import { startHttp } from './http';
import { createServer } from './server';
import { listProjects } from '../src/shared/agent/tools';
import { chooseRoot, rootCandidates } from './root';

function flag(name: string): string | undefined {
  const args = process.argv.slice(2);
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  return args[i].includes('=') ? args[i].slice(args[i].indexOf('=') + 1) : args[i + 1];
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    process.stderr.write(
      'MDEdit MCP server\n  --root <folder>   the folder that holds your projects (default: the Root Folder set in MDEdit)\n  --agent <name>    how the AI is named in the Notes panel (default: taken from the client)\n' +
        '  --http            listen on 127.0.0.1 instead of stdio: MCP at /mcp, REST at /api, API description at /openapi.json\n  --port <n>        port for --http (default 47831)\n  --token <secret>  access token for --http (default: MDEDIT_TOKEN, or a new random one printed here)\n'
    );
    return;
  }
  const candidates = await rootCandidates({ flag: flag('root'), fs: nodeFs });
  const { root, source, tried } = await chooseRoot(candidates, async (r) => (await listProjects({ fs: nodeFs, root: r, agent: 'ai', agentName: 'AI' })).length > 0);
  if (source !== candidates[0].source) process.stderr.write(`No projects in the projects folder from ${candidates[0].source} (${candidates[0].root}); using ${root} (${source}) instead.\n`);
  const st = await nodeFs.stat(root);
  if (!st?.isDirectory) throw new Error(`The projects folder "${root}" (from ${source}) does not exist. Pass --root <folder>.`);
  if (process.argv.includes('--http')) {
    const token = flag('token') ?? process.env.MDEDIT_TOKEN ?? randomBytes(24).toString('base64url');
    const http = await startHttp({ fs: nodeFs, root, tried, agent: flag('agent'), version: process.env.MDEDIT_VERSION, token, port: Number(flag('port') ?? 47831) });
    process.stderr.write(`MDEdit AI access ready on http://${http.host}:${http.port}  (MCP: /mcp, REST: /api, description: /openapi.json)\nProjects folder: ${root} (${source})\nAccess token: ${token}\n`);
    return;
  }
  const server = createServer({ fs: nodeFs, root, tried, agent: flag('agent'), version: process.env.MDEDIT_VERSION });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`MDEdit MCP server ready. Projects folder: ${root} (${source})\n`);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
