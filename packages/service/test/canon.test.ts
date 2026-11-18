import { describe, expect, it } from 'vitest';
import { bootstrapStudio, makeAnchor, type Ctx, type ProjectTree } from '@cadrel/kernel';
import { memoryStudioDb } from '@cadrel/store';
import { PermissionDenied, StudioService, dbAccess } from '../src/index';

const S = 'studio1';
let clock = Date.parse('2026-11-18T10:00:00.000Z');
const NOW = () => new Date((clock += 1000));
const T = '2026-01-01T00:00:00.000Z';
const proj = (id: string, name: string, parentId: string | null, kind: string) => ({ id, name, parentId, kind, status: 'active' as const, order: 0, workflowId: null, stage: null, createdAt: T, updatedAt: T });
const TREE = {
  projects: [proj('series', 'Dragon Rider', null, 'Series'), proj('b1', 'Book One', 'series', 'Book'), proj('b4', 'Book Four', 'series', 'Book'), proj('solo', 'Standalone', null, 'Book'), proj('other', 'Other Series', null, 'Series'), proj('ob', 'Other Book', 'other', 'Book')],
  links: []
} as unknown as ProjectTree;
const kind = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof PermissionDenied ? 'denied' : (e as Error).message || 'error'));
const BOOK4 = 'Mara walked to the ford with her green eyes narrowed.';

/** A studio with a series of two books, a standalone book and another series; people with default roles on exactly what they are given. */
async function studio() {
  const db = memoryStudioDb();
  await bootstrapStudio(db, { studioId: S, actor: 'ana', now: NOW().toISOString() } as Ctx, { id: 'ana', name: 'Ana' });
  const svc = new StudioService({ db, studioId: S, access: dbAccess(db, S), now: NOW, projects: async () => TREE });
  const ana = svc.as('ana');
  const person = async (name: string, roleId: string, projectId?: string) => {
    const p = await ana.people.create({ name });
    await ana.people.grant({ subject: { kind: 'person', id: p.id }, roleId, scope: projectId ? { kind: 'project', id: projectId } : { kind: 'studio', id: S } });
    return svc.as(p.id);
  };
  await db.run("INSERT INTO vault_file (id, studio_id, path, current_version) VALUES ('f4', ?, 'Book Four/book.md', 2)", [S]);
  await db.run("INSERT INTO file_card (file_id, project_id, fields, updated_at, updated_by) VALUES ('f4', 'b4', '{}', 'x', 'x')");
  await db.run("INSERT INTO vault_file (id, studio_id, path, current_version) VALUES ('f1', ?, 'Book One/book.md', 1)", [S]);
  await db.run("INSERT INTO file_card (file_id, project_id, fields, updated_at, updated_by) VALUES ('f1', 'b1', '{}', 'x', 'x')");
  return { db, svc, ana, person };
}

describe('canon: who may read, propose and approve', () => {
  it('a Series Lead assigned to the series changes canon in one step; everyone else needs an approval', async () => {
    const { person, ana } = await studio();
    const lea = await person('Lea Lead', 'role_series_lead', 'series');
    const ann = await person('Ann Author', 'role_author', 'b4'); // a role on one book of the series only
    expect(await kind(lea.canon.apply('b4', { change: 'add_entry', kind: 'character', name: 'Mara', summary: 'A ferrywoman.' }))).toBe('ok');
    const [mara] = await lea.canon.listEntries({ projectId: 'series' });
    expect(mara).toMatchObject({ name: 'Mara', projectId: 'series' });
    expect(await kind(lea.canon.apply('series', { change: 'add_fact', entryId: mara!.id, text: 'Mara has grey eyes.' }))).toBe('ok');
    // the Author, with a role on Book Four only, reads the whole series' canon and may propose, but not approve or apply
    expect((await ann.canon.listFacts({ projectId: 'b4' })).map((f) => f.text)).toEqual(['Mara has grey eyes.']);
    expect(await kind(ann.canon.apply('b4', { change: 'add_entry', kind: 'place', name: 'Harrow', summary: 'x' }))).toBe('denied');
    const prop = await ann.canon.propose('b4', { change: 'add_entry', kind: 'place', name: 'Harrow', summary: 'A town.' });
    expect(prop).toMatchObject({ state: 'open', projectId: 'series', proposedBy: expect.any(String) });
    expect(await kind(ann.canon.approve(prop.id))).toBe('denied');
    expect(await kind(ann.canon.reject(prop.id, 'no'))).toBe('denied');
    // the owner (who holds canon.approve everywhere) sees it waiting, and so does the Series Lead; the Author does not
    expect((await lea.canon.waitingForMe()).map((p) => p.id)).toEqual([prop.id]);
    expect((await ana.canon.waitingForMe()).map((p) => p.id)).toEqual([prop.id]);
    expect(await ann.canon.waitingForMe()).toEqual([]);
    expect(await kind(lea.canon.approve(prop.id))).toBe('ok');
    expect((await ann.canon.listEntries({ projectId: 'series' })).map((e) => e.name).sort()).toEqual(['Harrow', 'Mara']);
  });

  it('the proposer withdraws their own proposal; another Author cannot; a Series Lead can', async () => {
    const { person } = await studio();
    const lea = await person('Lea', 'role_series_lead', 'series');
    const ann = await person('Ann', 'role_author', 'b4');
    const bea = await person('Bea', 'role_author', 'b1');
    const mine = await ann.canon.propose('b4', { change: 'add_entry', kind: 'term', name: 'Quiet', summary: 'x' });
    expect(await kind(bea.canon.withdraw(mine.id))).toBe('denied');
    expect(await kind(ann.canon.withdraw(mine.id))).toBe('ok');
    const again = await ann.canon.propose('b4', { change: 'add_entry', kind: 'term', name: 'Quiet', summary: 'x' });
    expect(await kind(lea.canon.withdraw(again.id))).toBe('ok');
  });

  it('canon is the series: a book in another series, a role without canon.read, and someone assigned elsewhere are refused', async () => {
    const { person } = await studio();
    const lea = await person('Lea', 'role_series_lead', 'series');
    const fin = await person('Fin Finance', 'role_finance'); // Finance has no canon access
    const bob = await person('Bob Author', 'role_author', 'ob'); // a book of the other series
    await lea.canon.apply('series', { change: 'add_entry', kind: 'term', name: 'Quiet', summary: 'x' });
    expect(await kind(fin.canon.listEntries({ projectId: 'series' }))).toBe('denied');
    expect(await kind(bob.canon.listEntries({ projectId: 'series' }))).toBe('denied');
    expect(await kind(bob.canon.propose('series', { change: 'add_entry', kind: 'term', name: 'Mine', summary: 'x' }))).toBe('denied');
    expect(await kind(lea.canon.listEntries({ projectId: 'other' }))).toBe('denied'); // the Series Lead's role is on one series only
    expect(await kind(lea.canon.listEntries({ projectId: 'nope' }))).toBe('There is no such project.');
  });

  it('a book with no series above it is its own series', async () => {
    const { person } = await studio();
    const lea = await person('Lea', 'role_series_lead', 'solo');
    expect(await lea.canon.seriesOf('solo')).toEqual({ seriesId: 'solo', name: 'Standalone' });
    await lea.canon.apply('solo', { change: 'add_entry', kind: 'term', name: 'Quiet', summary: 'x' });
    expect((await lea.canon.listEntries({ projectId: 'solo' })).length).toBe(1);
    expect(await lea.canon.seriesOf('b4')).toEqual({ seriesId: 'series', name: 'Dragon Rider' });
  });
});

describe('continuity: who may run a check and who decides', () => {
  async function seeded() {
    const s = await studio();
    const lea = await s.person('Lea Lead', 'role_series_lead', 'series');
    const ann = await s.person('Ann Author', 'role_author', 'b4');
    const eve = await s.person('Eve Editor', 'role_editor', 'b4');
    const art = await s.person('Art Artist', 'role_artist', 'b4'); // can read canon, cannot propose
    await lea.canon.apply('series', { change: 'add_entry', kind: 'character', name: 'Mara', summary: 'x' });
    const [mara] = await lea.canon.listEntries({ projectId: 'series' });
    await lea.canon.apply('series', { change: 'add_fact', entryId: mara!.id, text: 'Mara has grey eyes.' });
    const [fact] = await lea.canon.listFacts({ projectId: 'series' });
    return { ...s, lea, ann, eve, art, fact: fact! };
  }
  const finding = (factId: string) => ({ kind: 'contradiction' as const, severity: 'high' as const, confidence: 'high' as const, body: 'Green, not grey.', anchor: makeAnchor(BOOK4, BOOK4.indexOf('green eyes'), BOOK4.indexOf('green eyes') + 10), factIds: [factId] });

  it('an Editor runs a check; the Author decides; an accepted finding becomes a proposal the Series Lead approves', async () => {
    const { eve, ann, lea, fact } = await seeded();
    const k = await eve.continuity.start({ projectId: 'b4', fileId: 'f4' });
    expect(k).toMatchObject({ projectId: 'b4', seriesId: 'series', fileVersion: 2, state: 'open' });
    const { raised } = await eve.continuity.raise(k.id, [finding(fact.id)]);
    expect(await kind(ann.continuity.raise(k.id, [finding(fact.id)]))).toBe('denied'); // not the finder, and cannot approve canon
    await eve.continuity.deliver(k.id);
    // the Author sees it and decides; the finding's accept makes a proposal; the Editor cannot approve it
    expect((await ann.continuity.findings({ checkId: k.id })).map((f) => f.id)).toEqual([raised[0]!.id]);
    const change = { change: 'supersede_fact', factId: fact.id, text: 'Mara has green eyes.', source: { fileId: 'f4', version: 2, anchor: raised[0]!.anchor }, bookProjectId: 'b4', chapter: 1 };
    const { proposal } = await ann.continuity.decide(raised[0]!.id, { outcome: 'accept_as_canon', change });
    expect(proposal).toMatchObject({ state: 'open', findingId: raised[0]!.id, projectId: 'series' });
    expect(await kind(eve.canon.approve(proposal!.id))).toBe('denied');
    expect((await lea.canon.waitingForMe()).map((p) => p.id)).toEqual([proposal!.id]);
    await lea.canon.approve(proposal!.id);
    expect((await lea.canon.listFacts({ projectId: 'series' })).map((f) => f.text)).toEqual(['Mara has green eyes.']);
    expect(await kind(ann.continuity.close(k.id))).toBe('ok');
  });

  it('a role that may read but not propose canon cannot start a check; a role with no assignment to the book cannot read it', async () => {
    const { art, db, person } = await seeded();
    expect(await kind(art.continuity.start({ projectId: 'b4', fileId: 'f4' }))).toBe('denied');
    const bob = await person('Bob', 'role_author', 'ob');
    expect(await kind(bob.continuity.start({ projectId: 'b4', fileId: 'f4' }))).not.toBe('ok');
    expect(await bob.continuity.list()).toEqual([]);
    void db;
  });

  it('checks a manuscript of the book it is started for, not another book’s', async () => {
    const { eve } = await seeded();
    expect(await kind(eve.continuity.start({ projectId: 'b4', fileId: 'f1' }))).toBe('That file belongs to another book.');
  });

  it('an Author on another book of the series cannot decide this book’s findings; the Series Lead can', async () => {
    const { eve, lea, person, fact } = await seeded();
    const bea = await person('Bea', 'role_author', 'b1');
    const k = await eve.continuity.start({ projectId: 'b4', fileId: 'f4' });
    const { raised } = await eve.continuity.raise(k.id, [finding(fact.id)]);
    await eve.continuity.deliver(k.id);
    expect(await kind(bea.continuity.decide(raised[0]!.id, { outcome: 'dismiss', reason: 'x' }))).not.toBe('ok');
    expect(await kind(lea.continuity.decide(raised[0]!.id, { outcome: 'dismiss', reason: 'Intended.' }))).toBe('ok');
  });
});
