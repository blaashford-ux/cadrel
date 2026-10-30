// Runs electron-builder with the right configuration: a development build (CADREL_DEV_BUILD set, as CI sets it for any build not of
// `main`) uses electron-builder.dev.yml so it installs beside the stable Cadrel; anything else uses electron-builder.yml.
// Usage: node scripts/builder.mjs <electron-builder arguments>
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const configFor = (devBuild) => (devBuild?.trim() ? 'electron-builder.dev.yml' : 'electron-builder.yml');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bin = path.join(path.dirname(createRequire(path.join(root, 'package.json')).resolve('electron-builder/package.json')), 'cli.js');
  const r = spawnSync(process.execPath, [bin, '--config', configFor(process.env.CADREL_DEV_BUILD), ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
