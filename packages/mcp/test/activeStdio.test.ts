// The real built server behind the real extension launcher, the way Claude Desktop runs it: one unchanging configuration, two Studios, a switch while connected.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launcherSource } from '../../market-desktop/src/main/launcher.js';

const PKG = path.resolve(__dirname, '..');
const BUNDLE = path.join(PKG, 'dist', 'mcp.mjs');
let tmp: string;

const studio = (name: string, book: string) => {
  const root = path.join(tmp, name, 'Projects');
  fs.mkdirSync(path.join(root, book, '.cadrel'), { recursive: true });
  fs.writeFileSync(path.join(root, book, '.cadrel', 'project.json'), '{"status":"drafting"}');
  fs.writeFileSync(path.join(root, book, 'Book.md'), '# One\n\nText.\n');
  return ['--root', root, '--studio', path.join(tmp, name, 'studio.json'), '--library', path.join(tmp, name, 'no-library')];
};

beforeAll(() => {
  execFileSync('node', ['scripts/build.mjs'], { cwd: PKG, stdio: 'ignore' });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-active-e2e-'));
}, 90_000);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const text = (r: unknown) => JSON.stringify(r);

describe('one configuration for every Studio', () => {
  it('serves the active Studio, and follows a switch without reconnecting', async () => {
    const loric = studio('Loric', 'Loric Novel');
    const blackCat = studio('BlackCat', 'Black Cat Novel');
    const active = path.join(tmp, 'mcp-active.json');
    const write = (name: string, args: string[]) => fs.writeFileSync(active, JSON.stringify({ studio: name, args }));
    write('Loric', loric);

    const launcher = path.join(tmp, 'launch.js');
    // what the extension holds: no Studio in it at all, and (as in the app) stale paths from an older configuration that must not win
    fs.writeFileSync(launcher, launcherSource({ command: process.execPath, args: [BUNDLE, '--root', path.join(tmp, 'stale'), '--active', active], env: {}, handshake: null, logFile: null, followFile: active }));
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), XDG_CONFIG_HOME: path.join(home, '.config'), CADREL_WRITE_ROOT: '', CADREL_MARKET_LIBRARY: '' } as Record<string, string>;

    const client = new Client({ name: 'claude-test', version: '0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [launcher], env, stderr: 'pipe' }));
    try {
      const first = text(await client.callTool({ name: 'list_projects', arguments: {} }));
      expect(first).toContain('Loric Novel');
      expect(first).not.toContain('Black Cat Novel');

      write('Black Cat Books', blackCat); // Cadrel started in the other Studio

      let second = '';
      for (const start = Date.now(); Date.now() - start < 20_000; await new Promise((r) => setTimeout(r, 300))) {
        second = text(await client.callTool({ name: 'list_projects', arguments: {} }).catch((e) => e.message));
        if (second.includes('Black Cat Novel')) break;
      }
      expect(second).toContain('Black Cat Novel');
      expect(second).not.toContain('Loric Novel');
    } finally {
      await client.close();
    }
  }, 90_000);
});
