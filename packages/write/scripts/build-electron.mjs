// Bundles the Electron main process and preload (what `esbuild ... ` did in package.json), and bakes in the Google Desktop
// OAuth client secret from the environment so it never lives in the repository. Without it the app still builds; Google
// sign-in then says it isn't set up in this build.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { writeSkills } from './skills.mjs';

rmSync('dist-electron', { recursive: true, force: true });
writeSkills(); // the skills' text, for the MCP server's prompts

await build({
  entryPoints: ['electron/main.ts', 'electron/preload.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
  outdir: 'dist-electron/electron',
  sourcemap: true,
  define: { 'process.env.MDEDIT_GOOGLE_CLIENT_SECRET_BUILD': JSON.stringify(process.env.MDEDIT_GOOGLE_CLIENT_SECRET ?? '') },
  logLevel: 'info',
});

// The MCP server for AI reviewers: one self-contained file that Claude, GPT and other MCP clients launch with Node.
await build({
  entryPoints: { 'mdedit-mcp': 'mcp/main.ts' },
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outdir: 'dist-electron/mcp',
  define: { 'process.env.MDEDIT_VERSION': JSON.stringify(process.env.npm_package_version ?? '') },
  logLevel: 'info',
});

if (!process.env.MDEDIT_GOOGLE_CLIENT_SECRET) console.warn('Note: MDEDIT_GOOGLE_CLIENT_SECRET is not set, so Google Drive sync is not configured in this build.');
