import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryFs } from '../memoryFs';
import { makeReviews } from '../backend/reviews';
import { applySuggestion, locateAnchor, newReviewFile, parseReviewFile, serializeReviewFile, type ReviewItem } from '../review/comments';
import { flattenMarkdown } from './flatten';
import { addNotes, AgentError, getNotes, listChapters, listFiles, listProjects, readChapter, replyToNote, reviewerFor, searchText, setChaptersEdited, withdrawNote, type AgentContext } from './tools';

const CH1 = '# One\n\nShe walked *slowly* to the door. She walked to the door again.\n\n"Don\'t," he said.\n';
const CH2 = '# Two\n\nThe **river** ran cold.\n\n- apples\n- pears\n';
const BOOK = CH1 + CH2;

let fs: MemoryFs;
let ctx: AgentContext;
let n: number;

beforeEach(() => {
  fs = new MemoryFs();
  fs.seed('/books/Novel/.mdedit/project.json', '{"status":"editing"}');
  fs.seed('/books/Novel/Manuscript/Book.md', BOOK);
  fs.seed('/books/Novel/Exports/Book.md', BOOK);
  fs.seed('/books/Novel/Notes.md', '# Notes\n\nplain\n');
  fs.seed('/books/Other/readme.txt', 'not a project');
  n = 0;
  ctx = { fs, root: '/books', agent: 'claude', agentName: 'Claude', now: () => new Date('2026-01-01T00:00:00Z'), newId: () => `id${++n}` };
});

const note = (o: Partial<Parameters<typeof addNotes>[3][0]> = {}) => ({ file: 'Manuscript/Book.md', kind: 'comment' as const, quote: 'river', body: 'Cold how?', ...o });

describe('flattenMarkdown', () => {
  it('gives the text the editor shows: marks removed, one block per line', () => {
    expect(flattenMarkdown(CH2)).toBe('Two\nThe river ran cold.\napples\npears');
    expect(flattenMarkdown('A [link](http://x.y) and `code` and \\*escaped\\*.\n\nline one  \nline two')).toBe('A link and code and *escaped*.\nline one￼line two');
  });
});

describe('reading', () => {
  it('lists projects, manuscript files (not exports) and chapters', async () => {
    expect(await listProjects(ctx)).toEqual([{ project: 'Novel', status: 'editing' }]);
    expect((await listFiles(ctx, 'Novel')).map((f) => f.file)).toEqual(['Manuscript/Book.md', 'Notes.md']);
    expect((await listChapters(ctx, 'Novel', 'Manuscript/Book.md')).chapters.map((c) => c.title)).toEqual(['One', 'Two']);
  });

  it('reads a chapter as plain text, by number or title', async () => {
    const a = await readChapter(ctx, 'Novel', 'Manuscript/Book.md', 1);
    expect(a.text).toBe('Two\nThe river ran cold.\napples\npears');
    expect((await readChapter(ctx, 'Novel', 'Manuscript/Book.md', 'one')).index).toBe(0);
    await expect(readChapter(ctx, 'Novel', 'Manuscript/Book.md', 9)).rejects.toThrow(AgentError);
  });

  it('stays inside the project and the Root', async () => {
    for (const bad of ['../Other/readme.txt', '/etc/passwd', 'Manuscript/../Notes.md', '.mdedit/project.json', 'Manuscript/Book.txt', 'Manuscript\\Book.md']) {
      await expect(readChapter(ctx, 'Novel', bad, 0), bad).rejects.toThrow(AgentError);
    }
    await expect(listFiles(ctx, '../books')).rejects.toThrow(AgentError);
    await expect(listFiles(ctx, '.hidden')).rejects.toThrow(AgentError);
  });
});

describe('searching', () => {
  it('finds text across files and chapters in the plain text, with where it was', async () => {
    const r = await searchText(ctx, 'Novel', 'RIVER');
    expect(r.truncated).toBe(false);
    expect(r.hits).toEqual([{ file: 'Manuscript/Book.md', chapter: 1, chapterTitle: 'Two', match: 'river', snippet: 'Two ¶ The river ran cold. ¶ apples ¶ pears' }]);
    expect((await searchText(ctx, 'Novel', 'walked', { caseSensitive: true })).hits.map((h) => h.chapter)).toEqual([0, 0]);
    expect((await searchText(ctx, 'Novel', 'plain', { file: 'Notes.md' })).hits).toHaveLength(1);
  });

  it('takes a regular expression, caps the hits, and says when a query is bad', async () => {
    expect((await searchText(ctx, 'Novel', 'app(le|les)s?\\b', { regex: true })).hits[0].match).toBe('apples');
    const capped = await searchText(ctx, 'Novel', 'e', { limit: 3 });
    expect(capped).toMatchObject({ truncated: true });
    expect(capped.hits).toHaveLength(3);
    await expect(searchText(ctx, 'Novel', '(', { regex: true })).rejects.toThrow(/regular expression/);
    await expect(searchText(ctx, 'Novel', '')).rejects.toThrow(AgentError);
    expect((await searchText(ctx, 'Novel', 'a.b')).hits).toEqual([]); // plain text: the dot is only a dot
    expect((await searchText(ctx, 'Novel', '.*', { regex: true })).hits.length).toBeGreaterThan(0); // empty matches don't loop forever
  });
});

describe('adding notes', () => {
  it('saves a comment the app will find, and never touches the manuscript', async () => {
    const [r] = await addNotes(ctx, 'Novel', 'developmental', [note()]);
    expect(r).toMatchObject({ ok: true, id: 'id1', chapter: 1, chapterTitle: 'Two' });
    expect(await fs.readText('/books/Novel/Manuscript/Book.md')).toBe(BOOK);

    const file = parseReviewFile(await fs.readText('/books/Novel/.mdedit/review/ai-claude-developmental.json'))!;
    expect(file.reviewer).toEqual({ id: 'ai-claude-developmental', name: 'Claude · Developmental edit' });
    const item = file.items[0];
    expect(item).toMatchObject({ kind: 'comment', origin: 'ai', status: 'open', file: 'Manuscript/Book.md', author: 'Claude · Developmental edit' });
    // The app locates it in the chapter's flattened text.
    const flat = flattenMarkdown(CH2);
    expect(locateAnchor(flat, item.anchor)).toEqual({ start: flat.indexOf('river'), end: flat.indexOf('river') + 5 });
  });

  it('makes suggestions that apply, and marks the category', async () => {
    const [r] = await addNotes(ctx, 'Novel', 'line', [note({ kind: 'suggestion', quote: 'walked slowly', replacement: 'crept', body: 'Stronger verb', category: ' Word Choice ' })]);
    expect(r.ok).toBe(true);
    const item = (await getNotes(ctx, 'Novel'))[0];
    expect(item).toMatchObject({ kind: 'suggestion', replacement: 'crept', category: 'word choice' });
    const stored = parseReviewFile(await fs.readText('/books/Novel/.mdedit/review/ai-claude-line.json'))!.items[0];
    expect(applySuggestion(flattenMarkdown(CH1), stored)).toContain('She crept to the door');
  });

  it('refuses a quote that matches more than once, and explains how to fix it', async () => {
    const [r] = await addNotes(ctx, 'Novel', 'copy', [note({ quote: 'to the door' })]);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/2 times.*before.*after/);
    const [ok] = await addNotes(ctx, 'Novel', 'copy', [note({ quote: 'to the door', after: ' again' })]);
    expect(ok.ok).toBe(true);
    expect(locateAnchor(flattenMarkdown(CH1), parseReviewFile(await fs.readText('/books/Novel/.mdedit/review/ai-claude-copy.json'))!.items[0].anchor)!.start).toBe(flattenMarkdown(CH1).lastIndexOf('to the door'));
  });

  it('says so when the quote is missing, and offers the curly-quote match', async () => {
    const [miss] = await addNotes(ctx, 'Novel', 'copy', [note({ quote: 'nowhere in the book' })]);
    expect((miss as { error: string }).error).toMatch(/not found/);
    const [near] = await addNotes(ctx, 'Novel', 'copy', [note({ quote: `"Don't," he said.`, kind: 'comment' })]);
    expect(near.ok).toBe(true); // exact straight quotes are what the file has
    fs.seed('/books/Novel/Curly.md', '# C\n\nShe said “don’t”.\n');
    const [c] = await addNotes(ctx, 'Novel', 'copy', [note({ file: 'Curly.md', quote: 'said "don\'t"' })]);
    expect((c as { error: string }).error).toContain('“don’t”');
  });

  it('keeps suggestions to one paragraph and the limits', async () => {
    const [a] = await addNotes(ctx, 'Novel', 'line', [note({ kind: 'suggestion', quote: 'river', replacement: 'a\nb' })]);
    expect((a as { error: string }).error).toMatch(/one paragraph/);
    const [b] = await addNotes(ctx, 'Novel', 'line', [note({ quote: 'x'.repeat(601) })]);
    expect(b.ok).toBe(false);
    expect(() => addNotes(ctx, 'Novel', 'line', Array.from({ length: 51 }, () => note()))).toThrow(/At most 50/);
  });

  it('saves the good notes in a batch and reports the bad one; repeats are ignored', async () => {
    const res = await addNotes(ctx, 'Novel', 'developmental', [note(), note({ quote: 'missing' }), note({ quote: 'apples', body: 'Why apples?' })]);
    expect(res.map((r) => r.ok)).toEqual([true, false, true]);
    expect((await getNotes(ctx, 'Novel')).length).toBe(2);
    const [again] = await addNotes(ctx, 'Novel', 'developmental', [note()]);
    expect((again as { error: string }).error).toMatch(/already left/);
  });

  it('caps a reviewer at 1000 open notes; closed and deleted notes do not count', async () => {
    await addNotes(ctx, 'Novel', 'line', [note()]);
    const dir = '/books/Novel';
    const [entry] = await makeReviews(fs).list(dir);
    const file = JSON.parse(entry.text);
    const seed = (status: 'open' | 'resolved' | 'deleted', count: number) =>
      Array.from({ length: count }, (_, i) => ({ ...file.items[0], id: `${status}${i}`, status }));
    const save = (items: unknown[]) => makeReviews(fs).save(dir, entry.id, JSON.stringify({ ...file, items }));
    // save() merges with the one open note already on disk, so 998 more make 999
    await save([...seed('resolved', 600), ...seed('deleted', 600), ...seed('open', 998)]);
    const [last] = await addNotes(ctx, 'Novel', 'line', [note({ quote: 'apples' })]);
    expect(last.ok).toBe(true);
    const [over] = await addNotes(ctx, 'Novel', 'line', [note({ quote: 'pears' })]);
    expect(over.ok).toBe(false);
    expect((over as { error: string }).error).toMatch(/1000 open notes/);
  });

  it('signs with just the AI’s name when no skill is used, and adds the skill’s tag when one is', async () => {
    await addNotes(ctx, 'Novel', undefined, [note({ quote: 'river' })]);
    await addNotes(ctx, 'Novel', 'Dialogue Voice', [note({ quote: 'apples' })]);
    await addNotes(ctx, 'Novel', 'line-editing', [note({ quote: 'pears' })]);
    const files = await makeReviews(fs).list('/books/Novel');
    expect(files.map((f) => f.id)).toEqual(['ai-claude-dialogue-voice', 'ai-claude-line', 'ai-claude']);
    expect(files.map((f) => parseReviewFile(f.text)!.reviewer.name)).toEqual(['Claude · Dialogue Voice', 'Claude · Line edit', 'Claude']);
    expect((await getNotes(ctx, 'Novel')).map((x) => x.reviewer).sort()).toEqual(['Claude', 'Claude · Dialogue Voice', 'Claude · Line edit']);
  });

  it('names reviewers from the skill, whatever the spelling', () => {
    const name = (skill?: string) => reviewerFor(ctx, skill);
    expect(name()).toEqual({ id: 'ai-claude', name: 'Claude' });
    expect(name('  ')).toEqual({ id: 'ai-claude', name: 'Claude' });
    for (const s of ['line', 'Line edit', 'line-editing', 'LINE']) expect(name(s)).toEqual({ id: 'ai-claude-line', name: 'Claude · Line edit' });
    expect(name('copy-editing').id).toBe('ai-claude-copy');
    expect(name('developmental edit').name).toBe('Claude · Developmental edit');
    expect(name('Blake’s Craft Check')).toEqual({ id: 'ai-claude-blake-s-craft-check', name: 'Claude · Blake’s Craft Check' });
    expect(name('!!!').id).toBe('ai-claude-skill');
  });

  it('separate skills write separate files', async () => {
    await addNotes(ctx, 'Novel', 'line', [note({ quote: 'apples' })]);
    await addNotes(ctx, 'Novel', 'copy', [note({ quote: 'pears' })]);
    expect((await makeReviews(fs).list('/books/Novel')).map((f) => f.id)).toEqual(['ai-claude-copy', 'ai-claude-line']);
    expect(reviewerFor({ ...ctx, agent: 'GPT-4o!' , agentName: 'GPT' }, 'copy').id).toBe('ai-gpt4o-copy');
  });

  it('does not lose notes when calls overlap', async () => {
    await Promise.all(['river', 'apples', 'pears', 'cold'].map((q) => addNotes(ctx, 'Novel', 'line', [note({ quote: q })])));
    expect((await getNotes(ctx, 'Novel')).length).toBe(4);
  });
});

describe('edited marks', () => {
  const marks = async () => JSON.parse(await fs.readText('/books/Novel/.mdedit/edited.json')).files['Manuscript/Book.md'] as Record<string, { edited: boolean }>;
  const flags = async () => (await listChapters(ctx, 'Novel', 'Manuscript/Book.md')).chapters.map((c) => c.edited);

  it('marks chapters by number or heading and shows them in list_chapters', async () => {
    expect(await flags()).toEqual([false, false]);
    const r = await setChaptersEdited(ctx, 'Novel', 'Manuscript/Book.md', { chapters: [1] }, true);
    expect(r).toMatchObject({ edited: true, changed: [{ index: 1, title: 'Two' }], unchanged: 0 });
    expect(await flags()).toEqual([false, true]);
    expect((await marks()).Two.edited).toBe(true);
    const again = await setChaptersEdited(ctx, 'Novel', 'Manuscript/Book.md', { chapters: ['two', 0] }, true);
    expect(again).toMatchObject({ changed: [{ index: 0, title: 'One' }], unchanged: 1 });
    expect(await flags()).toEqual([true, true]);
  });

  it('through covers the first chapter up to and including the one named, both ways', async () => {
    await setChaptersEdited(ctx, 'Novel', 'Manuscript/Book.md', { through: 1 }, true);
    expect(await flags()).toEqual([true, true]);
    await setChaptersEdited(ctx, 'Novel', 'Manuscript/Book.md', { through: 'One' }, false);
    expect(await flags()).toEqual([false, true]);
  });

  it('keeps the unmark as a note so a sync does not bring the mark back, and leaves the manuscript alone', async () => {
    await setChaptersEdited(ctx, 'Novel', 'Manuscript/Book.md', { chapters: [0] }, true);
    await setChaptersEdited(ctx, 'Novel', 'Manuscript/Book.md', { chapters: [0] }, false);
    expect((await marks()).One.edited).toBe(false);
    expect(await fs.readText('/books/Novel/Manuscript/Book.md')).toBe(BOOK);
  });

  it('asks for exactly one of chapters and through, and rejects chapters that are not there', async () => {
    expect(() => setChaptersEdited(ctx, 'Novel', 'Manuscript/Book.md', {}, true)).toThrow(/either chapters/);
    expect(() => setChaptersEdited(ctx, 'Novel', 'Manuscript/Book.md', { chapters: [0], through: 1 }, true)).toThrow(/either chapters/);
    await expect(setChaptersEdited(ctx, 'Novel', 'Manuscript/Book.md', { chapters: [9] }, true)).rejects.toBeInstanceOf(AgentError);
    await expect(setChaptersEdited(ctx, 'Novel', 'Manuscript/Book.md', { through: 'Nope' }, true)).rejects.toBeInstanceOf(AgentError);
  });
});

describe('sharing a file with the app', () => {
  it('shows existing notes with the chapter, filtered by reviewer and status', async () => {
    const mine: ReviewItem = { id: 'o1', kind: 'comment', file: 'Manuscript/Book.md', anchor: { quote: 'cold', prefix: 'river ran ', suffix: '.', start: 0 }, body: 'Mine', status: 'open', author: 'Me', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z', replies: [] };
    fs.seed('/books/Novel/.mdedit/review/owner.json', serializeReviewFile({ ...newReviewFile('Novel', { id: 'owner', name: 'Me' }), items: [mine] }));
    await addNotes(ctx, 'Novel', 'line', [note({ quote: 'apples' })]);
    const ch = await readChapter(ctx, 'Novel', 'Manuscript/Book.md', 1);
    expect(ch.notes.map((x) => x.id).sort()).toEqual(['id1', 'o1']);
    expect((await readChapter(ctx, 'Novel', 'Manuscript/Book.md', 0)).notes).toEqual([]);
    expect((await getNotes(ctx, 'Novel', { reviewer: 'line edit' })).map((x) => x.id)).toEqual(['id1']);
    expect(await getNotes(ctx, 'Novel', { status: 'resolved' })).toEqual([]);
  });

  it('the app saving its stale copy cannot erase notes the AI added meanwhile', async () => {
    await addNotes(ctx, 'Novel', 'line', [note({ quote: 'apples' })]);
    const path = '/books/Novel/.mdedit/review/ai-claude-line.json';
    const appCopy = parseReviewFile(await fs.readText(path))!; // the app loads the file…
    await addNotes(ctx, 'Novel', 'line', [note({ quote: 'pears', body: 'Pears?' })]); // …the AI adds another…
    const first = appCopy.items[0];
    // …then the owner rejects the first note in the app and it saves its (stale) copy.
    await makeReviews(fs).save('/books/Novel', 'ai-claude-line', serializeReviewFile({ ...appCopy, items: [{ ...first, status: 'rejected', updatedAt: '2026-02-01T00:00:00Z' }] }));
    const items = parseReviewFile(await fs.readText(path))!.items;
    expect(items.map((i) => [i.anchor.quote, i.status])).toEqual([['apples', 'rejected'], ['pears', 'open']]);
  });

  it('replies to anyone’s note, withdraws only its own open ones', async () => {
    const mine: ReviewItem = { id: 'o1', kind: 'comment', file: 'Manuscript/Book.md', anchor: { quote: 'cold', prefix: '', suffix: '', start: 0 }, body: 'Mine', status: 'open', author: 'Me', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z', replies: [] };
    fs.seed('/books/Novel/.mdedit/review/owner.json', serializeReviewFile({ ...newReviewFile('Novel', { id: 'owner', name: 'Me' }), items: [mine] }));
    await replyToNote(ctx, 'Novel', 'developmental', 'o1', 'Good point.');
    const owner = parseReviewFile(await fs.readText('/books/Novel/.mdedit/review/owner.json'))!.items[0];
    expect(owner).toMatchObject({ body: 'Mine', status: 'open' });
    expect(owner.replies.map((r) => [r.author, r.body])).toEqual([['Claude · Developmental edit', 'Good point.']]);

    await expect(withdrawNote(ctx, 'Novel', 'o1')).rejects.toThrow(/Only notes written by an AI/);
    await addNotes(ctx, 'Novel', 'line', [note({ quote: 'apples' })]);
    await withdrawNote(ctx, 'Novel', 'id2'); // id1 was the reply
    expect((await getNotes(ctx, 'Novel')).map((x) => x.id)).toEqual(['o1']);
    await expect(replyToNote(ctx, 'Novel', 'line', 'nope', 'x')).rejects.toThrow(/no note/);
  });
});

describe('projects shared for editing', () => {
  beforeEach(() => {
    fs.seed('/books/Shared With Me/Edit Book/.mdedit/shared.json', '{"packageId":"p1","commentsId":"c1","reviewerId":"rev1abc","project":"Edit Book","role":"edit"}');
    fs.seed('/books/Shared With Me/Edit Book/Manuscript/Book.md', BOOK);
    fs.seed('/books/Shared With Me/Review Book/.mdedit/shared.json', '{"packageId":"p2","commentsId":"c2","reviewerId":"rev2abc","project":"Review Book"}');
    fs.seed('/books/Shared With Me/Review Book/Manuscript/Book.md', BOOK);
  });

  it('are listed and readable, and review-only ones are not', async () => {
    expect((await listProjects(ctx)).map((p) => p.project)).toEqual(['Novel', 'Shared With Me/Edit Book']);
    expect((await listFiles(ctx, 'Shared With Me/Edit Book')).map((f) => f.file)).toEqual(['Manuscript/Book.md']);
    await expect(listFiles(ctx, 'Shared With Me/Review Book')).rejects.toThrow(AgentError);
    await expect(listFiles(ctx, 'Shared With Me/../Novel')).rejects.toThrow(AgentError);
  });

  it('take AI notes into the shared project\'s own review folder', async () => {
    await addNotes(ctx, 'Shared With Me/Edit Book', undefined, [note()]);
    const files = await makeReviews(fs).list('/books/Shared With Me/Edit Book');
    expect(files.map((f) => f.id)).toEqual(['ai-claude']);
  });
});
