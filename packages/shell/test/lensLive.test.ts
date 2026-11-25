// The working views against real records: the Owner's own Studio, with a pass taken from planned to delivered and a deadline that has passed.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryFs } from '@cadrel/write/src/shared/memoryFs';
import { Editorial } from '../src/main/editorial';
import { loadLens } from '../src/main/lens';
import { ProjectManager, type WriteFolders } from '../src/main/manage';
import { PeopleHost } from '../src/main/people';
import { ProjectWork } from '../src/main/projectWork';
import { ProjectStages } from '../src/main/stages';
import { StudioService } from '../src/main/studio';

let dir: string, host: PeopleHost, studio: StudioService, stages: ProjectStages, projectId: string;
const write: WriteFolders = {
  projectsRoot: () => '/w', templates: () => [{ id: 'novel', name: 'Novel', description: '' }], listFolders: async () => ({ projects: [], others: [] }),
  createProject: async (n) => ({ path: `/w/${n}` }), renameProject: async (p) => p, duplicateProject: async (_p, n) => ({ path: `/w/${n}` }), deleteProject: async () => undefined,
  readProject: async () => null, updateProject: async () => undefined, convertFolder: async () => undefined, addMissingTemplateParts: async () => [], openProject: () => undefined
};
const me = () => host.service!.as(host.me);
const db = () => (host as unknown as { db: { run(sql: string, p?: unknown[]): Promise<unknown> } }).db;
const today = () => new Date().toISOString().slice(0, 10);
const lens = () => loadLens({ mayAnywhere: (c) => host.mayOn(c), editing: () => new Editorial(studio, host).state(), plan: () => new ProjectWork(studio, host, stages).plan() }, host.me, today());

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cadrel-lens-'));
  host = new PeopleHost();
  await host.open({ file: path.join(dir, 'records.db'), studioId: 'local', owned: true, ownerName: 'Ana Reyes' });
  studio = new StudioService({ file: path.join(dir, 'studio.json'), author: () => 'Ana', writeRoot: async () => null, fs: new MemoryFs() });
  stages = new ProjectStages(studio, () => host.workflows, () => host.work);
  projectId = (await new ProjectManager(studio, write, stages).create({ name: 'Lead Me', template: null })).id;
  await db().run("INSERT INTO vault_file (id, studio_id, path, current_version) VALUES ('f1', 'local', 'Lead Me/book.md', 1)");
  await db().run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES ('f1', 1, 'h', 1, 'x', '2026-11-01T00:00:00.000Z')");
});
afterEach(async () => {
  await host.close();
  await rm(dir, { recursive: true, force: true });
});

describe('the working views on real records', () => {
  it('gives the Owner the Director’s view first, then the Editor’s, the Author’s and the Art view', async () => {
    const s = await lens();
    expect(s).toMatchObject({ available: true, lenses: ['director', 'editor', 'author', 'art', 'launch'] });
  });

  it('follows a pass from planned to delivered: the Editor’s lists, then the queries waiting on the author, for the Director and the Author', async () => {
    const p = await me().passes.create({ projectId, kind: 'line', fileId: 'f1', editorId: host.me });
    let s = await lens();
    expect(s.available && s.views.editor!.toStart.map((x) => x.passId)).toEqual([p.id]);
    await me().passes.start(p.id);
    s = await lens();
    expect(s.available && s.views.editor!.toDeliver.map((x) => x.passId)).toEqual([p.id]);
    await me().queries.raise(p.id, [{ kind: 'query', body: 'Why?' }, { kind: 'query', body: 'And why not?' }]);
    await me().passes.deliver(p.id);
    s = await lens();
    if (!s.available) throw new Error('lens unavailable');
    expect(s.views.editor!.withAuthor.map((x) => x.passId)).toEqual([p.id]);
    expect(s.views.director!.unanswered).toEqual([{ projectId, name: 'Lead Me', queries: 2, passes: 1, oldestDays: 0 }]);
    expect(s.views.director!.totals.unansweredQueries).toBe(2);
    expect(s.views.author!.answer.map((x) => [x.passId, x.unanswered])).toEqual([[p.id, 2]]);
    // answered: nothing waits on an author, and the Director’s list is empty
    for (const q of await me().queries.list({ passId: p.id })) await me().queries.answer(q.id, 'Because.');
    s = await lens();
    expect(s.available && s.views.director!.unanswered).toEqual([]);
    expect(s.available && s.views.author!.answer).toEqual([]);
    expect(s.available && s.views.author!.respond.map((x) => x.passId)).toEqual([p.id]);
  });

  it('lists a book as late once an open deadline of it has passed, and not when it is done or still ahead', async () => {
    await host.work!.createTask({ projectId, title: 'Manuscript to the editor', kind: 'deadline', due: '2026-01-10' });
    const done = await host.work!.createTask({ projectId, title: 'Cover final', kind: 'deadline', due: '2026-01-05' });
    await host.work!.setState(done.id, 'done');
    await host.work!.createTask({ projectId, title: 'Launch', kind: 'deadline', due: '2999-01-01' });
    const s = await lens();
    if (!s.available) throw new Error('lens unavailable');
    expect(s.views.director!.lateBooks).toHaveLength(1);
    expect(s.views.director!.lateBooks[0]).toMatchObject({ projectId, name: 'Lead Me' });
    expect(s.views.director!.lateBooks[0]!.deadlines.map((d) => d.title)).toEqual(['Manuscript to the editor']);
  });
});
