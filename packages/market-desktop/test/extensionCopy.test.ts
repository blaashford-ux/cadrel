import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureExtensionCopy } from '../src/main/extensionCopy';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'cadrel-ext-'));
async function ext(dir: string, version: string, files: Record<string, string> = {}) {
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'Cadrel Market', version }));
  for (const [f, t] of Object.entries(files)) await writeFile(path.join(dir, f), t);
}

describe('the Chrome extension copy outside the install folder', () => {
  it('makes the copy the first time, with every file', async () => {
    const base = await tmp();
    const src = path.join(base, 'install', 'extension');
    const dest = path.join(base, 'data', 'chrome-extension');
    await ext(src, '0.6.3', { 'src/background.js': 'one' });
    expect(await ensureExtensionCopy(src, dest)).toBe(dest);
    expect(await readFile(path.join(dest, 'src', 'background.js'), 'utf8')).toBe('one');
  });
  it('leaves a copy of the same version alone, and replaces it when the app carries a different one, dropping files that are gone', async () => {
    const base = await tmp();
    const src = path.join(base, 'install', 'extension');
    const dest = path.join(base, 'data', 'chrome-extension');
    await ext(src, '0.6.3', { 'src/background.js': 'one', 'src/old.js': 'old' });
    await ensureExtensionCopy(src, dest);
    await writeFile(path.join(dest, 'src', 'background.js'), 'edited in place');
    await ensureExtensionCopy(src, dest);
    expect(await readFile(path.join(dest, 'src', 'background.js'), 'utf8')).toBe('edited in place'); // same version: untouched
    await ext(src, '0.7.0', { 'src/background.js': 'two' });
    await ensureExtensionCopy(src, dest);
    expect(await readFile(path.join(dest, 'src', 'background.js'), 'utf8')).toBe('two');
    expect((await readdir(path.join(dest, 'src'))).sort()).toEqual(['background.js', 'old.js']); // the rebuilt source still lists what the app ships
    await (await import('node:fs/promises')).rm(path.join(src, 'src', 'old.js'));
    await ext(src, '0.7.1', { 'src/background.js': 'three' });
    await ensureExtensionCopy(src, dest);
    expect((await readdir(path.join(dest, 'src'))).sort()).toEqual(['background.js']);
  });
  it('uses the app’s own folder when the app carries no extension (a development run)', async () => {
    const base = await tmp();
    const src = path.join(base, 'nothing');
    expect(await ensureExtensionCopy(src, path.join(base, 'dest'))).toBe(src);
  });
});
