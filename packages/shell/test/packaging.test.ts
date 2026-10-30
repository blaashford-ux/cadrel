import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PKG = path.resolve(__dirname, '..');
const req = createRequire(path.join(PKG, 'package.json'));
const yml = fs.readFileSync(path.join(PKG, 'electron-builder.yml'), 'utf8');

describe('packaging', () => {
  it('electron-builder is pinned to the Electron that is installed', () => {
    const pinned = /^electronVersion:\s*(\S+)/m.exec(yml)?.[1];
    expect(pinned).toBe(req('electron/package.json').version);
  });

  it('a development build installs beside the stable one: own app id, product name and shortcut, no file types, and the same installer file name', async () => {
    const dev = fs.readFileSync(path.join(PKG, 'electron-builder.dev.yml'), 'utf8');
    expect(dev).toMatch(/^extends: \.\/electron-builder\.yml$/m);
    expect(dev).toMatch(/^appId: com\.blaashford\.cadrel\.dev$/m);
    expect(dev).toMatch(/^productName: Cadrel Dev$/m);
    expect(dev).toMatch(/^fileAssociations: \[\]$/m);
    expect(dev).toMatch(/^ {2}shortcutName: Cadrel Dev$/m);
    expect(dev).not.toMatch(/artifactName/); // the updater and release workflow look for Cadrel-Setup-*.exe
    expect(yml).toMatch(/^appId: com\.blaashford\.cadrel$/m);
    const { configFor } = await import(path.join(PKG, 'scripts', 'builder.mjs'));
    expect(configFor('dev.7')).toBe('electron-builder.dev.yml');
    expect(configFor('')).toBe('electron-builder.yml');
    expect(configFor(undefined)).toBe('electron-builder.yml');
  });

  it('the installer version matches the VERSION file', () => {
    expect(() => execFileSync('node', ['scripts/sync-version.mjs', '--check'], { cwd: PKG, stdio: 'pipe' })).not.toThrow();
  });

  it('a development build (CADREL_DEV_BUILD set, as CI sets it off main) embeds a "-dev.N" version the updater can tell from a stable release', () => {
    const file = path.join(PKG, 'package.json');
    const before = fs.readFileSync(file, 'utf8');
    const version = fs.readFileSync(path.join(PKG, '..', '..', 'VERSION'), 'utf8').trim();
    try {
      execFileSync('node', ['scripts/sync-version.mjs'], { cwd: PKG, stdio: 'pipe', env: { ...process.env, CADREL_DEV_BUILD: 'dev.42' } });
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(`${version}-dev.42`);
      // --check agrees it is in sync as long as the same CADREL_DEV_BUILD is given back
      expect(() => execFileSync('node', ['scripts/sync-version.mjs', '--check'], { cwd: PKG, stdio: 'pipe', env: { ...process.env, CADREL_DEV_BUILD: 'dev.42' } })).not.toThrow();
      // and disagrees once the build moves on to a different run
      expect(() => execFileSync('node', ['scripts/sync-version.mjs', '--check'], { cwd: PKG, stdio: 'pipe', env: { ...process.env, CADREL_DEV_BUILD: 'dev.43' } })).toThrow();
    } finally {
      fs.writeFileSync(file, before);
    }
  });

  it('every module the main bundle leaves external ships with the app (reachable from the shell\'s production dependencies)', () => {
    const build = fs.readFileSync(path.join(PKG, 'scripts', 'build.mjs'), 'utf8');
    const external = /const NATIVE = \[([^\]]+)\]/.exec(build)![1]!.match(/'([^']+)'/g)!.map((x) => x.slice(1, -1)).filter((n) => n !== 'electron' && !n.includes('/legacy/'));
    // Walk the production dependency graph the way electron-builder packs it: dependencies and optionalDependencies, transitively.
    const seen = new Set<string>();
    const queue = Object.keys(req('./package.json').dependencies as Record<string, string>);
    while (queue.length) {
      const name = queue.pop()!;
      if (seen.has(name)) continue;
      seen.add(name);
      let pj: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
      try {
        pj = JSON.parse(fs.readFileSync(req.resolve(`${name}/package.json`, { paths: [PKG] }), 'utf8'));
      } catch {
        try {
          // packages that do not export package.json: find it by walking up from the main entry
          let dir = path.dirname(req.resolve(name));
          while (!fs.existsSync(path.join(dir, 'package.json')) || JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name !== name) dir = path.dirname(dir);
          pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        } catch {
          continue;
        }
      }
      queue.push(...Object.keys({ ...pj.dependencies, ...pj.optionalDependencies }));
    }
    for (const name of external) expect(seen.has(name), `${name} is external to the bundle, so it must be reachable from the shell's dependencies`).toBe(true);
  });

  it('the native modules are unpacked from the asar', () => {
    for (const mod of ['sqlite-vec', 'sharp', 'onnxruntime-node', 'tesseract.js']) expect(yml, mod).toContain(`node_modules/${mod}`);
  });

  it('the installer, the app and the assistant server all use the same "let go" marker, so an update is never blocked by a running assistant server', () => {
    const nsh = fs.readFileSync(path.join(PKG, 'build', 'installer.nsh'), 'utf8');
    const app = fs.readFileSync(path.join(PKG, 'src', 'main', 'index.ts'), 'utf8');
    const server = fs.readFileSync(path.join(PKG, '..', 'mcp', 'src', 'main.ts'), 'utf8');
    for (const [name, text] of [['installer.nsh', nsh], ['main/index.ts', app], ['mcp/main.ts', server]] as const) expect(text, name).toContain('.cadrel-retire');
    expect(nsh).toContain('!macro customInit');
    expect(nsh).toContain('!macro customInstall'); // the marker is removed once the new files are in
  });
});
