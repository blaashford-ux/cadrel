import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeFs } from '@cadrel/write/electron/nodeFs';
import { addNotes } from '@cadrel/write/src/shared/agent/tools';
import { createProject, emptyTree, linkRecord } from '@cadrel/kernel';
import { readWriteNotes } from '../src/writeNotes';

describe('reading Write’s notes into the studio list', () => {
  it('maps a Write project’s notes, attaching them to the linked studio project', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cadrel-wn-'));
    const proj = path.join(root, 'Dragon Rider 1');
    await mkdir(path.join(proj, '.mdedit'), { recursive: true });
    await writeFile(path.join(proj, '.mdedit', 'project.json'), JSON.stringify({ status: 'drafting' }));
    await writeFile(path.join(proj, 'book.md'), '# Chapter One\n\nThe dragon flew over the hills and far away.\n');
    const ctx = { fs: nodeFs, root, agent: 'claude', agentName: 'Claude' };
    const res = await addNotes(ctx, 'Dragon Rider 1', undefined, [{ file: 'book.md', kind: 'comment', quote: 'flew over the hills', body: 'Vary the verb.', category: 'style' }]);
    expect(res[0]).toMatchObject({ ok: true });

    const tree = createProject(emptyTree(), { name: 'Book 1' });
    const book = tree.project;
    const linked = linkRecord(tree.tree, book.id, 'write', 'Dragon Rider 1');
    const notes = await readWriteNotes({ fs: nodeFs, root, tree: linked });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ source: 'module', projectId: book.id, kind: 'comment', body: 'Vary the verb.', category: 'style', status: 'open' });
    expect(notes[0]!.target).toMatchObject({ module: 'write', kind: 'file', id: 'Dragon Rider 1/book.md' });
    expect(notes[0]!.target?.anchor?.quote).toBe('flew over the hills');

    const unlinked = await readWriteNotes({ fs: nodeFs, root, tree: emptyTree() });
    expect(unlinked[0]!.projectId).toBeNull();
  });

  it('a missing folder is just no notes', async () => {
    expect(await readWriteNotes({ fs: nodeFs, root: '/definitely/not/here', tree: emptyTree() })).toEqual([]);
  });
});
