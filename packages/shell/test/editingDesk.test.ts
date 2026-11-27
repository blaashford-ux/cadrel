import { strToU8, zipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryFs } from '@cadrel/write/src/shared/memoryFs';
import { addNotes } from '@cadrel/write/src/shared/agent/tools';
import { importTracked } from '@cadrel/write/src/shared/trackedChanges';
import { EditingDesk, isManuscript, reportPathOf } from '../src/main/editingDesk';

const CH1 = '# One\n\nShe walked slowly to the door. The river ran cold.\n\n"Don\'t," he said.\n';
const CH2 = '# Two\n\nMorning came.\n';
const BOOK = CH1 + CH2;
const P = '/books/Novel';

let fs: MemoryFs;
let name: string;
let desk: EditingDesk;
let n: number;
beforeEach(() => {
  fs = new MemoryFs();
  fs.seed(`${P}/.cadrel/project.json`, '{"status":"editing"}');
  fs.seed(`${P}/Manuscript/Book.md`, BOOK);
  fs.seed(`${P}/Manuscript/Book - Analysis.md`, '# Analysis\n');
  fs.seed(`${P}/Characters/Ann.md`, '# Ann\n\nA person.\n');
  fs.seed(`${P}/Notes.md`, '# Notes\n');
  fs.seed('/books/Other/.cadrel/project.json', '{}');
  fs.seed('/books/Other/Manuscript/Other.md', '# Other\n\nText.\n');
  name = 'Sam Editor';
  n = 0;
  desk = new EditingDesk({ fs, root: '/books', editor: () => name, now: () => new Date('2026-03-05T12:00:00Z'), newId: () => `id${++n}` });
});

const docxWith = (body: string, comments = '') =>
  zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'word/document.xml': strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`),
    ...(comments ? { 'word/comments.xml': strToU8(`<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${comments}</w:comments>`) } : {})
  });

describe('choosing a manuscript', () => {
  it('lists only manuscripts: not analyses, characters or notes', async () => {
    const all = await desk.manuscripts();
    expect(all.map((m) => `${m.project}:${m.file}`).sort()).toEqual(['Novel:Manuscript/Book.md', 'Other:Manuscript/Other.md']);
    expect(isManuscript('Manuscript/Book - Analysis.md')).toBe(false);
    expect(isManuscript('Manuscripts/Part 2.md')).toBe(true);
    expect(isManuscript('Manuscript/Book - Editing Report.md')).toBe(false);
    expect(isManuscript('Characters/Ann.md')).toBe(false);
  });

  it('offers a project’s set manuscripts, and only those, once it has set any; until then the Manuscript folder is', async () => {
    fs.seed(`${P}/Drafts/Alt Ending.md`, '# Alt\n\nAnother.\n');
    const set: Record<string, string[]> = { Novel: ['Drafts/Alt Ending.md', 'Manuscript/Book.md'], Other: [] };
    const designed = new EditingDesk({ fs, root: '/books', editor: () => name, designated: async (p) => set[p] ?? [] });
    expect((await designed.manuscripts()).map((m) => `${m.project}:${m.file}`).sort()).toEqual(['Novel:Drafts/Alt Ending.md', 'Novel:Manuscript/Book.md', 'Other:Manuscript/Other.md']); // Other has set none: its Manuscript folder
    set.Novel = ['Drafts/Alt Ending.md'];
    expect((await designed.manuscripts(['Novel'])).map((m) => m.file)).toEqual(['Drafts/Alt Ending.md']);
    set.Novel = ['Characters/Ann.md', 'Notes.md'];
    expect((await designed.manuscripts(['Novel'])).map((m) => m.file).sort()).toEqual(['Characters/Ann.md', 'Notes.md']); // the person's own choice, not a guess
    const broken = new EditingDesk({ fs, root: '/books', editor: () => name, designated: async () => { throw new Error('no'); } });
    expect((await broken.manuscripts(['Novel'])).map((m) => m.file)).toEqual(['Manuscript/Book.md']); // unreadable: as before
  });

  it('is filtered by the project’s folders', async () => {
    expect((await desk.manuscripts(['novel'])).map((m) => m.project)).toEqual(['Novel']);
    expect(await desk.manuscripts([])).toEqual([]);
  });

  it('refuses to open a file that is not a manuscript', async () => {
    await expect(desk.read('Novel', 'Characters/Ann.md')).rejects.toThrow(/Only a manuscript/);
    await expect(desk.addNotes('Novel', 'Notes.md', [{ kind: 'comment', quote: 'Notes', body: 'x' }])).rejects.toThrow(/Only a manuscript/);
  });
});

describe('notes work as they do in Write and through MCP', () => {
  it('a person’s note and an AI’s note (add_notes) sit together, each signed and tagged', async () => {
    const mine = await desk.addNotes('Novel', 'Manuscript/Book.md', [{ kind: 'comment', quote: 'river ran cold', body: 'Cold how?', editType: 'line', round: 'First read', category: 'Imagery' }]);
    expect(mine).toEqual({ added: 1, errors: [] });
    await addNotes({ fs, root: '/books', agent: 'claude', agentName: 'Claude', newId: () => `ai${++n}` }, 'Novel', 'developmental', [{ file: 'Manuscript/Book.md', kind: 'comment', quote: 'Morning came', body: 'Abrupt.' }], 'First read');
    const t = await desk.read('Novel', 'Manuscript/Book.md');
    expect(t.chapters.map((c) => c.title)).toEqual(['One', 'Two']);
    expect(t.notes.map((x) => [x.author, x.origin, x.editType, x.round, x.chapter, x.state])).toEqual([
      ['Sam Editor', 'human', 'line', 'First read', 0, 'same'],
      ['Claude · Developmental edit', 'ai', 'developmental', 'First read', 1, 'same']
    ]);
    expect(t.notes[0]!.category).toBe('imagery');
    expect(t.rounds).toEqual(['First read']);
    const c = t.chapters[0]!;
    expect(c.text.slice(t.notes[0]!.start, t.notes[0]!.end)).toBe('river ran cold');
  });

  it('reports a quote that is not in the text, as add_notes does, and still saves the good ones', async () => {
    const r = await desk.addNotes('Novel', 'Manuscript/Book.md', [{ kind: 'comment', quote: 'no such words', body: 'x' }, { kind: 'comment', quote: 'Morning', body: 'y' }]);
    expect(r.added).toBe(1);
    expect(r.errors[0]).toMatch(/not found|not in the text/i);
  });

  it('decides, tags, replies and removes', async () => {
    await desk.addNotes('Novel', 'Manuscript/Book.md', [{ kind: 'suggestion', quote: 'walked slowly', replacement: 'crept', body: 'Verb' }]);
    const id = (await desk.read('Novel', 'Manuscript/Book.md')).notes[0]!.id;
    await desk.setStatus('Novel', id, 'accepted');
    await desk.tag('Novel', id, { editType: 'Copy edit', round: ' Round 2 ' });
    await desk.reply('Novel', id, 'Thanks');
    let note = (await desk.read('Novel', 'Manuscript/Book.md')).notes[0]!;
    expect(note).toMatchObject({ status: 'accepted', editType: 'copy', round: 'Round 2', replacement: 'crept' });
    expect(note.replies.map((r) => [r.author, r.body])).toEqual([['Sam Editor', 'Thanks']]);
    expect((await fs.readText(`${P}/Manuscript/Book.md`))).toBe(BOOK); // the editor never changes the author's text
    await desk.tag('Novel', id, { editType: null });
    expect((await desk.read('Novel', 'Manuscript/Book.md')).notes[0]!.editType).toBeUndefined();
    await desk.remove('Novel', id);
    expect((await desk.read('Novel', 'Manuscript/Book.md')).notes).toEqual([]);
  });

  it('will not remove an AI’s note or another person’s', async () => {
    await addNotes({ fs, root: '/books', agent: 'claude', agentName: 'Claude', now: () => new Date('2026-03-05T11:00:00Z') }, 'Novel', undefined, [{ file: 'Manuscript/Book.md', kind: 'comment', quote: 'Morning', body: 'x' }]);
    const id = (await desk.read('Novel', 'Manuscript/Book.md')).notes[0]!.id;
    await expect(desk.remove('Novel', id)).rejects.toThrow(/only your own/i);
    await desk.setStatus('Novel', id, 'rejected'); // but it can be decided
    expect((await desk.read('Novel', 'Manuscript/Book.md')).notes[0]!.status).toBe('rejected');
  });

  it('shows a note whose text moved, and one whose text was cut', async () => {
    await desk.addNotes('Novel', 'Manuscript/Book.md', [{ kind: 'comment', quote: 'river ran cold', body: 'a' }, { kind: 'comment', quote: 'Morning came', body: 'b' }]);
    fs.seed(`${P}/Manuscript/Book.md`, '# One\n\nA new opening line was added.\n\nShe walked slowly to the door. The river ran cold.\n\n"Don\'t," he said.\n# Two\n\nEvening fell.\n');
    const t = await desk.read('Novel', 'Manuscript/Book.md');
    const by = (q: string) => t.notes.find((x) => x.quote === q)!;
    expect(by('river ran cold').state).toBe('moved');
    expect(by('Morning came')).toMatchObject({ state: 'gone', chapter: -1 });
  });
});

describe('uploading a document edited elsewhere', () => {
  it('puts the document in the Manuscript folder and its tracked changes and comments in as notes from their authors', async () => {
    const run = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
    const body = `<w:p>${run('She ')}<w:del w:id="1" w:author="Pat" w:date="2026-03-01T10:00:00Z"><w:r><w:delText>walked slowly</w:delText></w:r></w:del><w:ins w:id="2" w:author="Pat" w:date="2026-03-01T10:00:00Z">${run('crept')}</w:ins>${run(' to the door.')}</w:p><w:p>${run('The ')}<w:commentRangeStart w:id="5"/>${run('river')}<w:commentRangeEnd w:id="5"/>${run(' ran cold.')}</w:p>`;
    const comments = '<w:comment w:id="5" w:author="Lee" w:date="2026-03-02T09:00:00Z"><w:p><w:r><w:t>Cold how?</w:t></w:r></w:p></w:comment>';
    const bytes = docxWith(`<w:p>${run('Chapter One')}</w:p>`.replace('<w:p>', '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>') + body, comments);
    expect(importTracked(bytes).found).toBe(2);
    const kept: string[] = [];
    desk = new EditingDesk({ fs, root: '/books', editor: () => name, keep: async (abs) => void kept.push(abs) });
    const r = await desk.importDocx('Novel', bytes, 'Draft 2.docx');
    expect(r).toMatchObject({ file: 'Manuscript/Draft 2.md', found: 2, added: 2, notPlaced: [] });
    expect((await fs.readText(`${P}/Manuscript/Draft 2.md`))).toContain('She walked slowly to the door.');
    expect(kept).toEqual([`${P}/Editing/Originals/Draft 2.docx`]);
    const t = await desk.read('Novel', 'Manuscript/Draft 2.md');
    expect(t.notes.map((x) => [x.author, x.origin, x.kind, x.quote, x.replacement ?? null, x.round])).toEqual([
      ['Pat', 'outside', 'suggestion', 'walked slowly', 'crept', 'Word import'],
      ['Lee', 'outside', 'comment', 'river', null, 'Word import']
    ]);
    expect((await desk.manuscripts(['Novel'])).map((m) => m.file)).toContain('Manuscript/Draft 2.md');
  });

  it('numbers the name when it is taken, and refuses what is not a Word document', async () => {
    const bytes = docxWith('<w:p><w:r><w:t>Hello there.</w:t></w:r></w:p>');
    await desk.importDocx('Novel', bytes, 'Book.docx');
    const again = await desk.importDocx('Novel', bytes, 'Book.docx');
    expect(again.file).toBe('Manuscript/Book (3).md'); // Book.md was already there, so the first upload took (2)
    await expect(desk.importDocx('Novel', strToU8('nope'), 'x.docx')).rejects.toThrow(/not a valid .docx/);
    await expect(desk.importDocx('Novel', docxWith('<w:p/>'), 'empty.docx')).rejects.toThrow(/no text/);
  });
});

describe('the Word export', () => {
  it('writes the open notes as comments and tracked changes that read back', async () => {
    await desk.addNotes('Novel', 'Manuscript/Book.md', [{ kind: 'suggestion', quote: 'walked slowly', replacement: 'crept', body: 'Verb' }, { kind: 'comment', quote: 'Morning', body: 'Abrupt' }, { kind: 'comment', quote: 'river', body: 'closed' }]);
    const closed = (await desk.read('Novel', 'Manuscript/Book.md')).notes.find((x) => x.quote === 'river')!;
    await desk.setStatus('Novel', closed.id, 'resolved');
    const out = await desk.exportDocx('Novel', 'Manuscript/Book.md');
    expect(out.name).toBe('Book - with notes.docx');
    expect(out.placed).toBe(2); // the resolved one is not sent
    const back = importTracked(out.bytes);
    expect(back.notes.map((x) => [x.kind, x.quote, x.replacement ?? null])).toEqual([['suggestion', 'walked slowly', 'crept'], ['comment', 'Morning', null]]);
  });
});

describe('the Editing Report', () => {
  beforeEach(async () => {
    await desk.addNotes('Novel', 'Manuscript/Book.md', [
      { kind: 'comment', quote: 'river ran cold', body: 'Cold how?', category: 'imagery', editType: 'developmental', round: 'First read' },
      { kind: 'suggestion', quote: 'walked slowly', replacement: 'crept', editType: 'line', round: 'First read' }
    ]);
  });

  it('is worked out from the notes each time it is read, so it follows the activity', async () => {
    let r = await desk.report('Novel', 'Manuscript/Book.md');
    expect(r.saved).toBe(false);
    expect(r.stats).toMatchObject({ total: 2, byKind: { comment: 1, suggestion: 1 } });
    expect(r.autoSummary).toMatch(/2 notes on Book.*2 are still open/);
    const id = (await desk.read('Novel', 'Manuscript/Book.md')).notes.find((x) => x.kind === 'suggestion')!.id;
    await desk.setStatus('Novel', id, 'accepted');
    r = await desk.report('Novel', 'Manuscript/Book.md');
    expect(r.stats.byStatus).toMatchObject({ open: 1, accepted: 1 });
    expect(r.autoSummary).toMatch(/1 are still open/);
  });

  it('keeps what the editor types, and the summary goes back to automatic when emptied', async () => {
    const r = await desk.saveReport('Novel', 'Manuscript/Book.md', { summary: 'A strong draft.', round: 'First read', editor: 'Sam', sections: [{ id: '', title: 'Priorities', body: '- Fix pacing in chapter two' }] });
    expect(r.saved).toBe(true);
    expect(r.data).toMatchObject({ summary: 'A strong draft.', round: 'First read', editor: 'Sam', sections: [{ id: 's1', title: 'Priorities' }] });
    const file = await fs.readText(`${P}/${reportPathOf('Manuscript/Book.md')}`);
    expect(file).toContain('## Summary\n\nA strong draft.');
    expect(file).toContain('- Fix pacing in chapter two');
    expect((await desk.report('Novel', 'Manuscript/Book.md')).data.sections).toHaveLength(1); // read back from the file
    const cleared = await desk.saveReport('Novel', 'Manuscript/Book.md', { summary: '   ' });
    expect(cleared.data.summary).toBeUndefined();
    expect(cleared.data.sections).toHaveLength(1); // the sections stay
    await expect(desk.saveReport('Novel', 'Manuscript/Book.md', { sections: Array.from({ length: 31 }, (_, k) => ({ id: `s${k}`, title: 't', body: 'b' })) })).rejects.toThrow(/up to 30/);
  });

  it('counts only the round it is for', async () => {
    await desk.addNotes('Novel', 'Manuscript/Book.md', [{ kind: 'comment', quote: 'Morning came', body: 'later', round: 'Second read' }]);
    expect((await desk.saveReport('Novel', 'Manuscript/Book.md', { round: 'Second read' })).stats.total).toBe(1);
    expect((await desk.saveReport('Novel', 'Manuscript/Book.md', { round: '' })).stats.total).toBe(3);
  });

  it('attaches the text analysis, keeps it in the report, and takes it off again', async () => {
    const r = await desk.attachAnalysis('Novel', 'Manuscript/Book.md');
    expect(r.data.analysis).toMatchObject({ generated: '2026-03-05' });
    expect(r.data.analysis!.words).toBeGreaterThan(5);
    expect(await fs.readText(`${P}/${reportPathOf('Manuscript/Book.md')}`)).toContain('## Text analysis (2026-03-05)');
    expect((await desk.saveReport('Novel', 'Manuscript/Book.md', { summary: 'kept' })).data.analysis).toBeDefined(); // other edits do not drop it
    expect((await desk.saveReport('Novel', 'Manuscript/Book.md', { removeAnalysis: true })).data.analysis).toBeUndefined();
  });

  it('makes the page that is printed to PDF, and saves the report as it goes out', async () => {
    await desk.saveReport('Novel', 'Manuscript/Book.md', { summary: 'Tidy <b>draft</b>.' });
    const page = await desk.reportPage('Novel', 'Manuscript/Book.md');
    expect(page.name).toBe('Book - Editing Report.pdf');
    expect(page.html).toContain('Tidy &lt;b&gt;draft&lt;/b&gt;.');
    expect(page.html).toContain('By edit type');
  });
});
