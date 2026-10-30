import { describe, expect, it } from 'vitest';
import { MemoryFs } from '../memoryFs';
import { editProjectFile, listProjectFiles, readProjectFile, writeProjectFile, fileKind } from './projectFiles';
import { AgentError, type AgentContext } from './tools';

const setup = () => {
  const fs = new MemoryFs();
  fs.seed('/books/Novel/.cadrel/project.json', '{"status":"drafting"}');
  fs.seed('/books/Novel/Manuscript/Book.md', '# One\n\nText.\n');
  fs.seed('/books/Novel/Characters/Mira.md', '# Mira\n');
  const ctx: AgentContext = { fs, root: '/books', agent: 'claude', agentName: 'Claude', now: () => new Date('2026-10-30T10:00:00Z') };
  return { fs, ctx };
};
const fails = async (p: Promise<unknown>, re: RegExp) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(AgentError);
  expect((e as Error).message).toMatch(re);
};

describe('project files', () => {
  it('guesses what each file is from where it sits', () => {
    expect(fileKind('Manuscript/Book.md')).toBe('manuscript');
    expect(fileKind('Characters/Mira.md')).toBe('character');
    expect(fileKind('Worldbuilding/Locations/Keep.md')).toBe('world');
    expect(fileKind('Premise.md')).toBe('premise');
    expect(fileKind('Outline - Book 1.md')).toBe('outline');
    expect(fileKind('Series Bible/Series Bible.md')).toBe('bible');
    expect(fileKind('Marketing/Blurb.md')).toBe('copy');
    expect(fileKind('Tracking/LitRPG Ledger.json')).toBe('tracker');
    expect(fileKind('Tracking/Timeline.html')).toBe('view');
  });

  it('lists text files with kinds, skipping hidden folders', async () => {
    const { ctx } = setup();
    const r = await listProjectFiles(ctx, 'Novel');
    expect(r.files.map((f) => [f.file, f.kind])).toEqual([['Characters/Mira.md', 'character'], ['Manuscript/Book.md', 'manuscript']]);
    expect((await listProjectFiles(ctx, 'Novel', 'Characters')).files).toHaveLength(1);
  });

  it('creates a file and its folders, but never overwrites unless told to', async () => {
    const { fs, ctx } = setup();
    const w = await writeProjectFile(ctx, 'Novel', 'Worldbuilding/Setting.md', '# Setting\n');
    expect(w).toMatchObject({ file: 'Worldbuilding/Setting.md', kind: 'world', created: true });
    expect(await fs.readText('/books/Novel/Worldbuilding/Setting.md')).toBe('# Setting\n');
    await fails(writeProjectFile(ctx, 'Novel', 'Worldbuilding/Setting.md', 'x'), /already exists/);
    await writeProjectFile(ctx, 'Novel', 'Worldbuilding/Setting.md', '# Setting v2\n', 'replace');
    expect(await fs.readText('/books/Novel/Worldbuilding/Setting.md')).toBe('# Setting v2\n');
    const kept = (await fs.readdir('/books/Novel/.cadrel/previous')).map((e) => e.name);
    expect(kept).toHaveLength(1);
    expect(await fs.readText(`/books/Novel/.cadrel/previous/${kept[0]}`)).toBe('# Setting\n');
  });

  it('saves a long document in parts', async () => {
    const { fs, ctx } = setup();
    await writeProjectFile(ctx, 'Novel', 'Outline.md', '# Outline\n\n## Act I');
    await writeProjectFile(ctx, 'Novel', 'Outline.md', '## Act II\n', 'append');
    expect(await fs.readText('/books/Novel/Outline.md')).toBe('# Outline\n\n## Act I\n## Act II\n');
  });

  it('keeps only the newest few previous versions', async () => {
    const { fs, ctx } = setup();
    let n = 0;
    ctx.now = () => new Date(Date.UTC(2026, 9, 30, 10, 0, n++));
    await writeProjectFile(ctx, 'Novel', 'Notes.md', 'v0');
    for (let i = 1; i <= 8; i++) await writeProjectFile(ctx, 'Novel', 'Notes.md', `v${i}`, 'replace');
    expect((await fs.readdir('/books/Novel/.cadrel/previous')).length).toBe(5);
  });

  it('never writes into the manuscript or exports, or outside the project', async () => {
    const { ctx } = setup();
    await fails(writeProjectFile(ctx, 'Novel', 'Manuscript/Chapter 2.md', 'x'), /manuscript or exports/);
    await fails(writeProjectFile(ctx, 'Novel', 'manuscripts/x.md', 'x'), /manuscript or exports/);
    await fails(writeProjectFile(ctx, 'Novel', 'Exports/x.md', 'x'), /manuscript or exports/);
    await fails(writeProjectFile(ctx, 'Novel', '../Other/x.md', 'x'), /not a path/);
    await fails(writeProjectFile(ctx, 'Novel', '.cadrel/project.json', '{}'), /not a path/);
    await fails(writeProjectFile(ctx, 'Novel', 'run.exe', 'x'), /not a path/);
    await fails(writeProjectFile(ctx, '../x', 'a.md', 'x'), /not a project name/);
  });

  it('reuses a folder or file that differs only in case', async () => {
    const { fs, ctx } = setup();
    const w = await writeProjectFile(ctx, 'Novel', 'characters/Juna.md', '# Juna\n');
    expect(w.file).toBe('Characters/Juna.md');
    await fails(writeProjectFile(ctx, 'Novel', 'characters/mira.md', 'x'), /already exists/);
    expect(await fs.readText('/books/Novel/Characters/Juna.md')).toBe('# Juna\n');
  });

  it('refuses invalid JSON and over-long content', async () => {
    const { ctx } = setup();
    await fails(writeProjectFile(ctx, 'Novel', 'Tracking/x.json', '{nope'), /not valid JSON/);
    await fails(writeProjectFile(ctx, 'Novel', 'Big.md', 'x'.repeat(400001)), /too long/);
    await fails(writeProjectFile(ctx, 'Novel', 'a.json', '{}', 'append'), /can’t be appended/);
  });

  it('reads in parts, from where the last part ended', async () => {
    const { ctx } = setup();
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    await writeProjectFile(ctx, 'Novel', 'Long.md', text);
    const a = await readProjectFile(ctx, 'Novel', 'Long.md', { maxChars: 200 });
    expect(a.truncated).toBe(true);
    const b = await readProjectFile(ctx, 'Novel', 'Long.md', { start: a.nextStart, maxChars: 100000 });
    expect(a.text + b.text).toBe(text);
    expect(b.truncated).toBe(false);
    await fails(readProjectFile(ctx, 'Novel', 'Missing.md'), /does not exist/);
  });

  it('edits one exact piece of text, keeping the old version', async () => {
    const { fs, ctx } = setup();
    await writeProjectFile(ctx, 'Novel', 'Outline.md', '# Outline\n\nChapter 1: A\nChapter 2: A\n');
    await fails(editProjectFile(ctx, 'Novel', 'Outline.md', 'A', 'B'), /appears 2 times/);
    await fails(editProjectFile(ctx, 'Novel', 'Outline.md', 'Z', 'B'), /not found/);
    await editProjectFile(ctx, 'Novel', 'Outline.md', 'Chapter 1: A', 'Chapter 1: B');
    expect(await fs.readText('/books/Novel/Outline.md')).toBe('# Outline\n\nChapter 1: B\nChapter 2: A\n');
    expect((await fs.readdir('/books/Novel/.cadrel/previous')).length).toBe(1);
    await fails(editProjectFile(ctx, 'Novel', 'Manuscript/Book.md', 'Text', 'Other'), /manuscript or exports/);
  });
});
