import { build as esbuild } from 'esbuild';
import { build as vite } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Main process: ESM bundle, with workspace packages (TypeScript sources) and cheerio inlined.
await esbuild({
  entryPoints: [path.join(root, 'src/main/index.ts')],
  outfile: path.join(root, 'dist/main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron', 'sqlite-vec', '@huggingface/transformers', 'onnxruntime-node', 'sharp', 'tesseract.js', '@tesseract.js-data/eng', 'pdfjs-dist', 'pdfjs-dist/legacy/build/pdf.mjs'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

// The MCP server the app tells Claude Desktop / Claude Code to launch. It lives next to the app code (inside app.asar
// when installed) so it finds the same native modules; the app's own Node runs it (ELECTRON_RUN_AS_NODE).
await esbuild({
  entryPoints: [path.join(root, '../market-mcp/src/main.ts')],
  outfile: path.join(root, 'dist/mcp.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['sqlite-vec', '@huggingface/transformers', 'onnxruntime-node', 'sharp'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

await import('./zip-extension.mjs');

// Sandboxed preload must be CommonJS.
await esbuild({
  entryPoints: [path.join(root, 'src/preload/index.cts')],
  outfile: path.join(root, 'dist/preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
});

await vite({
  root: path.join(root, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: { outDir: path.join(root, 'dist/renderer'), emptyOutDir: true },
  logLevel: 'warn',
});
