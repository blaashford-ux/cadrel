// Packs the browser extension (manifest + src) into dist/cadrel-market-extension.zip for sideloading.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.resolve(root, '../market-extension');
const files = {};
const add = (rel) => (files[rel.split(path.sep).join('/')] = new Uint8Array(fs.readFileSync(path.join(ext, rel))));
add('manifest.json');
const walk = (dir) => {
  for (const e of fs.readdirSync(path.join(ext, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel);
    else add(rel);
  }
};
walk('src');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/cadrel-market-extension.zip'), zipSync(files, { level: 9 }));
console.log('extension zip:', Object.keys(files).length, 'files');
