import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { blocksFor, sanitizeBlocks } from '../src/shared/textBlocks';
import { TextBlockStore } from './textBlocks';

const dirs: string[] = [];
afterEach(async () => void (await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))));
const store = async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'blocks-'));
  dirs.push(d);
  return { file: path.join(d, 'text-blocks.json'), s: new TextBlockStore(path.join(d, 'text-blocks.json')) };
};

describe('saved text blocks', () => {
  it('saves a block, finds it again after a restart, and offers each place only its own kind, by name', async () => {
    const { file, s } = await store();
    await s.save({ kind: 'back', name: 'Bio — short', text: 'Ann writes.' });
    await s.save({ kind: 'back', name: 'Bio — long', text: 'Ann writes a lot.' });
    await s.save({ kind: 'copyright', name: 'Fiction', text: 'This is fiction.' });
    const again = await new TextBlockStore(file).list();
    expect(blocksFor(again, 'back').map((b) => b.name)).toEqual(['Bio — long', 'Bio — short']);
    expect(blocksFor(again, 'front')).toEqual([]);
  });

  it('replaces a block saved under the same name (ignoring case) instead of keeping two', async () => {
    const { s } = await store();
    const a = await s.save({ kind: 'front', name: 'Dedication', text: 'For Mum.' });
    const b = await s.save({ kind: 'front', name: 'dedication', text: 'For Dad.' });
    expect(b.id).toBe(a.id);
    expect((await s.list()).map((x) => x.text)).toEqual(['For Dad.']);
    await s.save({ kind: 'back', name: 'Dedication', text: 'a different place, so a different block' });
    expect(await s.list()).toHaveLength(2);
  });

  it('deletes, and refuses an empty block, no name, and a kind that does not exist', async () => {
    const { s } = await store();
    const a = await s.save({ kind: 'back', name: 'X', text: 'x' });
    await s.remove(a.id);
    expect(await s.list()).toEqual([]);
    await expect(s.save({ kind: 'back', name: 'X', text: '  ' })).rejects.toThrow(/no text/);
    await expect(s.save({ kind: 'back', name: ' ', text: 'x' })).rejects.toThrow(/name/);
    await expect(s.save({ kind: 'nowhere', name: 'X', text: 'x' })).rejects.toThrow(/front matter/);
  });

  it('keeps simultaneous saves, and reads a damaged file as empty rather than failing', async () => {
    const { file, s } = await store();
    await Promise.all(['a', 'b', 'c'].map((n) => s.save({ kind: 'back', name: n, text: n })));
    expect(await s.list()).toHaveLength(3);
    expect(JSON.parse(await readFile(file, 'utf8')).blocks).toHaveLength(3);
    expect(sanitizeBlocks('not json')).toEqual([]);
    expect(sanitizeBlocks({ blocks: [{ id: 1 }, { id: 'a', kind: 'back', name: 'ok', text: 't' }, { id: 'a', kind: 'back', name: 'dup', text: 't' }] }).map((b) => b.name)).toEqual(['ok']);
  });
});
