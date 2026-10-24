// Bundles the server into dist/mcp.mjs: one file the app launches with its own runtime (ELECTRON_RUN_AS_NODE), next to
// the native modules it needs. The shell's build makes the same bundle into its own dist; this one is for tests and
// for running the server by hand.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = fs.readFileSync(path.join(root, '..', '..', 'VERSION'), 'utf8').trim();

export const NATIVE = ['sqlite-vec', '@huggingface/transformers', 'onnxruntime-node', 'sharp', 'tesseract.js', '@tesseract.js-data/eng', 'pdfjs-dist', 'pdfjs-dist/legacy/build/pdf.mjs'];

await build({
  entryPoints: [path.join(root, 'src', 'main.ts')],
  outfile: path.join(root, 'dist', 'mcp.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: NATIVE,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  define: { 'process.env.CADREL_VERSION': JSON.stringify(version) },
  logLevel: 'warning'
});
console.log('built packages/mcp/dist/mcp.mjs');
