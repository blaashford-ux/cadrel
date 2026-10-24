// Builds the whole shell into dist/: the shell's own main, preload and page, plus everything Write and Market need,
// produced from their existing sources (nothing in those packages is copied by hand or changed to build here).
//
//   dist/main.mjs, preload.cjs, renderer/        the shell
//   dist/modules/write/{preload.cjs,renderer/}    Write's view
//   dist/modules/market/{preload.cjs,renderer/}   Market's view
//   dist/mcp.mjs                                  the MCP server Claude launches
//   dist/assets/{fonts,vendor,icon.png}           what Write's print pipeline reads
//   dist/resources/extension/, bookscout-extension.zip
import { build as esbuild } from 'esbuild';
import { build as vite } from 'vite';
import react from '@vitejs/plugin-react';
import { zipSync } from 'fflate';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgs = path.resolve(root, '..');
const write = path.join(pkgs, 'write');
const market = path.join(pkgs, 'market-desktop');
const dist = path.join(root, 'dist');
const rel = (p) => path.relative(pkgs, p);

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const NATIVE = ['electron', 'sqlite-vec', '@huggingface/transformers', 'onnxruntime-node', 'sharp', 'tesseract.js', '@tesseract.js-data/eng', 'pdfjs-dist', 'pdfjs-dist/legacy/build/pdf.mjs'];
const esmBanner = { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" };
const page = (dir, out) => vite({ root: dir, base: './', plugins: [react()], build: { outDir: out, emptyOutDir: true }, logLevel: 'warn' });
const preloadCjs = (entry, out) => esbuild({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], logLevel: 'warning' });

// ---- assets Write's print pipeline reads at run time ----
const polyfill = path.join(path.dirname(createRequire(path.join(write, 'package.json')).resolve('pagedjs')), '..', 'dist', 'paged.polyfill.js');
// Write's whole assets folder: fonts, help, branding, icon (vendor/ is generated, so the polyfill is copied from the package itself).
fs.cpSync(path.join(write, 'assets'), path.join(dist, 'assets'), { recursive: true, filter: (src) => !src.includes(`${path.sep}vendor`) });
fs.mkdirSync(path.join(dist, 'assets', 'vendor'), { recursive: true });
fs.copyFileSync(polyfill, path.join(dist, 'assets', 'vendor', 'paged.polyfill.js'));

// ---- Write's view ----
await page(path.join(write, 'src', 'renderer'), path.join(dist, 'modules', 'write', 'renderer'));
await preloadCjs(path.join(write, 'electron', 'preload.ts'), path.join(dist, 'modules', 'write', 'preload.cjs'));

// ---- Market's view, its MCP server and browser extension ----
await page(path.join(market, 'src', 'renderer'), path.join(dist, 'modules', 'market', 'renderer'));
await preloadCjs(path.join(market, 'src', 'preload', 'index.cts'), path.join(dist, 'modules', 'market', 'preload.cjs'));
// The one MCP server for the whole suite (Write's tools and Market's), run by the app's own Node (ELECTRON_RUN_AS_NODE)
// so it finds the same native modules.
const version = fs.readFileSync(path.join(root, '..', '..', 'VERSION'), 'utf8').trim();
await esbuild({
  entryPoints: [path.join(pkgs, 'mcp', 'src', 'main.ts')],
  outfile: path.join(dist, 'mcp.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: NATIVE,
  banner: esmBanner,
  define: { 'process.env.CADREL_VERSION': JSON.stringify(version) },
  logLevel: 'warning'
});
const ext = path.join(pkgs, 'market-extension');
const extOut = path.join(dist, 'resources', 'extension');
fs.mkdirSync(extOut, { recursive: true });
fs.copyFileSync(path.join(ext, 'manifest.json'), path.join(extOut, 'manifest.json'));
fs.cpSync(path.join(ext, 'src'), path.join(extOut, 'src'), { recursive: true });
const files = {};
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files[path.relative(extOut, p).split(path.sep).join('/')] = new Uint8Array(fs.readFileSync(p));
  }
})(extOut);
fs.writeFileSync(path.join(dist, 'resources', 'bookscout-extension.zip'), zipSync(files, { level: 9 }));

// ---- the shell ----
await esbuild({
  entryPoints: [path.join(root, 'src', 'main', 'index.ts')],
  outfile: path.join(dist, 'main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: NATIVE,
  banner: esmBanner,
  logLevel: 'warning'
});
await preloadCjs(path.join(root, 'src', 'preload', 'index.cts'), path.join(dist, 'preload.cjs'));
await page(path.join(root, 'src', 'renderer'), path.join(dist, 'renderer'));

console.log(`built ${rel(dist)}: ${fs.readdirSync(dist).join(', ')}`);
