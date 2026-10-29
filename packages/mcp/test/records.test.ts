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
import { createCadrelServer, recordsModule, studioModule } from '../src/index.js';

const S = 'studio1';
const NOW = () => new Date('2026-11-10T10:00:00.000Z');
const NAMES = ['books_list', 'files_list', 'work_add_task', 'work_approvals', 'work_decisions', 'work_people', 'work_project_status', 'work_request_approval', 'work_set_task', 'work_tasks'];

let db: StudioDb, svc: StudioService, studio: Studio, ana: ReturnType<StudioService['as']>;
beforeEach(async () => {
  db = memoryStudioDb();
  await bootstrapStudio(db, { studioId: S, actor: 'ana', now: NOW().toISOString() } as Ctx, { id: 'ana', name: 'Ana' });
  svc = new StudioService({ db, studioId: S, access: dbAccess(db, S), now: NOW });
  ana = svc.as('ana');
  studio = new Studio(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-rec-mcp-')), 'studio.json'));
});

async function connect(personId = 'ana') {
  const server = createCadrelServer({ modules: [studioModule({ studio }), recordsModule({ service: svc, personId, studio, studioId: S, db })] });
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
    expect(names.some((n) => /approve|reject|respond|record|decid|stage|force|check|archive|delete/i.test(n.replace('work_request_approval', '').replace('work_approvals', '').replace('work_decisions', '')))).toBe(false);
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
