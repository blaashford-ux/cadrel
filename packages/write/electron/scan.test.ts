import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanFolder } from './scan';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mdedit-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const touch = async (rel: string) => {
  const p = path.join(root, rel);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, '# x\n');
};
const names = (n: { children: { name: string }[] }) => n.children.map((c) => c.name);

const writeSidecar = (rel: string, marked: unknown) => writeFile(path.join(root, rel), JSON.stringify({ marked }));

describe('export sidecars in the scan', () => {
  it('flags files whose sidecar says marked, and never lists the sidecar itself', async () => {
    await touch('a.md');
    await touch('b.md');
    await touch('c.md');
    await writeSidecar('a.export.json', true);
    await writeSidecar('b.export.json', false);
    const tree = await scanFolder(root);
    expect(names(tree)).toEqual(['a.md', 'b.md', 'c.md']);
    const byName = Object.fromEntries(tree.children.map((c) => [c.name, c]));
    expect(byName['a.md']).toMatchObject({ marked: true });
    expect(byName['b.md']).toMatchObject({ marked: false });
    expect('marked' in byName['c.md']).toBe(false);
  });

  it('a corrupt sidecar means "not marked", not a crash', async () => {
    await touch('a.md');
    await writeFile(path.join(root, 'a.export.json'), '{oops');
    const a = (await scanFolder(root)).children[0];
    expect(a).toMatchObject({ name: 'a.md', marked: false });
  });

  it('when book.md and book.markdown both exist, .md owns the sidecar and the other is blocked', async () => {
    await touch('book.md');
    await touch('book.markdown');
    await writeSidecar('book.export.json', true);
    const tree = await scanFolder(root);
    const by = Object.fromEntries(tree.children.map((c) => [c.name, c]));
    expect(by['book.md']).toMatchObject({ marked: true });
    expect(by['book.markdown']).toMatchObject({ exportBlocked: true });
    expect('marked' in by['book.markdown']).toBe(false);
  });

  it('reports sidecars with no manuscript as orphans, per folder', async () => {
    await touch('keep.md');
    await writeSidecar('keep.export.json', true);
    await writeSidecar('gone.export.json', true);
    await mkdir(path.join(root, 'sub'));
    await writeFile(path.join(root, 'sub/lost.export.json'), '{}');
    await touch('sub/x.md');
    const tree = await scanFolder(root);
    expect(tree.orphanSidecars).toEqual([path.join(root, 'gone.export.json')]);
    const sub = tree.children.find((c) => c.name === 'sub') as { orphanSidecars?: string[] };
    expect(sub.orphanSidecars).toEqual([path.join(root, 'sub/lost.export.json')]);
  });
});

describe('scanFolder', () => {
  it('lists folders first, then files, naturally sorted, md/markdown only', async () => {
    await touch('b.md');
    await touch('a10.md');
    await touch('a2.MD');
    await touch('notes.txt');
    await touch('z.markdown');
    await touch('sub/inner.md');
    const tree = await scanFolder(root);
    expect(names(tree)).toEqual(['sub', 'a2.MD', 'a10.md', 'b.md', 'z.markdown']);
  });

  it('keeps empty folders and folders without Markdown, but skips hidden and node_modules', async () => {
    await touch('docs/readme.txt');
    await touch('.git/x.md');
    await touch('node_modules/pkg/readme.md');
    await touch('keep/deep/er/file.md');
    await mkdir(path.join(root, 'empty'));
    await mkdir(path.join(root, 'empty-nested/inner'), { recursive: true });
    const tree = await scanFolder(root);
    expect(names(tree)).toEqual(['docs', 'empty', 'empty-nested', 'keep']);
    const find = (n: { children: { name: string }[] }, name: string) => n.children.find((c) => c.name === name) as { children: unknown[] };
    expect(find(tree, 'empty').children).toEqual([]);
    expect(names(find(tree, 'empty-nested') as never)).toEqual(['inner']);
    expect(find(tree, 'docs').children).toEqual([]); // the .txt is not listed
  });

  it('skips symlinks', async () => {
    await touch('real/a.md');
    await symlink(path.join(root, 'real'), path.join(root, 'link'));
    expect(names(await scanFolder(root))).toEqual(['real']);
  });
});
