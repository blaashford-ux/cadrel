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

  it('the installer version matches the VERSION file', () => {
    expect(() => execFileSync('node', ['scripts/sync-version.mjs', '--check'], { cwd: PKG, stdio: 'pipe' })).not.toThrow();
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
});
