import { describe, expect, it } from 'vitest';
import { ROLE_KEYS, defaultRole, type Assignment, type RoleKey } from '@cadrel/kernel';
import { memoryStudioDb } from '@cadrel/store';
import { PermissionDenied, StudioService, ownerAccess, type Access } from '../src/index';

const S = 'studio1';
const NOW = () => new Date('2026-10-27T10:00:00.000Z');
const roles = ROLE_KEYS.map((k) => defaultRole(k));

/** A studio with one person per default role, each assigned their role at the studio. */
function studio() {
  const db = memoryStudioDb();
  const assignments: Assignment[] = ROLE_KEYS.map((k) => ({ id: `a-${k}`, subject: { kind: 'person', id: k }, roleId: `role_${k}`, scope: { kind: 'studio', id: S } }));
  const access: Access = { assignments: () => assignments, roles: () => roles, teams: (p) => (p === 'teamed' ? ['t1'] : []) };
  return { db, assignments, svc: new StudioService({ db, studioId: S, access, now: NOW }) };
}
const denied = (p: Promise<unknown>) => p.then(() => false, (e) => e instanceof PermissionDenied);

// what each default role may do in the catalogue, from docs/PERMISSIONS.md: M creates and archives, W edits, R reads, - nothing
const LEVEL: Record<RoleKey, 'M' | 'W' | 'R' | '-'> = {
  owner: 'M', admin: 'M', director: 'M', series_lead: 'W', author: 'R', editor: 'R', art_director: 'R', artist: 'R', marketing: 'R', analyst: 'R', finance: 'R', guest: '-'
};

describe('the catalogue behind the permission check', () => {
  it.each(ROLE_KEYS)('%s: may do exactly what its level in the matrix allows', async (key) => {
    const { svc } = studio();
    const level = LEVEL[key];
    const seed = svc.as('owner').catalogue;
    const series = await seed.createSeries({ name: 'Seed' });
    const book = await seed.createBook({ title: 'Seed book', seriesId: series.id });
    const edition = await seed.addEdition(book.id, { format: 'ebook' });
    const me = svc.as(key).catalogue;
    const rank = { '-': 0, R: 1, W: 2, M: 3 }[level];
    expect(await denied(me.books()), 'read').toBe(rank < 1);
    expect(await denied(me.byAsin('B0AAAAAAA1')), 'read by asin').toBe(rank < 1);
    expect(await denied(me.updateBook(book.id, { subtitle: 'x' })), 'edit').toBe(rank < 2);
    expect(await denied(me.setStage(book.id, 'drafting')), 'move stage').toBe(rank < 2);
    expect(await denied(me.stageOptions(book.id)), 'see stages').toBe(rank < 1);
    expect(await denied(me.addEdition(book.id, { format: 'paperback' })), 'add edition').toBe(rank < 2);
    expect(await denied(me.updateEdition(edition.id, { price: 1 })), 'edit edition').toBe(rank < 2);
    expect(await denied(me.moveBook(book.id, null)), 'move').toBe(rank < 2);
    expect(await denied(me.createIp({ name: `ip-${key}` })), 'create').toBe(rank < 3);
    expect(await denied(me.createSeries({ name: `s-${key}` })), 'create series').toBe(rank < 3);
    expect(await denied(me.createBook({ title: `b-${key}` })), 'create book').toBe(rank < 3);
    expect(await denied(me.archive('edition', edition.id)), 'archive').toBe(rank < 3);
  });

  it('a refused change does nothing and writes no audit row; an allowed one is stamped with the actor and the clock', async () => {
    const { svc, db } = studio();
    expect(await denied(svc.as('author').catalogue.createIp({ name: 'Nope' }))).toBe(true);
    expect(await db.all('SELECT 1 FROM ip')).toEqual([]);
    expect(await db.all('SELECT 1 FROM audit')).toEqual([]);
    const ip = await svc.as('director').catalogue.createIp({ name: 'World' });
    expect(ip).toMatchObject({ createdBy: 'director', updatedBy: 'director', createdAt: '2026-10-27T10:00:00.000Z' });
    expect(await db.all<{ actor: string; action: string }>('SELECT actor, action FROM audit')).toEqual([{ actor: 'director', action: 'catalogue.ip.create' }]);
  });

  it('says why it refused, and explain gives the same answer the call does', async () => {
    const { svc } = studio();
    await expect(svc.as('guest').catalogue.books()).rejects.toThrow(/catalogue\.read.*no active role grants/);
    const d = await svc.as('author').explain('catalogue.create');
    expect(d.allowed).toBe(false);
    expect(await svc.as('author').can('catalogue.read')).toBe(true);
    expect(await svc.as('admin').can('catalogue.archive')).toBe(true);
  });

  it('a person with no assignment at all can do nothing', async () => {
    const { svc } = studio();
    expect(await denied(svc.as('stranger').catalogue.books())).toBe(true);
  });

  it('a role held only on one project does not reach studio-wide catalogue calls', async () => {
    const { svc, assignments } = studio();
    assignments.push({ id: 'scoped', subject: { kind: 'person', id: 'pat' }, roleId: 'role_director', scope: { kind: 'project', id: 'p-book-3' } });
    expect(await denied(svc.as('pat').catalogue.books())).toBe(true);
  });

  it('an expired assignment stops applying, and a team assignment applies to its members', async () => {
    const { svc, assignments } = studio();
    assignments.push({ id: 'temp', subject: { kind: 'person', id: 'freelancer' }, roleId: 'role_editor', scope: { kind: 'studio', id: S }, expiresAt: '2026-10-27T09:00:00.000Z' });
    assignments.push({ id: 'team', subject: { kind: 'team', id: 't1' }, roleId: 'role_series_lead', scope: { kind: 'studio', id: S } });
    expect(await denied(svc.as('freelancer').catalogue.books())).toBe(true);
    expect(await denied(svc.as('teamed').catalogue.books())).toBe(false);
    expect(await denied(svc.as('teamed').catalogue.createSeries({ name: 'X' }))).toBe(true); // Series Lead edits but does not create
  });

  it('a role change takes effect on the next call, with no restart', async () => {
    const { svc, assignments } = studio();
    expect(await denied(svc.as('author').catalogue.createIp({ name: 'A' }))).toBe(true);
    assignments.push({ id: 'promo', subject: { kind: 'person', id: 'author' }, roleId: 'role_director', scope: { kind: 'studio', id: S } });
    expect(await denied(svc.as('author').catalogue.createIp({ name: 'A' }))).toBe(false);
  });
});

describe('the one-person Studio', () => {
  it('runs on the owner’s own access and builds a series of three books with editions that the ASIN finds', async () => {
    const db = memoryStudioDb();
    const svc = new StudioService({ db, studioId: 'local', access: ownerAccess('me', 'local'), now: NOW });
    const me = svc.as('me').catalogue;
    const ip = await me.createIp({ name: 'The Salt Road' });
    const series = await me.createSeries({ name: 'Salt Road Trilogy', ipId: ip.id });
    const books = [];
    for (const title of ['Landfall', 'Tidewater', 'Harvest']) books.push(await me.createBook({ title, seriesId: series.id }));
    await me.addEdition(books[0]!.id, { format: 'ebook', asin: 'B0C1R52V2J', publishedOn: '2026-11-01' });
    await me.addEdition(books[0]!.id, { format: 'paperback', isbn: '978-0-306-40615-7' });
    expect((await me.books({ seriesId: series.id })).map((b) => [b.position, b.title, b.editions.length])).toEqual([[1, 'Landfall', 2], [2, 'Tidewater', 0], [3, 'Harvest', 0]]);
    expect((await me.byAsin('b0c1r52v2j'))!.book.title).toBe('Landfall');
    expect(await svc.as('someone-else').catalogue.books().then(() => 'allowed', () => 'refused')).toBe('refused');
  });
});
