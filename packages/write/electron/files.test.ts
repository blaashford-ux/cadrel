import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWithStamp, statStamp, writeFileAtomic } from './files';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mdedit-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('overwrites the file, keeps BOM/CRLF, and leaves no temp files', async () => {
    const f = path.join(dir, 'a.md');
    await writeFile(f, 'old');
    const content = '﻿# Hi\r\nthere\r\n';
    await writeFileAtomic(f, content);
    expect(await readFile(f, 'utf8')).toBe(content);
    expect(await readdir(dir)).toEqual(['a.md']);
  });

  it('returns a stamp equal to what statStamp reports afterwards', async () => {
    const f = path.join(dir, 'a.md');
    const stamp = await writeFileAtomic(f, 'hello');
    expect(stamp).toEqual(await statStamp(f));
    expect(stamp.size).toBe(5);
  });
});

describe('statStamp / readWithStamp', () => {
  it('returns null for a missing file', async () => {
    expect(await statStamp(path.join(dir, 'nope.md'))).toBeNull();
  });

  it('changes when the file is modified', async () => {
    const f = path.join(dir, 'a.md');
    await writeFile(f, 'one');
    const { text, stamp } = await readWithStamp(f);
    expect(text).toBe('one');
    await writeFile(f, 'three');
    expect(await statStamp(f)).not.toEqual(stamp);
  });
});
