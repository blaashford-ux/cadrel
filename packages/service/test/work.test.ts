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
