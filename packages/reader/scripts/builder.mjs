// Runs electron-builder for Cadrel Reader. The Electron package is installed once at the top of the workspace, where electron-builder
// can't see it from here, so its exact version is passed in. Usage: node scripts/builder.mjs <electron-builder arguments>
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const electronVersion = require('electron/package.json').version;
const bin = path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js');
const r = spawnSync(process.execPath, [bin, `-c.electronVersion=${electronVersion}`, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
