import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryFs } from '@cadrel/write/src/shared/memoryFs';
import { Editorial, EditingError } from '../src/main/editorial';
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
