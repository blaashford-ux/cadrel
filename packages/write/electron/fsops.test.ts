import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFile, createFolder, renameNode } from './fsops';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mdedit-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createFile', () => {
  it('adds .md, writes content, and refuses to overwrite', async () => {
    const p = await createFile(dir, 'chapter one', '# Hi\n');
    expect(path.basename(p)).toBe('chapter one.md');
    expect(await readFile(p, 'utf8')).toBe('# Hi\n');
    await expect(createFile(dir, 'chapter one.md')).rejects.toThrow(/already exists/);
    expect(await readFile(p, 'utf8')).toBe('# Hi\n');
  });

  it('rejects invalid names and path tricks', async () => {
    for (const bad of ['', 'a/b', '..', 'x:y', 'CON']) await expect(createFile(dir, bad)).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('createFolder', () => {
  it('creates a folder once, rejecting clashes and bad names', async () => {
    const p = await createFolder(dir, 'notes');
    expect(path.basename(p)).toBe('notes');
    await expect(createFolder(dir, 'notes')).rejects.toThrow(/already exists/);
    for (const bad of ['', 'a/b', '..', 'CON']) await expect(createFolder(dir, bad)).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['notes']);
  });
});

describe('renameNode', () => {
  it('renames a file, keeping the extension, and a folder', async () => {
    const f = path.join(dir, 'a.md');
    await writeFile(f, 'x');
    const f2 = await renameNode(f, 'b');
    expect(path.basename(f2)).toBe('b.md');
    await mkdir(path.join(dir, 'd'));
    expect(path.basename(await renameNode(path.join(dir, 'd'), 'e.txt'))).toBe('e.txt');
    expect((await readdir(dir)).sort()).toEqual(['b.md', 'e.txt']);
  });

  it('refuses to overwrite an existing item but allows a case-only change', async () => {
    await writeFile(path.join(dir, 'a.md'), '1');
    await writeFile(path.join(dir, 'b.md'), '2');
    await expect(renameNode(path.join(dir, 'a.md'), 'b.md')).rejects.toThrow(/already exists/);
    expect(await readFile(path.join(dir, 'b.md'), 'utf8')).toBe('2');
    const up = await renameNode(path.join(dir, 'a.md'), 'A.md');
    expect(path.basename(up)).toBe('A.md');
  });
});
