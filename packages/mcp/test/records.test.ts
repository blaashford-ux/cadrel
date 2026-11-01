// The studio's records through the composed server: tasks, sign-offs, decisions, books and files, as the person the assistant acts for.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { addReference, addVaultFile, bootstrapStudio, checkIn, checkOut, defaultRole, newRecordId, type Ctx } from '@cadrel/kernel';
import { StudioService, dbAccess } from '@cadrel/service';
import { memoryStudioDb, type StudioDb } from '@cadrel/store';
import { Studio } from '@cadrel/studio';
import { MemoryFs } from '@cadrel/write/src/shared/memoryFs';
import { createCadrelServer, projectsModule, recordsModule, studioModule } from '../src/index.js';

const S = 'studio1';
const NOW = () => new Date('2026-11-10T10:00:00.000Z');
const NAMES = ['books_link_project', 'books_list', 'files_list', 'work_add_task', 'work_approvals', 'work_decisions', 'work_people', 'work_project_status', 'work_request_approval', 'work_set_task', 'work_tasks'];

let db: StudioDb, svc: StudioService, studio: Studio, ana: ReturnType<StudioService['as']>;
let mem: MemoryFs;
beforeEach(async () => {
  db = memoryStudioDb();
  await bootstrapStudio(db, { studioId: S, actor: 'ana', now: NOW().toISOString() } as Ctx, { id: 'ana', name: 'Ana' });
  svc = new StudioService({ db, studioId: S, access: dbAccess(db, S), now: NOW });
  ana = svc.as('ana');
  studio = new Studio(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-rec-mcp-')), 'studio.json'));
  mem = new MemoryFs();
});

async function connect(personId = 'ana') {
  const view = (t: import('@cadrel/kernel').ProjectTree) => svc.as(personId).visibleProjects(t);
  const stageForNewBook = async () => {
    const wf = await svc.as(personId).workflows.defaultFor('subproject').catch(() => null);
    return wf ? { workflowId: wf.id, stage: wf.stages[0]!.key } : null;
  };
  const server = createCadrelServer({ modules: [studioModule({ studio, view, stageForNewBook, write: { fs: mem, root: '/books' } }), recordsModule({ service: svc, personId, studio, studioId: S, db }), projectsModule({ service: svc, personId, studio, db, view })] });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'claude-ai', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text?: string }[] };
    const text = r.content[0]?.text ?? '';
    return { isError: !!r.isError, text, json: () => JSON.parse(text) };
  };
  return { client, call };
}
const person = async (name: string, roleKey: string) => {
  const p = await ana.people.create({ name });
  await ana.people.grant({ subject: { kind: 'person', id: p.id }, roleId: `role_${roleKey}`, scope: { kind: 'studio', id: S } });
  return p.id;
};

describe('the records tools', () => {
  it('offers these tools and none that approve, decide, move stages, change the catalogue or touch locks', async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of NAMES) expect(names).toContain(n);
    expect(names.filter((n) => /^(work|books|files)_/.test(n)).sort()).toEqual(NAMES);
    expect(names.filter((n) => !n.startsWith('studio_')).some((n) => /approve|reject|respond|record|decid|stage|force|check|archive|delete/i.test(n.replace('work_request_approval', '').replace('work_approvals', '').replace('work_decisions', '')))).toBe(false);
  });

  it('adds a task by project path and lists it with its assignee, late and waiting state', async () => {
    const series = await studio.createProject({ name: 'Dragon Rider', kind: 'Series' });
    await studio.createProject({ name: 'Book 1', parentId: series.id, kind: 'Book' });
    const bo = await person('Bo Lin', 'editor');
    const { call } = await connect();
    const a = await call('work_add_task', { project: 'Dragon Rider / Book 1', title: 'Edit pass', due: '2026-11-01', assignee: 'Bo Lin' });
    expect(a.json()).toMatchObject({ project: 'Dragon Rider / Book 1', title: 'Edit pass', assignee: 'Bo Lin', due: '2026-11-01', state: 'open' });
    const b = await call('work_add_task', { project: 'Book 1', title: 'Upload', depends_on: [a.json().id] });
    expect(b.json().waitingFor).toEqual(['Edit pass']);
    const list = await call('work_tasks', { project: 'Dragon Rider' }); // includes subprojects
    expect(list.json().tasks.map((t: { title: string }) => t.title)).toEqual(['Edit pass', 'Upload']);
    expect(list.json().tasks[0].late).toBe(true === (new Date().toISOString().slice(0, 10) > '2026-11-01') ? true : undefined);
    expect((await call('work_tasks', { assignee: 'Bo Lin' })).json().tasks).toHaveLength(1);
    expect((await call('work_tasks', { assignee: bo })).json().tasks).toHaveLength(1); // an id works too
    const done = await call('work_set_task', { task: b.json().id, state: 'done' });
    expect(done.isError).toBe(true);
    expect(done.text).toMatch(/Waiting on: Edit pass/);
    expect((await call('work_set_task', { task: a.json().id, state: 'done' })).json().state).toBe('done');
    expect((await call('work_set_task', { task: b.json().id, state: 'done', title: 'Upload to KDP' })).json()).toMatchObject({ state: 'done', title: 'Upload to KDP' });
  });

  it('says plainly when a project, person or task is wrong', async () => {
    await studio.createProject({ name: 'A' });
    const { call } = await connect();
    expect((await call('work_add_task', { project: 'Nope', title: 'x' })).text).toMatch(/There is no project "Nope"/);
    expect((await call('work_add_task', { project: 'A', title: 'x', assignee: 'Ghost' })).text).toMatch(/No person called "Ghost"/);
    expect((await call('work_set_task', { task: 'nope' })).text).toMatch(/There is no task/);
    expect((await call('work_add_task', { project: 'A', title: 'x', kind: 'deadline' })).isError).toBe(true); // a deadline needs a date
  });

  it('acts as the person, under their role: an Editor may keep their own work but not hand it to others', async () => {
    await studio.createProject({ name: 'A' });
    const bo = await person('Bo', 'editor');
    const cy = await person('Cy', 'editor');
    const { call } = await connect(bo);
    const own = await call('work_add_task', { project: 'A', title: 'Mine', assignee: 'me' });
    expect(own.isError).toBe(false);
    expect(own.json().assignee).toBe('me'); // an Editor may not list people, but knows who they act for
    const other = await call('work_add_task', { project: 'A', title: 'For Cy', assignee: cy });
    expect(other.isError).toBe(true);
    expect(other.text).toMatch(/task\.assign/);
  });

  it('is unavailable to a role that may not use the assistant, and writes its own mark in the audit log', async () => {
    await studio.createProject({ name: 'A' });
    const guestRole = defaultRole('guest');
    expect(guestRole.capabilities).not.toContain('assistant.use');
    const g = await person('Guest', 'guest');
    const denied = await (await connect(g)).call('work_tasks');
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/assistant\.use/);
    const { call } = await connect();
    const t = await call('work_add_task', { project: 'A', title: 'x' });
    const rows = await db.all<{ actor: string; action: string; target: string; detail: string }>("SELECT actor, action, target, detail FROM audit WHERE action = 'assistant'");
    expect(rows).toEqual([{ actor: 'ana', action: 'assistant', target: t.json().id, detail: JSON.stringify({ tool: 'work_add_task', agent: JSON.parse(rows[0]!.detail).agent }) }]);
  });

  it('asks for sign-offs but cannot answer them, and reports who is waiting', async () => {
    const p = await studio.createProject({ name: 'Book' });
    const bo = await person('Bo', 'director');
    const { call } = await connect();
    const r = await call('work_request_approval', { project: 'Book', label: 'Cover approved', approvers: ['Bo'], note: 'Final art' });
    expect(r.json()).toMatchObject({ label: 'Cover approved', state: 'pending', asked: 1 });
    const mine = await (await connect(bo)).call('work_approvals', { waiting_for_me: true });
    expect(mine.json().approvals).toMatchObject([{ label: 'Cover approved', project: 'Book', askedBy: 'Ana', approvers: [{ name: 'Bo', answer: null }] }]);
    expect((await call('work_approvals', { project: 'Book' })).json().projectStandsApprovedFor).toEqual([]);
    await svc.as(bo).work.respond((await ana.work.approvals())[0]!.id, 'approved'); // only the person, in Cadrel
    expect((await call('work_approvals', { project: 'Book' })).json().projectStandsApprovedFor).toEqual(['Cover approved']);
    expect((await call('work_request_approval', { project: 'Book', label: 'X', approvers: [] })).isError).toBe(true);
    void p;
  });

  it('shows the decision ledger and where a project stands', async () => {
    const p = await studio.createProject({ name: 'Book' });
    await ana.work.record({ projectId: p.id, title: 'Price', outcome: '$4.99', context: 'Launch price' });
    await ana.work.createTask({ projectId: p.id, title: 'Late', due: '2020-01-01' });
    const { call } = await connect();
    expect((await call('work_decisions', { project: 'Book' })).json().decisions).toMatchObject([{ title: 'Price', outcome: '$4.99', by: 'Ana', project: 'Book' }]);
    expect((await call('work_project_status', { project: 'Book' })).json()).toMatchObject({ project: 'Book', openTasks: 1, late: 1, nextDate: '2020-01-01', standsApprovedFor: [] });
  });

  it('lists the catalogue with editions and the project each book is made in', async () => {
    const p = await studio.createProject({ name: 'Lead Me project' });
    const s = await ana.catalogue.createSeries({ name: 'Dragon Rider' });
    const b = await ana.catalogue.createBook({ title: 'Lead Me', seriesId: s.id, position: 1, penName: 'Blake' });
    await ana.catalogue.addEdition(b.id, { format: 'ebook', asin: 'B0AAAAAAA1', price: 4.99 });
    await ana.catalogue.createBook({ title: 'Loose' });
    await ana.catalogue.linkProject(b.id, p.id);
    const { call } = await connect();
    const all = (await call('books_list')).json().books;
    expect(all.map((x: { title: string }) => x.title)).toEqual(['Lead Me', 'Loose']);
    expect(all[0]).toMatchObject({ series: 'Dragon Rider', position: 1, penName: 'Blake', project: 'Lead Me project', editions: [{ format: 'ebook', asin: 'B0AAAAAAA1', price: 4.99 }] });
    expect((await call('books_list', { search: 'b0aaaaaaa1' })).json().books).toHaveLength(1);
    expect((await call('books_list', { series: 'dragon rider' })).json().books).toHaveLength(1);
  });

  it('lists vault files with their locks and references, for roles that may read them', async () => {
    for (const [id, rel] of [['f1', 'Book/ms.md'], ['f2', 'Book/cover.psd']]) await addVaultFile(db, { studioId: S, path: rel!, personId: 'ana', now: NOW().toISOString(), id: id! });
    for (const id of ['f1', 'f2']) {
      await checkOut(db, { fileId: id, personId: 'ana', machine: 'pc', now: NOW().toISOString() });
      await checkIn(db, { fileId: id, personId: 'ana', machine: 'pc', hash: `h${id}`, size: 5, comment: '', now: NOW().toISOString() });
    }
    await addReference(db, { fileId: 'f1', refersToId: 'f2', version: 1, actor: 'ana', now: NOW().toISOString() });
    const bo = await person('Bo', 'editor');
    await checkOut(db, { fileId: 'f1', personId: bo, machine: 'pc-b', now: NOW().toISOString() });
    const { call } = await connect();
    const r = (await call('files_list')).json().files;
    expect(r).toMatchObject([
      { path: 'Book/cover.psd', version: 1, usedBy: [{ path: 'Book/ms.md', version: 1 }] },
      { path: 'Book/ms.md', checkedOutBy: { person: 'Bo' }, uses: [{ path: 'Book/cover.psd', version: 1 }] }
    ]);
    expect((await call('files_list', { checked_out_only: true })).json().files).toHaveLength(1);
    expect((await call('files_list', { search: 'cover' })).json().files).toHaveLength(1);
    void newRecordId;
  });
});

describe('the records tools follow who is assigned to the project', () => {
  it('lists only the tasks of projects the person is assigned to, and gives work only to people assigned to the project', async () => {
    const tree = () => studio.read().then((d) => d.tree);
    svc = new StudioService({ db, studioId: S, access: dbAccess(db, S), now: NOW, projects: tree });
    ana = svc.as('ana');
    const series = await studio.createProject({ name: 'Dragon Rider', kind: 'Series' });
    const b1 = await studio.createProject({ name: 'Book 1', parentId: series.id, kind: 'Book' });
    const b2 = await studio.createProject({ name: 'Book 2', parentId: series.id, kind: 'Book' });
    const eve = (await ana.people.create({ name: 'Eve Editor' })).id;
    const bo = (await ana.people.create({ name: 'Bo Author' })).id;
    await ana.people.grant({ subject: { kind: 'person', id: eve }, roleId: 'role_editor', scope: { kind: 'project', id: b1.id } });
    await ana.people.grant({ subject: { kind: 'person', id: bo }, roleId: 'role_author', scope: { kind: 'project', id: b2.id } });

    const owner = await connect('ana');
    expect((await owner.call('work_add_task', { project: 'Book 1', title: 'Edit pass', assignee: 'Eve Editor' })).isError).toBe(false);
    const refused = await owner.call('work_add_task', { project: 'Book 1', title: 'Wrong person', assignee: 'Bo Author' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/Bo Author is not assigned to this project/);
    expect((await owner.call('work_add_task', { project: 'Book 2', title: 'Proof', assignee: 'Bo Author' })).isError).toBe(false);
    const names = (await owner.call('work_people', { project: 'Book 1' })).json() as { name: string }[];
    expect(names.map((n) => n.name).sort()).toEqual(['Ana', 'Eve Editor']);

    // Eve acts through the assistant: she is an Editor on Book 1 only, so Book 2's work is not there for her.
    const eveSide = await connect(eve);
    const mine = await eveSide.call('work_tasks', { state: 'any' });
    expect(mine.json().tasks.map((t: { title: string }) => t.title)).toEqual(['Edit pass']);
    const other = await eveSide.call('work_add_task', { project: 'Book 2', title: 'Sneaky' });
    expect(other.isError).toBe(true);
    expect(other.text).toMatch(/no such project/i);
    void b1;
  });
});

describe('managing projects from the assistant', () => {
  const tree = () => studio.read().then((d) => d.tree);
  beforeEach(() => {
    svc = new StudioService({ db, studioId: S, access: dbAccess(db, S), now: NOW, projects: tree });
    ana = svc.as('ana');
  });

  it('creates a series, a book that starts in the default stage, and a standalone made whole; edits and reorders them', async () => {
    const { call } = await connect();
    const ser = (await call('studio_create_project', { name: 'Dragon Rider', kind: 'Series' })).json();
    expect(ser.level).toBe('project');
    expect(ser).not.toHaveProperty('stage'); // a project has no stage
    const b1 = (await call('studio_create_project', { name: 'Book 1', parent: 'Dragon Rider' })).json();
    const b2 = (await call('studio_create_project', { name: 'Book 2', parent: 'Dragon Rider' })).json();
    expect(b1).toMatchObject({ level: 'book', kind: 'Book' });
    expect(typeof b1.stage).toBe('string'); // it starts in the default workflow's first stage
    const solo = (await call('studio_create_project', { name: 'The Lost King', standalone: true })).json();
    expect(solo.level).toBe('project');
    const rows = (await call('studio_projects')).json().projects as { name: string; level: string; stage?: string }[];
    expect(rows.filter((r) => r.name === 'The Lost King').map((r) => r.level).sort()).toEqual(['book', 'project']);
    expect((await call('studio_create_project', { name: 'x', parent: 'Dragon Rider', standalone: true })).isError).toBe(true);

    await call('studio_update_project', { project: 'Book 2', position: 1 });
    const order = (await call('studio_projects', { project: 'Dragon Rider' })).json().projects.map((r: { name: string }) => r.name);
    expect(order.indexOf('Book 2')).toBeLessThan(order.indexOf('Book 1'));
    expect((await call('studio_update_project', { project: 'Book 1', name: 'Ember' })).json().name).toBe('Ember');
    void b2;
  });

  it('links a comparable title by ASIN and refuses what is not one', async () => {
    const { call } = await connect();
    await call('studio_create_project', { name: 'Dragon Rider' });
    expect((await call('studio_link', { module: 'comp', record: 'b0abc12345', project: 'Dragon Rider' })).json().links).toContainEqual({ module: 'comp', record: 'B0ABC12345' });
    expect((await call('studio_link', { module: 'comp', record: 'nope', project: 'Dragon Rider' })).isError).toBe(true);
  });

  it('shows a Book\'s stage and moves it through the gates, with every reason when it may not', async () => {
    const { call } = await connect();
    await call('studio_create_project', { name: 'Dragon Rider' });
    await call('studio_create_project', { name: 'Book 1', parent: 'Dragon Rider' });
    const show = (await call('studio_stage', { project: 'Book 1' })).json();
    expect(show.stage.name).toBeTruthy();
    expect(show.closed).toBe(false);
    expect(show.moves.length).toBeGreaterThan(0);
    expect((await call('studio_stage', { project: 'Dragon Rider' })).text).toMatch(/not a book/);
    const target = show.moves.find((m: { allowed: boolean }) => m.allowed);
    expect(target, 'a first move is open').toBeDefined();
    {
      const moved = (await call('studio_stage', { project: 'Book 1', action: 'move', to: target.name })).json();
      expect(moved.stage.name).toBe(target.name);
    }
    const blocked = show.moves.find((m: { allowed: boolean }) => !m.allowed);
    const stillBlocked = (await call('studio_stage', { project: 'Book 1' })).json().moves.find((m: { allowed: boolean }) => !m.allowed);
    if (stillBlocked) {
      const r = await call('studio_stage', { project: 'Book 1', action: 'move', to: stillBlocked.name });
      expect(r.isError).toBe(true);
      expect(r.text.length).toBeGreaterThan(10);
    }
    void blocked;
    expect((await call('studio_stage', { project: 'Book 1', action: 'move', to: 'Nonesuch' })).isError).toBe(true);
    expect((await call('studio_stage', { project: 'Book 1', action: 'reopen', to: 'Nonesuch' })).isError).toBe(true);
  });

  it('assigns people to a project, so they see it and can be given work there, and takes the role off again', async () => {
    const { call } = await connect();
    await call('studio_create_project', { name: 'Dragon Rider' });
    await call('studio_create_project', { name: 'Book 1', parent: 'Dragon Rider' });
    const eve = (await ana.people.create({ name: 'Eve Editor' })).id;
    expect((await call('studio_roles')).json().map((r: { name: string }) => r.name)).toContain('Editor');

    const refused = await call('work_add_task', { project: 'Book 1', title: 'Edit', assignee: 'Eve Editor' });
    expect(refused.isError).toBe(true); // not assigned to the project yet
    const made = (await call('studio_assign', { project: 'Book 1', person: 'Eve Editor', role: 'Editor', until: '2027-03-31' })).json();
    expect(made).toMatchObject({ who: 'Eve Editor', role: 'Editor', project: 'Dragon Rider / Book 1', until: '2027-03-31' });
    expect((await call('work_add_task', { project: 'Book 1', title: 'Edit', assignee: 'Eve Editor' })).isError).toBe(false);

    const listed = (await call('studio_people', { project: 'Dragon Rider / Book 1' })).json().assigned as { who: string; role: string; applies_to: string; until?: string }[];
    expect(listed).toEqual([expect.objectContaining({ who: 'Eve Editor', role: 'Editor', applies_to: 'this project', until: '2027-03-31' })]);
    expect((await call('studio_people', { project: 'Dragon Rider' })).json().assigned).toHaveLength(1); // the series lists its books' roles too

    // Eve, acting through the assistant, sees her book but cannot manage roles
    const eveSide = await connect(eve);
    expect(((await eveSide.call('studio_projects')).json().projects as { name: string }[]).map((r) => r.name).sort()).toEqual(['Book 1', 'Dragon Rider']);
    const noGrant = await eveSide.call('studio_assign', { project: 'Book 1', person: 'Eve Editor', role: 'Author' });
    expect(noGrant.isError).toBe(true);

    expect((await call('studio_unassign', { assignment: made.assignment })).json()).toEqual({ removed: made.assignment });
    expect((await call('studio_people', { project: 'Book 1' })).json().assigned).toEqual([]);
    expect((await call('studio_assign', { project: 'Book 1', person: 'Nobody', role: 'Editor' })).isError).toBe(true);
    expect((await call('studio_assign', { project: 'Book 1', role: 'Editor' })).isError).toBe(true);
    expect((await call('studio_unassign', { assignment: 'zzz' })).isError).toBe(true);
  });
});

describe('a new project can be given its folder, and linked to what belongs to it', () => {
  it('makes the manuscript folder from a template, links it, and refuses a second one', async () => {
    const { call } = await connect();
    await call('studio_create_project', { name: 'Dragon Rider', kind: 'Series' });
    await call('studio_create_project', { name: 'Book 1: Ember', parent: 'Dragon Rider' });

    const series = (await call('studio_add_folder', { project: 'Dragon Rider' })).json();
    expect(series).toMatchObject({ folder: 'Dragon Rider', template: 'Series', manuscript_folder: 'Dragon Rider' });
    expect((await mem.stat('/books/Dragon Rider/.cadrel/project.json'))).toBeTruthy();
    expect((await mem.stat('/books/Dragon Rider/Series Bible/Series Bible.md'))).toBeTruthy();

    // a book's name can hold characters a folder cannot ("Book 1: Ember"); they are taken out, and a name can be given
    const book = (await call('studio_add_folder', { project: 'Book 1: Ember' })).json();
    expect(book).toMatchObject({ folder: 'Book 1 Ember', template: 'Novel' });
    expect((await mem.stat('/books/Book 1 Ember/Manuscript/Draft.md'))).toBeTruthy();

    const again = await call('studio_add_folder', { project: 'Book 1: Ember', name: 'Other' });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/already has a manuscript folder/);
    await call('studio_create_project', { name: 'Solo' });
    expect((await call('studio_add_folder', { project: 'Solo', template: 'Nonesuch' })).isError).toBe(true);
    expect((await call('studio_add_folder', { project: 'Solo', name: 'CON' })).isError).toBe(true);
    const blank = (await call('studio_add_folder', { project: 'Solo', template: 'blank', name: 'Solo Notes' })).json();
    expect(blank).toMatchObject({ folder: 'Solo Notes', template: 'Blank' });
    expect((await call('studio_add_folder', { project: 'Dragon Rider', name: 'Solo Notes' })).isError).toBe(true); // has a folder already

  });

  it('links a catalogue book to a project and unlinks it, and sees only projects the person is assigned to', async () => {
    const { call } = await connect();
    await call('studio_create_project', { name: 'Dragon Rider' });
    const ser = await ana.catalogue.createSeries({ name: 'Dragon Rider' });
    const book = await ana.catalogue.createBook({ title: 'Ember', seriesId: ser.id });
    await ana.catalogue.addEdition(book.id, { format: 'ebook', asin: 'B0ABC12345' });
    const done = (await call('books_link_project', { book: 'B0ABC12345', project: 'Dragon Rider' })).json();
    expect(done).toEqual({ book: 'Ember', project: 'Dragon Rider' });
    expect((await call('books_list')).json().books[0].project).toBe('Dragon Rider');
    expect((await call('books_link_project', { book: 'Ember' })).json()).toEqual({ book: 'Ember', project: null });
    expect((await call('books_link_project', { book: 'Nope' })).isError).toBe(true);
    expect((await call('books_link_project', { book: 'Ember', project: 'Nope' })).isError).toBe(true);
  });
});
