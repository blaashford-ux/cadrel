import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DraftStore } from './drafts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mdedit-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const draft = (file: string, md = 'text', at = 1) => ({ file, chapter: 2, title: 'Two', markdown: md, updatedAt: at });

describe('DraftStore', () => {
  it('lists nothing when the folder does not exist yet', async () => {
    expect(await new DraftStore(path.join(dir, 'nope')).list()).toEqual([]);
  });

  it('saves, overwrites per file, lists oldest first, and clears', async () => {
    const s = new DraftStore(path.join(dir, 'drafts'));
    await s.save(draft('/a.md', 'v1', 5));
    await s.save(draft('/b.md', 'b', 1));
    await s.save(draft('/a.md', 'v2', 9));
    expect((await s.list()).map((d) => [d.file, d.markdown])).toEqual([['/b.md', 'b'], ['/a.md', 'v2']]);
    await s.clear('/a.md');
    expect((await s.list()).map((d) => d.file)).toEqual(['/b.md']);
    await s.clear('/never-saved.md'); // no throw
  });

  it('ignores corrupt or foreign files', async () => {
    const d = path.join(dir, 'drafts');
    const s = new DraftStore(d);
    await s.save(draft('/a.md'));
    await writeFile(path.join(d, 'junk.json'), '{nope');
    await writeFile(path.join(d, 'wrong.json'), JSON.stringify({ file: 1 }));
    await writeFile(path.join(d, 'note.txt'), 'x');
    expect((await s.list()).map((x) => x.file)).toEqual(['/a.md']);
  });
});
