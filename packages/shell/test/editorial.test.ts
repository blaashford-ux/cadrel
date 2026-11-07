import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryFs } from '@cadrel/write/src/shared/memoryFs';
import { Editorial, EditingError, collapseRows, type EditorialFiles } from '../src/main/editorial';
import { compareTexts } from '@cadrel/kernel';
import { ProjectManager, type WriteFolders } from '../src/main/manage';
import { PeopleHost } from '../src/main/people';
import { ProjectStages } from '../src/main/stages';
import { StudioService } from '../src/main/studio';

let dir: string, host: PeopleHost, studio: StudioService, mgr: ProjectManager, page: Editorial, projectId: string, fileId: string;
const write: WriteFolders = {
  projectsRoot: () => '/w',
  templates: () => [{ id: 'novel', name: 'Novel', description: '' }],
  listFolders: async () => ({ projects: [], others: [] }),
  createProject: async (n) => ({ path: `/w/${n}` }),
  renameProject: async (p) => p,
  duplicateProject: async (_p, n) => ({ path: `/w/${n}` }),
  deleteProject: async () => undefined,
  readProject: async () => null,
  updateProject: async () => undefined,
  convertFolder: async () => undefined,
  addMissingTemplateParts: async () => [],
  openProject: () => undefined
};
const me = () => host.service!.as(host.me);
const db = () => (host as unknown as { db: { run(sql: string, p?: unknown[]): Promise<unknown> } }).db;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cadrel-editorial-'));
  host = new PeopleHost();
  await host.open({ file: path.join(dir, 'records.db'), studioId: 'local', owned: true, ownerName: 'Ana Reyes' });
  studio = new StudioService({ file: path.join(dir, 'studio.json'), author: () => 'Ana', writeRoot: async () => null, fs: new MemoryFs() });
  mgr = new ProjectManager(studio, write, new ProjectStages(studio, () => host.workflows, () => host.work));
  projectId = (await mgr.create({ name: 'Lead Me', template: null })).id;
  fileId = 'f1';
  await db().run("INSERT INTO vault_file (id, studio_id, path, current_version) VALUES ('f1', 'local', 'Lead Me/book.md', 1)");
  await db().run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES ('f1', 1, 'h', 1, 'x', '2026-11-01T00:00:00.000Z')");
  page = new Editorial(studio, host);
});
afterEach(async () => {
  await host.close();
  await rm(dir, { recursive: true, force: true });
});

const plan = async (kind: 'line' | 'copy' = 'line') => me().passes.create({ projectId, kind, fileId, editorId: host.me });
const anchor = (q: string) => ({ quote: q, prefix: '', suffix: '', start: 0 });

describe('the Editing page: what waits on whom', () => {
  it('has nothing to show before any pass, and says what each pass needs next from this person', async () => {
    const empty = await page.state();
    expect(empty).toMatchObject({ available: true, passes: [], offline: null });
    const p = await plan();
    let st = (await page.state()) as Extract<Awaited<ReturnType<Editorial['state']>>, { available: true }>;
    expect(st.passes).toHaveLength(1);
    expect(st.passes[0]).toMatchObject({ id: p.id, projectName: 'Lead Me', editorName: 'Ana Reyes', filePath: 'Lead Me/book.md', fileVersion: 1, next: 'start' });
    await me().passes.start(p.id);
    st = (await page.state()) as typeof st;
    expect(st.passes[0]!.next).toBe('deliver');
    const [q, s] = await me().queries.raise(p.id, [{ kind: 'query', body: 'Why?' }, { kind: 'suggestion', anchor: anchor('a'), replacement: 'b' }]);
    await me().passes.deliver(p.id);
    st = (await page.state()) as typeof st;
    expect(st.passes[0]).toMatchObject({ next: 'answer', undecided: 1, unanswered: 1, counts: { open: 2, answered: 0, resolved: 0, withdrawn: 0 } });
    await me().queries.answer(q!.id, 'Because.');
    st = (await page.state()) as typeof st;
    expect(st.passes[0]).toMatchObject({ next: 'answer', unanswered: 0, undecided: 1 }); // the suggestion still needs a decision
    await me().queries.decide(s!.id, { outcome: 'accept' });
    st = (await page.state()) as typeof st;
    expect(st.passes[0]).toMatchObject({ next: 'respond', undecided: 0 });
    await me().passes.respond(p.id);
    st = (await page.state()) as typeof st;
    expect(st.passes[0]!.next).toBe('close');
    await me().passes.close(p.id);
    st = (await page.state()) as typeof st;
    expect(st.passes[0]).toMatchObject({ state: 'closed', next: null });
  });

  it('puts what waits on this person first, then what is under way, then what is done; cancelled passes are left out', async () => {
    const done = await plan('line');
    for (const f of ['start', 'deliver', 'respond', 'close'] as const) await me().passes[f](done.id);
    const under = await plan('copy');
    await me().passes.start(under.id);
    await me().passes.deliver(under.id);
    await me().passes.respond(under.id);
    await db().run("INSERT INTO vault_file (id, studio_id, path, current_version) VALUES ('f2', 'local', 'two.md', 1)");
    await db().run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES ('f2', 1, 'h2', 1, 'x', '2026-11-01T00:00:00.000Z')");
    const called = await me().passes.create({ projectId, kind: 'line', fileId: 'f2', editorId: host.me });
    await me().passes.cancel(called.id);
    const st = (await page.state()) as Extract<Awaited<ReturnType<Editorial['state']>>, { available: true }>;
    expect(st.passes.map((p) => [p.kind, p.state, p.next])).toEqual([['copy', 'responded', 'close'], ['line', 'closed', null]]);
  });

  it('says what this person may do, and says plainly when the role cannot see passes at all', async () => {
    const st = (await page.state()) as Extract<Awaited<ReturnType<Editorial['state']>>, { available: true }>;
    expect(st.may).toEqual({ run: true, assign: true, respond: true, approve: true }); // the Owner
    const closed = new Editorial(studio, new PeopleHost());
    expect(await closed.state()).toMatchObject({ available: false });
    expect(await closed.pass('x')).toMatchObject({ available: false });
  });
});

describe('one pass', () => {
  it('lists the items with the decision on each and what the check of the revision found', async () => {
    const p = await plan(); // covers version 1
    await db().run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES ('f1', 2, 'h2', 1, 'x', '2026-11-05T00:00:00.000Z')");
    await db().run("UPDATE vault_file SET current_version = 2 WHERE id = 'f1'");
    await me().passes.start(p.id);
    const [q, s] = await me().queries.raise(p.id, [{ kind: 'query', body: 'Why?' }, { kind: 'suggestion', anchor: { quote: 'walked slowly', prefix: '', suffix: '', start: 4 }, replacement: 'crept' }]);
    await me().passes.deliver(p.id);
    await me().queries.answer(q!.id, 'Because.');
    await me().queries.decide(s!.id, { outcome: 'accept' });
    await me().passes.respond(p.id);
    await me().queries.verify(p.id, { revisedVersion: 2, revisedText: 'She crept home.' });
    const r = await page.pass(p.id);
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.pass).toMatchObject({ id: p.id, projectName: 'Lead Me', next: 'close' });
    expect(r.items.map((i) => [i.seq, i.kind, i.state])).toEqual([[1, 'query', 'answered'], [2, 'suggestion', 'open']]);
    expect(r.items[0]).toMatchObject({ response: 'Because.', decision: null, verified: null });
    expect(r.items[1]).toMatchObject({ decision: { outcome: 'accept' }, verified: { result: 'made', revisedVersion: 2 } });
    expect(r.people.map((x) => x.name)).toContain('Ana Reyes');
    expect(r.may.respond).toBe(true);
  });

  it('is "not there" for an id nobody has', async () => {
    expect(await page.pass('nope')).toMatchObject({ available: false });
  });
});

describe('changes from the page', () => {
  it('goes through the service: the author’s answer and decision, the editor’s moves', async () => {
    const p = await plan();
    await page.call('start', [p.id]);
    const [q, s] = await me().queries.raise(p.id, [{ kind: 'query', body: 'Why?' }, { kind: 'suggestion', anchor: anchor('a'), replacement: 'b' }]);
    await page.call('deliver', [p.id]);
    await page.call('answer', [q!.id, 'Because.']);
    await page.call('decide', [s!.id, { outcome: 'defer', reason: 'Later.', revisit: '2026-12-01' }]);
    await page.call('resolve', [q!.id]);
    await page.call('respond', [p.id]);
    await page.call('close', [p.id]);
    const r = await page.pass(p.id);
    if (!r.available) throw new Error('not available');
    expect(r.pass.state).toBe('closed');
    expect(r.items.map((i) => i.state)).toEqual(['resolved', 'open']);
    expect(r.items[1]!.decision).toMatchObject({ outcome: 'defer', revisit: '2026-12-01' });
  });

  it('withdraws an open item and cancels a pass', async () => {
    const p = await plan();
    await page.call('start', [p.id]);
    const [q] = await me().queries.raise(p.id, [{ kind: 'comment', body: 'FYI' }]);
    await page.call('withdraw', [q!.id]);
    await page.call('cancel', [p.id]);
    expect((await page.state()) as never).toMatchObject({ passes: [] });
  });

  it('shows the service’s own refusal, and only does what it has a name for', async () => {
    const p = await plan();
    await expect(page.call('deliver', [p.id])).rejects.toThrow(/can go to: in progress, cancelled/); // not started
    await expect(page.call('answer', ['nope', 'x'])).rejects.toThrow(/not there/);
    await expect(page.call('constructor', [p.id])).rejects.toBeInstanceOf(EditingError);
    await expect(page.call('toString', [p.id])).rejects.toBeInstanceOf(EditingError);
    await expect(page.call('start', [])).rejects.toBeInstanceOf(EditingError);
  });
});

describe('the assistant is told where the vault keeps its files', () => {
  it('passes the records, the person, the Studio and, when known, the blobs folder', () => {
    expect(host.mcpArgs('records.db')).toEqual(['--records', 'records.db', '--person', host.me, '--studio-id', 'local']);
    expect(host.mcpArgs('records.db', '/blobs')).toEqual(['--records', 'records.db', '--person', host.me, '--studio-id', 'local', '--vault-blobs', '/blobs']);
  });
});

// ---- planning, reading, raising, comparing, checking and briefs ---------------------------------------------------------------

const V1 = 'The river ran cold.\n\nShe walked slowly to the river and stopped.\n\nIt was loud.';
const V2 = 'The river ran cold.\n\nShe crept to the river and stopped.\n\nIt was loud.';
const fakeFiles = (): EditorialFiles => ({
  manuscripts: async () => [{ fileId: 'f1', path: 'Lead Me/book.md', version: 2 }],
  textOf: async (id, n) => {
    const t = id === 'f1' ? { 1: V1, 2: V2 }[n as 1 | 2] : undefined;
    if (t === undefined) throw new Error('There is no such version.');
    return t;
  },
  versionsOf: async () => [
    { n: 2, hash: 'h2', size: 1, author: 'Ana', comment: 'revised', createdAt: '2026-11-09T10:00:00.000Z' },
    { n: 1, hash: 'h1', size: 1, author: 'Ana', comment: 'first', createdAt: '2026-11-01T10:00:00.000Z' }
  ]
});
const fpage = () => new Editorial(studio, host, fakeFiles());
const ready = async () => (await fpage().state()) as Extract<Awaited<ReturnType<Editorial['state']>>, { available: true }>;
const addV2 = async () => {
  await db().run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES ('f1', 2, 'h2', 1, 'x', '2026-11-09T00:00:00.000Z')");
  await db().run("UPDATE vault_file SET current_version = 2 WHERE id = 'f1'");
};

describe('collapsing a comparison', () => {
  const rowsOf = (a: string, b: string) => compareTexts(a, b).rows;
  const para = (n: number) => Array.from({ length: n }, (_, i) => `Paragraph ${i + 1}.`);
  it('keeps one paragraph of context either side of a change and counts the rest', () => {
    const before = para(20).join('\n\n');
    const after = para(20).map((p, i) => (i === 10 ? p + ' Changed.' : p)).join('\n\n');
    const rows = collapseRows(rowsOf(before, after));
    expect(rows.map((r) => (r.kind === 'skip' ? `skip ${r.count}` : r.kind))).toEqual(['skip 9', 'same', 'changed', 'same', 'skip 8']);
  });
  it('says when nothing changed, and skips nothing when everything did', () => {
    expect(collapseRows(rowsOf(para(3).join('\n\n'), para(3).join('\n\n')))).toEqual([{ kind: 'skip', count: 3 }]); // nothing changed: one row that says so
    expect(collapseRows(rowsOf('Just one.', 'Just one.')).map((r) => r.kind)).toEqual(['same']); // a single paragraph is shown
    expect(collapseRows(rowsOf('Alpha one.\n\nBeta two.', 'Gamma three.\n\nDelta four.')).some((r) => r.kind === 'skip')).toBe(false);
    expect(collapseRows([])).toEqual([]);
  });
});

describe('planning a pass', () => {
  it('offers the projects the person may plan in, the manuscripts, and, once a project is chosen, its editors and edit briefs', async () => {
    const none = await fpage().planning();
    expect(none).toMatchObject({ available: true, projects: [{ id: projectId, name: 'Lead Me' }], files: [{ fileId: 'f1', path: 'Lead Me/book.md', version: 2 }], editors: [], briefs: [] });
    await me().briefs.create({ projectId, kind: 'edit', title: 'Line edit brief', body: 'Cut filter words.' });
    await me().briefs.create({ projectId, kind: 'manuscript', title: 'Manuscript brief', body: 'A thriller.' });
    const chosen = (await fpage().planning(projectId)) as Extract<Awaited<ReturnType<Editorial['planning']>>, { available: true }>;
    expect(chosen.editors.map((e) => e.name)).toEqual(['Ana Reyes']);
    expect(chosen.briefs).toEqual([{ id: expect.any(String), title: 'Line edit brief', version: 1 }]); // only edit briefs
    expect(((await fpage().planning('not-a-project')) as { editors: unknown[] }).editors).toEqual([]);
  });

  it('says why when there is no vault here or the person may plan nowhere', async () => {
    expect(await page.planning()).toMatchObject({ available: false, reason: expect.stringMatching(/kept by its owner/) });
    expect(await new Editorial(studio, new PeopleHost(), fakeFiles()).planning()).toMatchObject({ available: false });
  });

  it('plans a pass over a manuscript, pinned to the version asked for (the newest by default), with a brief', async () => {
    await addV2();
    const brief = await me().briefs.create({ projectId, kind: 'edit', title: 'B', body: 'b' });
    const a = await fpage().plan({ projectId, kind: 'copy', fileId, editorId: host.me, briefId: brief.id });
    const b = await fpage().plan({ projectId, kind: 'line', fileId, editorId: host.me, fileVersion: 1, title: 'First look' });
    const st = await ready();
    const rowA = st.passes.find((p) => p.id === a.id)!;
    const rowB = st.passes.find((p) => p.id === b.id)!;
    expect(rowA).toMatchObject({ kind: 'copy', fileVersion: 2, briefId: brief.id, briefVersion: 1, state: 'planned', next: 'start' });
    expect(rowB).toMatchObject({ title: 'First look', fileVersion: 1 });
  });

  it('passes the service’s refusal on: a second live pass of a kind, a made-up file, a wrong editor', async () => {
    await fpage().plan({ projectId, kind: 'line', fileId, editorId: host.me });
    await expect(fpage().plan({ projectId, kind: 'line', fileId, editorId: host.me })).rejects.toThrow(/already has a line pass/);
    await expect(fpage().plan({ projectId, kind: 'copy', fileId: 'nope', editorId: host.me })).rejects.toThrow(/file is not there/);
    await expect(fpage().plan({ projectId, kind: 'copy', fileId, editorId: 'nobody' })).rejects.toThrow(/editor is not there/);
    await expect(fpage().plan(null as never)).rejects.toBeInstanceOf(EditingError);
  });
});

describe('reading the text and raising items from a selection', () => {
  let passId: string;
  beforeEach(async () => {
    passId = (await me().passes.create({ projectId, kind: 'line', fileId, editorId: host.me })).id;
  });

  it('gives the text of the version the pass covers, even after a newer one exists', async () => {
    await addV2();
    expect(await fpage().text(passId)).toEqual({ file: 'Lead Me/book.md', version: 1, text: V1 });
    await expect(page.text(passId)).rejects.toThrow(/kept by its owner/); // no vault
    await expect(fpage().text('nope')).rejects.toThrow(/not there/);
  });

  it('anchors each item exactly where the selection was, and a point about the whole pass has no anchor', async () => {
    await me().passes.start(passId);
    const start = V1.indexOf('walked slowly');
    await fpage().raise(passId, [
      { kind: 'suggestion', start, end: start + 'walked slowly'.length, replacement: 'crept', category: 'verbs' },
      { kind: 'query', start: 4, end: 9, body: 'River of what?' },
      { kind: 'comment', body: 'Lovely pacing overall.' }
    ]);
    const items = await me().queries.list({ passId });
    expect(items.map((i) => [i.seq, i.kind, i.anchor?.quote, i.anchor?.start])).toEqual([[1, 'suggestion', 'walked slowly', start], [2, 'query', 'river', 4], [3, 'comment', undefined, undefined]]);
    expect(items[0]).toMatchObject({ replacement: 'crept', category: 'verbs' });
    expect(items[0]!.anchor!.prefix).toContain('She ');
  });

  it('refuses a selection that is not a passage, and raises nothing if any one is wrong', async () => {
    await me().passes.start(passId);
    const bad = (i: object) => fpage().raise(passId, [{ kind: 'comment', body: 'x' }, i as never]);
    await expect(bad({ kind: 'comment', body: 'x', start: 5, end: 5 })).rejects.toThrow(/Select a passage.*item 2/);
    await expect(bad({ kind: 'comment', body: 'x', start: -1, end: 4 })).rejects.toThrow(/Select a passage/);
    await expect(bad({ kind: 'comment', body: 'x', start: 0, end: 9999 })).rejects.toThrow(/Select a passage/);
    await expect(bad({ kind: 'comment', body: 'x', start: 1.5, end: 4 })).rejects.toThrow(/Select a passage/);
    await expect(bad({ kind: 'comment', body: 'x', start: 19, end: 21 })).rejects.toThrow(/only spaces/); // the line break between paragraphs
    await expect(fpage().raise(passId, [])).rejects.toThrow(/nothing to raise/);
    await expect(fpage().raise(passId, [{ kind: 'suggestion', body: 'x' }])).rejects.toThrow(/needs the passage/); // the service's rule
    expect(await me().queries.list({ passId })).toEqual([]);
  });

  it('leaves the rule that a pass must be in progress to the service', async () => {
    await expect(fpage().raise(passId, [{ kind: 'comment', body: 'early' }])).rejects.toThrow(/in progress/);
  });
});

describe('later versions, comparing and checking the revision', () => {
  let passId: string, sugId: string;
  beforeEach(async () => {
    passId = (await me().passes.create({ projectId, kind: 'line', fileId, editorId: host.me })).id;
    await me().passes.start(passId);
    const start = V1.indexOf('walked slowly');
    await fpage().raise(passId, [{ kind: 'suggestion', start, end: start + 13, replacement: 'crept' }]);
    sugId = (await me().queries.list({ passId }))[0]!.id;
    await addV2();
  });

  it('lists only versions after the one the pass covers', async () => {
    expect((await fpage().laterVersions(passId)).map((v) => [v.n, v.comment])).toEqual([[2, 'revised']]);
  });

  it('compares the covered version with a later one, showing the reworded paragraph as one change', async () => {
    const c = await fpage().compare(passId, 2);
    expect(c).toMatchObject({ from: 1, to: 2, stats: { changed: 1, same: 2, added: 0, removed: 0 } });
    const changed = c.rows.find((r) => r.kind === 'changed') as { words: { op: string; text: string }[] };
    expect(changed.words.filter((w) => w.op !== 'same').map((w) => [w.op, w.text])).toEqual([['del', 'walked slowly'], ['ins', 'crept']]);
    await expect(fpage().compare(passId, 1)).rejects.toThrow(/after version 1/);
    await expect(fpage().compare(passId, 2.5)).rejects.toThrow(/after version 1/);
    await expect(fpage().compare(passId, 9)).rejects.toThrow(/no such version/);
  });

  it('checks what the author accepted against the later version and shows the result on the item', async () => {
    await me().passes.deliver(passId);
    await me().queries.decide(sugId, { outcome: 'accept' });
    await me().passes.respond(passId);
    await fpage().verify(passId, 2);
    const r = await fpage().pass(passId);
    if (!r.available) throw new Error('not available');
    expect(r.items[0]!.verified).toMatchObject({ result: 'made', revisedVersion: 2 });
    await expect(fpage().verify(passId, 1)).rejects.toThrow(/after the one the pass covers/);
    await expect(fpage().verify(passId, 'x' as never)).rejects.toBeInstanceOf(EditingError);
  });

  it('says that a revision is checked only after the author has responded', async () => {
    await expect(fpage().verify(passId, 2)).rejects.toThrow(/once the author has responded/);
  });
});

describe('briefs on a book', () => {
  it('lists, makes and revises a book’s briefs, keeping every version', async () => {
    expect(await page.briefs(projectId)).toMatchObject({ available: true, may: { manuscript: true, edit: true }, briefs: [], people: [{ name: 'Ana Reyes' }] });
    const m = await page.createBrief({ projectId, kind: 'manuscript', title: 'The book', body: 'A slow-burn thriller.' });
    const e = await page.createBrief({ projectId, kind: 'edit', title: 'Line edit', body: 'Cut filter words.' });
    const list = (await page.briefs(projectId)) as { briefs: { id: string; kind: string; current: { n: number } }[] };
    expect(list.briefs.map((b) => [b.kind, b.current.n])).toEqual([['manuscript', 1], ['edit', 1]]);
    const r = await page.reviseBrief(e.id, { body: 'Cut filter words and adverbs.', note: 'added adverbs', basedOn: 1 });
    expect(r.current).toMatchObject({ n: 2, note: 'added adverbs' });
    expect((await page.briefVersions(e.id)).map((v) => v.n)).toEqual([1, 2]);
    await expect(page.reviseBrief(e.id, { body: 'Stale.', basedOn: 1 })).rejects.toThrow(/revised this brief since/);
    expect(m.kind).toBe('manuscript');
  });

  it('says plainly when the project is not there or the role cannot see briefs', async () => {
    await expect(page.briefs('no-such-project')).rejects.toThrow(/no such project/);
    expect(await new Editorial(studio, new PeopleHost()).briefs(projectId)).toMatchObject({ available: false });
  });
});
