// The assistant in a series: Projects and Books, which folder a call means, what it is asked when that is unclear, closed Books, and trackers
// that carry across Books. Through the composed server, as an AI client would use it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { Studio, UserStore } from '@cadrel/studio';
import { MemoryFs } from '@cadrel/write/src/shared/memoryFs';
import { createCadrelServer, studioModule, writeModule } from '../src/index.js';
import { makeProjectResolver } from '../src/scope.js';

let studio: Studio;
let mem: MemoryFs;
let closedIds: Set<string>;
let ids: Record<string, string>;

const seed = (folder: string, files: Record<string, string> = {}) => {
  mem.seed(`/books/${folder}/.cadrel/project.json`, '{}');
  for (const [f, text] of Object.entries(files)) mem.seed(`/books/${folder}/${f}`, text);
};

beforeEach(async () => {
  studio = new Studio(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-books-mcp-')), 'studio.json'));
  mem = new MemoryFs();
  closedIds = new Set();
  ids = {};
  seed('Dragon Bible', { 'Series Bible.md': '# Bible\n\nDragons never speak.\n', 'Characters/Mira.md': '# Mira\n\nA rider.\n', 'Worldbuilding/Dragons.md': '# Dragons\n\nFire.\n' });
  seed('Ember', { 'Manuscript/Book.md': '# One\n\nEmber text.\n' });
  seed('Ash', { 'Manuscript/Book.md': '# One\n\nAsh text.\n', 'Outline.md': '# Outline\n\nAsh beats.\n' });
  seed('Cinder', { 'Manuscript/Book.md': '# One\n\nCinder text.\n' });
  seed('Lost', { 'Manuscript/Book.md': '# One\n\nThe king was lost.\n' });
  seed('Loose', { 'Manuscript/Book.md': '# One\n\nNot in any project.\n' });
  const tree = async () => {
    const mk = async (name: string, kind: string, parentId: string | null, folder: string | null, stage: string | null) => {
      const p = await studio.createProject({ name, kind, parentId, ...(stage ? { workflowId: 'w', stage } : {}) });
      if (folder) await studio.link(p.id, 'write', folder);
      ids[name] = p.id;
      return p.id;
    };
    const dr = await mk('Dragon Rider', 'Series', null, 'Dragon Bible', null);
    await mk('Book 1: Ember', 'Book', dr, 'Ember', 'published');
    await mk('Book 2: Ash', 'Book', dr, 'Ash', 'drafting');
    await mk('Book 3: Cinder', 'Book', dr, 'Cinder', 'planning');
    const lk = await mk('The Lost King', 'Standalone', null, null, null);
    await mk('The Lost King (book)', 'Book', lk, 'Lost', 'revising');
  };
  await tree();
  closedIds.add(ids['Book 1: Ember']!);
});

async function connect() {
  const user = new UserStore(path.join(path.dirname(studio.file), 'user'));
  const closed = async () => closedIds as ReadonlySet<string>;
  const r = makeProjectResolver({ studio, closed });
  const server = createCadrelServer({
    modules: [studioModule({ studio, user, closed, write: { fs: mem, root: '/books' } }), writeModule({ fs: mem, root: '/books', resolve: r.resolve, earlier: r.earlier, access: async () => ({ createFiles: false, editFiles: false, suggestKeywords: false }) })]
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'claude-ai', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text?: string }[] };
    const text = res.content[0]?.text ?? '';
    return { isError: !!res.isError, text, json: () => JSON.parse(text) };
  };
  return { call, client };
}

describe('the tree as the assistant sees it', () => {
  it('studio_projects says what each node is: a Project with no stage, a Book with one, which are closed, and the folder to name', async () => {
    const { call } = await connect();
    const rows = (await call('studio_projects')).json().projects as { name: string; level: string; stage?: string; closed?: boolean; manuscript_folder: string | null }[];
    const by = (n: string) => rows.find((r) => r.name === n)!;
    expect(by('Dragon Rider')).toMatchObject({ level: 'project', manuscript_folder: 'Dragon Bible' });
    expect(by('Dragon Rider')).not.toHaveProperty('stage');
    expect(by('Book 1: Ember')).toMatchObject({ level: 'book', stage: 'published', closed: true, manuscript_folder: 'Ember' });
    expect(by('Book 2: Ash')).toMatchObject({ level: 'book', stage: 'drafting', closed: false });
  });
});

describe('book-level work needs a Book when there are several', () => {
  it('asks which one, naming the open ones (a closed Book is not offered)', async () => {
    const { call } = await connect();
    const r = await call('list_files', { project: 'Dragon Rider' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('2 open books');
    expect(r.text).toContain('Book 2: Ash');
    expect(r.text).toContain('Book 3: Cinder');
    expect(r.text).not.toContain('Book 1: Ember');
  });

  it('finds the Book by a part of its name, or its path, or the plain folder name', async () => {
    const { call } = await connect();
    expect((await call('list_files', { project: 'Dragon Rider', book: 'Book 2' })).json()[0].file).toBe('Manuscript/Book.md');
    expect((await call('read_chapter', { project: 'Dragon Rider', book: 'Ash', file: 'Manuscript/Book.md', chapter: 0 })).text).toContain('Ash text');
    expect((await call('read_chapter', { project: 'Dragon Rider / Book 3', file: 'Manuscript/Book.md', chapter: 0 })).text).toContain('Cinder text');
    expect((await call('read_chapter', { project: 'Ash', file: 'Manuscript/Book.md', chapter: 0 })).text).toContain('Ash text'); // a folder from list_projects still works
  });

  it('says what to do about a name that is not a Book of it, and about a book given with something that is not a Project', async () => {
    const { call } = await connect();
    const none = await call('list_files', { project: 'Dragon Rider', book: 'Book 9' });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/no book "Book 9".*Book 2: Ash/);
    const inside = await call('list_files', { project: 'Dragon Rider / Book 2', book: 'Book 3' });
    expect(inside.isError).toBe(true);
    expect(inside.text).toMatch(/is a book, not a project/);
    const folder = await call('list_files', { project: 'Loose', book: 'Book 2' });
    expect(folder.isError).toBe(true);
    expect(folder.text).toMatch(/no project "Loose"/);
  });

  it('a standalone novel, a Project with one Book, needs no book', async () => {
    const { call } = await connect();
    expect((await call('list_files', { project: 'The Lost King' })).json()[0].file).toBe('Manuscript/Book.md');
  });

  it('when only one Book is left open it is the default', async () => {
    const { call } = await connect();
    closedIds.add(ids['Book 3: Cinder']!);
    expect((await call('read_chapter', { project: 'Dragon Rider', file: 'Manuscript/Book.md', chapter: 0 })).text).toContain('Ash text');
  });

  it('a manuscript that belongs to no project is still reachable by its folder name', async () => {
    const { call } = await connect();
    expect((await call('list_files', { project: 'Loose' })).json()[0].file).toBe('Manuscript/Book.md');
  });
});

describe('where files are saved: the series level or the Book', () => {
  it('series material named for the Project lands in the series folder; a Book’s own lands in its Book', async () => {
    const { call } = await connect();
    expect((await call('list_project_files', { project: 'Dragon Rider' })).json().files.map((f: { file: string }) => f.file)).toContain('Characters/Mira.md');
    const series = await call('write_project_file', { project: 'Dragon Rider', file: 'Characters/Tor.md', content: '# Tor\n\nA smith.\n' });
    expect(series.isError).toBe(false);
    expect(await mem.readText('/books/Dragon Bible/Characters/Tor.md')).toContain('A smith');
    const book = await call('write_project_file', { project: 'Dragon Rider', book: 'Book 3', file: 'Outline.md', content: '# Outline\n\nCinder beats.\n' });
    expect(book.isError).toBe(false);
    expect(await mem.readText('/books/Cinder/Outline.md')).toContain('Cinder beats');
    expect(await mem.stat('/books/Dragon Bible/Outline.md')).toBeNull(); // the series did not get the Book's outline
  });

  it('a Book’s character sheet can be its own (book given) while the series keeps its own (no book)', async () => {
    const { call } = await connect();
    await call('write_project_file', { project: 'Dragon Rider', book: 'Book 2', file: 'Characters/Ash Rider.md', content: '# Ash Rider\n' });
    expect(await mem.stat('/books/Ash/Characters/Ash Rider.md')).not.toBeNull();
    expect(await mem.stat('/books/Dragon Bible/Characters/Ash Rider.md')).toBeNull();
  });
});

describe('closed Books are read-only', () => {
  it('can be read, and nothing can be added to them, in notes, files or trackers', async () => {
    const { call } = await connect();
    expect((await call('read_chapter', { project: 'Dragon Rider', book: 'Book 1', file: 'Manuscript/Book.md', chapter: 0 })).text).toContain('Ember text');
    const note = await call('add_notes', { project: 'Dragon Rider', book: 'Book 1', notes: [{ file: 'Manuscript/Book.md', kind: 'comment', quote: 'Ember text', body: 'x' }] });
    expect(note.isError).toBe(true);
    expect(note.text).toMatch(/Book 1: Ember is closed.*read-only/);
    expect((await call('write_project_file', { project: 'Dragon Rider', book: 'Book 1', file: 'Notes.md', content: 'x' })).isError).toBe(true);
    expect((await call('litrpg_log', { project: 'Dragon Rider', book: 'Book 1', characters: [{ name: 'Sean', events: [{ type: 'level_up', chapter: 1, details: { resulting_level: 2 } }] }] })).isError).toBe(true);
    expect(await mem.stat('/books/Ember/Notes.md')).toBeNull();
  });

  it('reopened, it can be changed again', async () => {
    const { call } = await connect();
    closedIds.delete(ids['Book 1: Ember']!);
    expect((await call('write_project_file', { project: 'Dragon Rider', book: 'Book 1', file: 'Notes.md', content: 'x' })).isError).toBe(false);
  });
});

describe('studio_context', () => {
  it('gives a Book whole: the series files to read first, the Book’s own, the other Books, and where new work goes', async () => {
    const { call } = await connect();
    const c = (await call('studio_context', { project: 'Dragon Rider', book: 'Book 2' })).json();
    expect(c.project).toMatchObject({ name: 'Dragon Rider', folder: 'Dragon Bible' });
    expect(c.read_first).toEqual(expect.arrayContaining(['Series Bible.md', 'Characters/Mira.md', 'Worldbuilding/Dragons.md']));
    expect(c.book).toMatchObject({ name: 'Book 2: Ash', stage: 'drafting', closed: false, folder: 'Ash' });
    expect(c.book.files.map((f: { file: string }) => f.file)).toContain('Outline.md');
    expect(c.books.map((b: { name: string; this_one: boolean }) => [b.name, b.this_one])).toEqual([['Book 1: Ember', false], ['Book 2: Ash', true], ['Book 3: Cinder', false]]);
    expect(c.where_things_go.series_level).toContain('Dragon Bible');
    expect(c.where_things_go.book_level).toContain('Ash');
  });

  it('with several open Books and none named, says to ask which', async () => {
    const { call } = await connect();
    const c = (await call('studio_context', { project: 'Dragon Rider' })).json();
    expect(c.book).toBeNull();
    expect(c.choose_a_book).toMatch(/2 open books.*Ask which/);
    expect(c.project.folder).toBe('Dragon Bible'); // the series level is still there to read
  });

  it('knows a Book given by its path, and says when it is closed', async () => {
    const { call } = await connect();
    const c = (await call('studio_context', { project: 'Dragon Rider / Book 1' })).json();
    expect(c.book).toMatchObject({ name: 'Book 1: Ember', closed: true });
    expect(c.note).toMatch(/closed.*cannot|read it but not change/);
  });

  it('a standalone novel’s one Book is the default', async () => {
    const { call } = await connect();
    const c = (await call('studio_context', { project: 'The Lost King' })).json();
    expect(c.book).toMatchObject({ folder: 'Lost' });
  });

  it('refuses a project that is not there', async () => {
    const { call } = await connect();
    expect((await call('studio_context', { project: 'Nope' })).isError).toBe(true);
  });
});

describe('the LitRPG tracker across Books', () => {
  it('a Book starts where the one before left the character, without the earlier Book’s ledger being copied', async () => {
    const { call } = await connect();
    closedIds.delete(ids['Book 1: Ember']!); // log while it is still open
    await call('litrpg_log', { project: 'Dragon Rider', book: 'Book 1', characters: [{ name: 'Sean', events: [{ type: 'level_up', chapter: 5, details: { resulting_level: 7 } }] }] });
    closedIds.add(ids['Book 1: Ember']!); // then it is closed: its ledger is still there to carry forward
    await call('litrpg_log', { project: 'Dragon Rider', book: 'Book 2', characters: [{ name: 'Sean', events: [{ type: 'xp_award', chapter: 2, details: { amount: 50, running_total: null, xp_to_next_level: null } }] }] });
    const st = (await call('litrpg_state', { project: 'Dragon Rider', book: 'Book 2', character: 'Sean', as_of_chapter: 1 })).json();
    expect(st.characters[0].state.level).toBe(7); // Book 1's ending, before Book 2's chapter 2
    // One ledger file for the series, in the series' own folder; each Book's ledger is inside under its id and nothing was copied between them.
    const file = JSON.parse(await mem.readText('/books/Dragon Bible/Tracking/LitRPG Ledger.json'));
    expect(file.series_ledger).toBe(1);
    expect(Object.keys(file.books).sort()).toEqual([ids['Book 1: Ember']!, ids['Book 2: Ash']!].sort());
    expect(file.books[ids['Book 2: Ash']!].ledger.characters.Sean.event_log).toHaveLength(1);
    expect(file.books[ids['Book 1: Ember']!].ledger.characters.Sean.event_log).toHaveLength(1);
    await expect(mem.readText('/books/Ash/Tracking/LitRPG Ledger.json')).rejects.toThrow(); // none per Book
    const first = (await call('litrpg_state', { project: 'Dragon Rider', book: 'Book 1', character: 'Sean' })).json();
    expect(first.characters[0].state.level).toBe(7); // Book 1 carries nothing in
  });
});

describe('one ledger file per series', () => {
  const lvl = (chapter: number, level: number) => ({ type: 'level_up', chapter, details: { resulting_level: level } });
  const sean = (events: unknown[]) => [{ name: 'Sean', events }];

  it('adopts a Book’s own ledger from before the series file existed, and keeps reading the earlier Book’s', async () => {
    const { call } = await connect();
    // Book 1 kept its own file in its own folder, the way ledgers were kept before; Book 2 starts a series file.
    mem.seed('/books/Ember/Tracking/LitRPG Ledger.json', JSON.stringify({ meta: { project: 'Ember', last_updated_chapter: 9, schema_version: '1.0' }, characters: { Sean: { current_state: {}, event_log: [{ id: 'e1', type: 'level_up', chapter: 9, details: { resulting_level: 12 } }] } }, consistency_flags: [] }));
    await call('litrpg_log', { project: 'Dragon Rider', book: 'Book 2', characters: sean([lvl(1, 13)]) });
    const st = (await call('litrpg_state', { project: 'Dragon Rider', book: 'Book 2', character: 'Sean', as_of_chapter: 0 })).json();
    expect(st.characters[0].state.level).toBe(12); // carried from the old per-Book file
    // Book 1 is read as before, and logging to it (after reopening) moves it into the series file.
    closedIds.clear();
    await call('litrpg_log', { project: 'Dragon Rider', book: 'Book 1', characters: sean([lvl(10, 13)]) });
    const file = JSON.parse(await mem.readText('/books/Dragon Bible/Tracking/LitRPG Ledger.json'));
    expect(file.books[ids['Book 1: Ember']!].ledger.characters.Sean.event_log.map((e: { chapter: number }) => e.chapter)).toEqual([9, 10]);
  });

  it('carries the timeline: a Book that starts before the last one ended is caught, and the days join', async () => {
    const { call } = await connect();
    closedIds.clear();
    await call('timeline_log', { project: 'Dragon Rider', book: 'Book 1', days: [{ day: 1, chapters: [{ chapter: 1 }], locations: ['Hold'] }, { day: 30, chapters: [{ chapter: 9 }], weekday: 'Tuesday' }] });
    const r = (await call('timeline_log', { project: 'Dragon Rider', book: 'Book 2', days: [{ day: 10, chapters: [{ chapter: 1 }] }, { day: 31, chapters: [{ chapter: 2 }], weekday: 'Wednesday' }] })).json();
    expect(r.new_flags.some((f: { type: string }) => f.type === 'overlapping_days')).toBe(true); // Book 2 opens on day 10, Book 1 reached day 30
    expect(r.new_flags.some((f: { type: string }) => f.type === 'day_of_week_contradiction')).toBe(false); // 30 Tue → 31 Wed agrees across the Books
    const file = JSON.parse(await mem.readText('/books/Dragon Bible/Tracking/Timeline Ledger.json'));
    expect(Object.keys(file.books)).toHaveLength(2);
    expect(Object.keys(file.books[ids['Book 2: Ash']!].ledger.days).sort()).toEqual(['10', '31']); // not copied in
    const view = (await call('build_tracker_view', { project: 'Dragon Rider', book: 'Book 2', view: 'timeline', return_html: true })).json();
    expect(view.html).toContain('"key":"30"'); // drawn with the earlier Book's days in front
  });

  it('a series with no folder of its own keeps one file per Book, as before', async () => {
    const { call } = await connect();
    await studio.unlink('write', 'Dragon Bible'); // the series has no folder now
    closedIds.clear();
    await call('litrpg_log', { project: 'Dragon Rider', book: 'Book 2', characters: sean([lvl(1, 2)]) });
    expect(JSON.parse(await mem.readText('/books/Ash/Tracking/LitRPG Ledger.json')).series_ledger).toBeUndefined();
  });

  it('refuses to overwrite an ordinary single-book ledger sitting in the series folder', async () => {
    const { call } = await connect();
    closedIds.clear();
    mem.seed('/books/Dragon Bible/Tracking/LitRPG Ledger.json', '{"meta":{"project":"x","last_updated_chapter":0,"schema_version":"1.0"},"characters":{},"consistency_flags":[]}');
    const r = await call('litrpg_log', { project: 'Dragon Rider', book: 'Book 2', characters: sean([lvl(1, 2)]) });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not the series ledger/);
  });
});
