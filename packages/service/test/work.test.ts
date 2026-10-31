import { describe, expect, it } from 'vitest';
import { ROLE_KEYS, bootstrapStudio, defaultRole, type Ctx } from '@cadrel/kernel';
import { memoryStudioDb } from '@cadrel/store';
import { PermissionDenied, StudioService, dbAccess } from '../src/index';

const S = 'studio1';
const STUDIO = { kind: 'studio' as const, id: S };
const NOW = () => new Date('2026-10-27T10:00:00.000Z');
const denied = (p: Promise<unknown>) => p.then(() => false, (e) => e instanceof PermissionDenied); // any other error means the permission check passed

async function studio() {
  const db = memoryStudioDb();
  await bootstrapStudio(db, { studioId: S, actor: 'ana', now: NOW().toISOString() } as Ctx, { id: 'ana', name: 'Ana' });
  const svc = new StudioService({ db, studioId: S, access: dbAccess(db, S), now: NOW });
  const ana = svc.as('ana');
  const person = async (name: string, roleKey: string) => {
    const p = await ana.people.create({ name });
    await ana.people.grant({ subject: { kind: 'person', id: p.id }, roleId: `role_${roleKey}`, scope: STUDIO });
    return p.id;
  };
  return { svc, ana, person };
}

describe('tasks, approvals and decisions behind the permission check', () => {
  it.each(ROLE_KEYS)('%s: reads with task.read, writes with task.edit, hands work over with task.assign, reaches anyone’s with task.manage', async (key) => {
    const { svc, ana, person } = await studio();
    const other = await person('Other', 'owner');
    const id = key === 'owner' ? 'ana' : await person(`P-${key}`, key);
    const me = svc.as(id).work;
    const caps = new Set(defaultRole(key).capabilities);
    const has = (c: string) => key === 'owner' || caps.has(c);
    const theirs = await ana.work.createTask({ projectId: 'p1', title: 'Theirs', assigneeId: other });
    const mine = await ana.work.createTask({ projectId: 'p1', title: 'Mine', assigneeId: id });

    expect(await denied(me.tasks()), 'read').toBe(!has('task.read'));
    expect(await denied(me.openTaskCount(['p1'])), 'count').toBe(!has('task.read'));
    expect(await denied(me.createTask({ projectId: 'p1', title: 'Own' })), 'create own').toBe(!has('task.edit'));
    expect(await denied(me.createTask({ projectId: 'p1', title: 'For other', assigneeId: other })), 'create for other').toBe(!has('task.assign'));
    expect(await denied(me.updateTask(mine.id, { title: 'Mine 2' })), 'edit assigned to me').toBe(!has('task.edit'));
    expect(await denied(me.updateTask(theirs.id, { title: 'Theirs 2' })), 'edit theirs').toBe(!has('task.manage'));
    expect(await denied(me.setState(theirs.id, 'cancelled')), 'cancel theirs').toBe(!has('task.manage'));
    expect(await denied(me.updateTask(mine.id, { assigneeId: other })), 'hand mine over').toBe(!has('task.edit') || !has('task.assign'));
    expect(await denied(me.requestApproval({ projectId: 'p1', label: `L-${key}`, approverIds: [other] })), 'request').toBe(!has('task.edit'));
    expect(await denied(me.record({ projectId: 'p1', title: 'D', outcome: 'ok' })), 'record').toBe(!has('task.edit'));
    expect(await denied(me.decisions()), 'ledger').toBe(!has('task.read'));
  });

  it('only a named approver answers, whatever else they hold; anyone with task.read may be asked', async () => {
    const { svc, ana, person } = await studio();
    const editor = await person('Eve', 'editor');
    const author = await person('Al', 'author');
    const a = await svc.as(editor).work.requestApproval({ projectId: 'p1', label: 'Cover approved', approverIds: [author] });
    await expect(ana.work.respond(a.id, 'approved')).rejects.toThrow(/not one of the people/); // even an Owner cannot answer for someone
    expect(await svc.as(author).work.waitingForMe()).toHaveLength(1);
    expect((await svc.as(author).work.respond(a.id, 'approved')).state).toBe('approved');
    expect(await ana.work.approvedLabels('p1')).toEqual(['Cover approved']);
  });

  it('withdraws a request by whoever made it, or by task.manage', async () => {
    const { svc, ana, person } = await studio();
    const editor = await person('Eve', 'editor');
    const author = await person('Al', 'author');
    const a = await svc.as(editor).work.requestApproval({ projectId: 'p1', label: 'One', approverIds: [ana.personId] });
    const b = await svc.as(editor).work.requestApproval({ projectId: 'p1', label: 'Two', approverIds: [ana.personId] });
    expect(await denied(svc.as(author).work.withdraw(a.id))).toBe(true);
    expect((await svc.as(editor).work.withdraw(a.id)).state).toBe('withdrawn');
    expect((await ana.work.withdraw(b.id)).state).toBe('withdrawn');
  });

  it('keeps decisions: recorded by those who may, replaced and never changed', async () => {
    const { ana } = await studio();
    const d1 = await ana.work.record({ projectId: 'p1', title: 'Price', outcome: '$4.99' });
    await ana.work.record({ projectId: 'p1', title: 'Price', outcome: '$3.99', supersedes: d1.id });
    expect((await ana.work.decisions({ projectId: 'p1', current: true })).map((d) => d.outcome)).toEqual(['$3.99']);
    expect(Object.keys(ana.work).filter((k) => /decision|record/i.test(k)).sort()).toEqual(['decision', 'decisions', 'record']); // read and add: no way to change or remove an entry
  });
});

describe('linking a book to its project', () => {
  it.each(ROLE_KEYS)('%s: sees the links with catalogue.read, changes them with catalogue.edit', async (key) => {
    const { svc, ana, person } = await studio();
    const id = key === 'owner' ? 'ana' : await person(`P-${key}`, key);
    const caps = new Set(defaultRole(key).capabilities);
    const has = (c: string) => key === 'owner' || caps.has(c);
    const book = await ana.catalogue.createBook({ title: `B-${key}` });
    const me = svc.as(id).catalogue;
    expect(await denied(me.projectLinks()), 'read').toBe(!has('catalogue.read'));
    expect(await denied(me.linkProject(book.id, `p-${key}`)), 'link').toBe(!has('catalogue.edit'));
  });
});

describe('records follow who is assigned to the project', () => {
  async function world() {
    const { createProject, emptyTree } = await import('@cadrel/kernel');
    let tree = emptyTree();
    const mk = (name: string, parentId: string | null = null) => {
      const r = createProject(tree, { name, parentId });
      tree = r.tree;
      return r.project.id;
    };
    const ser = mk('Dragon Rider');
    const b1 = mk('Book 1', ser);
    const b2 = mk('Book 2', ser);
    const secret = mk('Secret');
    const db = memoryStudioDb();
    await bootstrapStudio(db, { studioId: S, actor: 'ana', now: NOW().toISOString() } as Ctx, { id: 'ana', name: 'Ana' });
    const svc = new StudioService({ db, studioId: S, access: dbAccess(db, S), now: NOW, projects: async () => tree });
    const ana = svc.as('ana');
    const assign = async (name: string, roleKey: string, projectId: string | null) => {
      const p = await ana.people.create({ name });
      await ana.people.grant({ subject: { kind: 'person', id: p.id }, roleId: `role_${roleKey}`, scope: projectId ? { kind: 'project', id: projectId } : STUDIO });
      return p.id;
    };
    return { svc, ana, assign, ser, b1, b2, secret };
  }

  it('lists, counts and reads only the records of projects the person is assigned to; the Owner reaches all', async () => {
    const { svc, ana, assign, b1, b2, secret } = await world();
    const eve = await assign('Eve', 'editor', b1);
    const t1 = await ana.work.createTask({ projectId: b1, title: 'On book 1', assigneeId: eve });
    const t2 = await ana.work.createTask({ projectId: b2, title: 'On book 2' });
    const t3 = await ana.work.createTask({ projectId: secret, title: 'On the secret' });
    await ana.work.requestApproval({ projectId: b1, label: 'Cover', approverIds: [eve] });
    await ana.work.requestApproval({ projectId: secret, label: 'Plot', approverIds: ['ana'] });
    await ana.work.record({ projectId: b2, title: 'Hidden decision', outcome: 'x' });
    await ana.work.record({ projectId: b1, title: 'Seen decision', outcome: 'x' });
    await ana.work.record({ projectId: null, title: 'Studio decision', outcome: 'x' });

    const me = svc.as(eve).work;
    expect((await me.tasks({ state: 'any' })).map((t) => t.title)).toEqual(['On book 1']);
    expect(await me.task(t2.id)).toBeNull();
    expect(await me.task(t3.id)).toBeNull();
    expect((await me.task(t1.id))?.title).toBe('On book 1');
    expect(await me.openTaskCount([b1, b2, secret])).toBe(1);
    expect((await me.approvals()).map((a) => a.label)).toEqual(['Cover']);
    expect((await me.decisions()).map((d) => d.title).sort()).toEqual(['Seen decision', 'Studio decision']);
    expect((await ana.work.tasks({ state: 'any' }))).toHaveLength(3);
    expect(await ana.work.openTaskCount([b1, b2, secret])).toBe(3);
  });

  it('refuses to create or change records on a project the person is not assigned to, as if it were not there', async () => {
    const { svc, ana, assign, b1, b2 } = await world();
    const eve = await assign('Eve', 'editor', b1);
    const bo = await assign('Bo', 'editor', b2);
    const on2 = await ana.work.createTask({ projectId: b2, title: 'On book 2', assigneeId: bo });
    const me = svc.as(eve).work;
    for (const attempt of [
      () => me.createTask({ projectId: b2, title: 'x' }),
      () => me.requestApproval({ projectId: b2, label: 'x', approverIds: [eve] }),
      () => me.record({ projectId: b2, title: 'x', outcome: 'y' }),
      () => me.updateTask(on2.id, { title: 'y' }),
      () => me.setState(on2.id, 'done'),
      () => me.approvedLabels(b2),
      () => me.assignable(b2)
    ]) await expect(attempt()).rejects.toThrow(/no such project|not there/);
  });

  it('a task or sign-off can go only to someone assigned to its project', async () => {
    const { svc, ana, assign, ser, b1, b2 } = await world();
    const eve = await assign('Eve', 'editor', b1);
    const bo = await assign('Bo', 'author', b2);
    const studioWide = await assign('Sam', 'editor', null); // a studio-wide role does not assign anyone
    const lead = await assign('Lee', 'series_lead', ser); // a role on the series covers its books
    const admin = await assign('Ada', 'admin', null); // sees every project

    await expect(ana.work.createTask({ projectId: b1, title: 'x', assigneeId: bo })).rejects.toThrow(/Bo is not assigned to this project/);
    await expect(ana.work.createTask({ projectId: b1, title: 'x', assigneeId: studioWide })).rejects.toThrow(/Sam is not assigned/);
    for (const ok of [eve, lead, admin, 'ana']) expect((await ana.work.createTask({ projectId: b1, title: 'ok', assigneeId: ok })).assigneeId).toBe(ok);

    const t = await ana.work.createTask({ projectId: b1, title: 'move me', assigneeId: eve });
    await expect(ana.work.updateTask(t.id, { assigneeId: bo })).rejects.toThrow(/not assigned/);
    expect((await ana.work.updateTask(t.id, { assigneeId: lead })).assigneeId).toBe(lead);
    expect((await ana.work.updateTask(t.id, { title: 'renamed' })).title).toBe('renamed'); // changing nothing about the assignee asks nothing of it

    await expect(ana.work.requestApproval({ projectId: b1, label: 'Cover', approverIds: [eve, bo] })).rejects.toThrow(/Bo is not assigned.*sign-off/);
    expect((await ana.work.requestApproval({ projectId: b1, label: 'Cover', approverIds: [eve, lead] })).label).toBe('Cover');

    expect((await ana.work.assignable(b1)).map((p) => p.id).sort()).toEqual([admin, eve, lead, 'ana'].sort());
    expect((await svc.as(eve).work.assignable(b1)).map((p) => p.id)).toContain(lead);
    expect((await ana.work.assignable(b2)).map((p) => p.id)).toContain(bo);
  });

  it('a project shown only as the container of a book the person is on is not theirs to work on', async () => {
    const { svc, ana, assign, ser, b1 } = await world();
    const eve = await assign('Eve', 'editor', b1);
    await ana.work.createTask({ projectId: ser, title: 'Series-level' });
    expect(await svc.as(eve).work.tasks({ state: 'any' })).toEqual([]);
    await expect(svc.as(eve).work.createTask({ projectId: ser, title: 'x' })).rejects.toThrow(/no such project/);
  });

  it('limits nothing without a project tree to go by', async () => {
    const { svc, ana, person } = await studio();
    const eve = await person('Eve', 'editor');
    await ana.work.createTask({ projectId: 'anything', title: 'x', assigneeId: eve });
    expect(await svc.as(eve).work.tasks({ state: 'any' })).toHaveLength(1);
  });
});
