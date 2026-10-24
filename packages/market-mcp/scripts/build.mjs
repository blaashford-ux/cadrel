import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// One self-contained file: the desktop app points Claude Desktop at it with the app's own Node (Electron run as Node).
await build({
  entryPoints: [path.join(root, 'src/main.ts')],
  outfile: path.join(root, 'dist/main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['sqlite-vec', '@huggingface/transformers', 'onnxruntime-node', 'sharp'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
