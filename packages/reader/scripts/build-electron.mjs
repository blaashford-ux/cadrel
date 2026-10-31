// Bundles Cadrel Reader's Electron main process, and Cadrel Write's preload script (the one window bridge both apps share; Reader's
// window passes --cadrel-reader so it exposes Reader's capabilities). The Google Desktop OAuth client secret comes from the
// environment so it never lives in the repository. Without it the app still builds; Google sign-in then says it isn't set up.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const write = (p) => fileURLToPath(new URL(`../../write/${p}`, import.meta.url));

rmSync('dist-electron', { recursive: true, force: true });

await build({
  entryPoints: { main: 'electron/main.ts', preload: write('electron/preload.ts') },
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
  outdir: 'dist-electron/electron',
  sourcemap: true,
  define: { 'process.env.CADREL_WRITE_GOOGLE_CLIENT_SECRET_BUILD': JSON.stringify(process.env.CADREL_WRITE_GOOGLE_CLIENT_SECRET ?? '') },
  logLevel: 'info'
});

if (!process.env.CADREL_WRITE_GOOGLE_CLIENT_SECRET) console.warn('Note: CADREL_WRITE_GOOGLE_CLIENT_SECRET is not set, so Google sign-in is not configured in this build.');
