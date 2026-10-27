import { beforeEach, describe, expect, it } from 'vitest';
import {
  BusinessError, addContribution, addCredit, addEdition, addRights, addShare, createBook, createIp, createPerson, createPenName, createSeries, exclusiveGrantOut, listContributions, listCredits, listRights, listShares, peakShare,
  rightsInForce, setBusinessArchived, shareTotalOn, updateContribution, updateCredit, updateRights, updateShare, type Ctx, type Subject
} from '../src/index';
import type { Db } from '../src/vault';
import { memoryDb } from './sqlite';

let db: Db, ana: string, bo: string, book: Subject, series: Subject;
const c = (over: Partial<Ctx> = {}): Ctx => ({ studioId: 's1', actor: 'ana', now: '2026-11-10T10:00:00.000Z', ...over });
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof BusinessError ? e.code : `other:${(e as Error).message}`));
beforeEach(async () => {
  db = memoryDb();
  ana = (await createPerson(db, c(), { name: 'Ana Reyes' })).id;
  bo = (await createPerson(db, c(), { name: 'Bo Lin' })).id;
  const s = await createSeries(db, c(), { name: 'Dragon Rider' });
  const b = await createBook(db, c(), { title: 'Lead Me', seriesId: s.id, position: 1 });
  book = { kind: 'book', id: b.id };
  series = { kind: 'series', id: s.id };
});

describe('contributions: who did what on what', () => {
  it('records work done on a book, a series or an edition, and lists it by subject or person', async () => {
    const ed = await addEdition(db, c(), book.id, { format: 'ebook', asin: 'B0AAAAAAA1' });
    const a = await addContribution(db, c(), { subject: book, personId: ana, role: 'author', description: 'Wrote it', startedOn: '2026-01-01', doneOn: '2026-06-30' });
    await addContribution(db, c(), { subject: book, personId: bo, role: 'copy editor' });
    await addContribution(db, c(), { subject: { kind: 'edition', id: ed.id }, personId: bo, role: 'formatter' });
    await addContribution(db, c(), { subject: series, personId: ana, role: 'other', description: 'Series bible' });
    expect(a).toMatchObject({ subject: book, personId: ana, role: 'author', startedOn: '2026-01-01' });
    expect((await listContributions(db, c(), { subject: book })).map((x) => x.role)).toEqual(['author', 'copy editor']);
    expect((await listContributions(db, c(), { personId: bo })).map((x) => x.role).sort()).toEqual(['copy editor', 'formatter']);
    expect(await listContributions(db, c({ studioId: 's2' }))).toEqual([]);
  });
  it('checks what it is given, and keeps changes and archives', async () => {
    expect(await code(addContribution(db, c(), { subject: { kind: 'book', id: 'ghost' }, personId: ana, role: 'author' }))).toBe('not-found');
    expect(await code(addContribution(db, c(), { subject: { kind: 'planet' as never, id: 'x' }, personId: ana, role: 'author' }))).toBe('invalid');
    expect(await code(addContribution(db, c(), { subject: book, personId: 'ghost', role: 'author' }))).toBe('not-found');
    expect(await code(addContribution(db, c(), { subject: book, personId: ana, role: 'wizard' }))).toBe('invalid');
    expect(await code(addContribution(db, c(), { subject: book, personId: ana, role: 'author', startedOn: '2026-05-01', doneOn: '2026-04-01' }))).toBe('invalid');
    expect(await code(addContribution(db, c(), { subject: book, personId: ana, role: 'author', startedOn: '2026-02-30' }))).toBe('invalid');
    const x = await addContribution(db, c(), { subject: book, personId: ana, role: 'author' });
    expect((await updateContribution(db, c(), x.id, { doneOn: '2026-07-01', role: 'co-author' })).role).toBe('co-author');
    await setBusinessArchived(db, c(), 'contribution', x.id, true);
    expect(await listContributions(db, c(), { subject: book })).toEqual([]);
    expect((await listContributions(db, c(), { subject: book, archived: true })).map((r) => r.id)).toEqual([x.id]);
    await setBusinessArchived(db, c(), 'contribution', x.id, false);
    expect(await listContributions(db, c(), { subject: book })).toHaveLength(1);
  });
});

describe('credits: how someone is named, and where', () => {
  it('names a person or a pen name, shows the pen name, lets the name be overridden, and orders by placement', async () => {
    const pen = await createPenName(db, c(), { displayName: 'Ashe Wilder', personIds: [ana] });
    const t = await addCredit(db, c(), { subject: book, penNameId: pen.id, role: 'author', placement: 'title-page' });
    const cv = await addCredit(db, c(), { subject: book, penNameId: pen.id, role: 'author', placement: 'cover', position: 1 });
    await addCredit(db, c(), { subject: book, personId: bo, role: 'editor', placement: 'cover', position: 0, displayAs: 'B. Lin' });
    expect(t.name).toBe('Ashe Wilder');
    expect((await listCredits(db, c(), { subject: book })).map((x) => [x.placement, x.name])).toEqual([['cover', 'B. Lin'], ['cover', 'Ashe Wilder'], ['title-page', 'Ashe Wilder']]);
    expect((await updateCredit(db, c(), cv.id, { displayAs: 'A. Wilder', placement: 'listing' })).name).toBe('A. Wilder');
  });
  it('names exactly one of a person and a pen name, and is not a contribution or a share', async () => {
    const pen = await createPenName(db, c(), { displayName: 'P', personIds: [ana] });
    expect(await code(addCredit(db, c(), { subject: book, role: 'author', placement: 'cover' }))).toBe('invalid');
    expect(await code(addCredit(db, c(), { subject: book, personId: ana, penNameId: pen.id, role: 'author', placement: 'cover' }))).toBe('invalid');
    expect(await code(addCredit(db, c(), { subject: book, penNameId: 'ghost', role: 'author', placement: 'cover' }))).toBe('not-found');
    expect(await code(addCredit(db, c(), { subject: book, personId: ana, role: 'author', placement: 'moon' }))).toBe('invalid');
    expect(await code(addCredit(db, c(), { subject: book, personId: ana, role: 'author', placement: 'cover', position: -1 }))).toBe('invalid');
    // credit is not contribution: crediting someone does not record that they did anything, and vice versa
    await addCredit(db, c(), { subject: book, personId: ana, role: 'author', placement: 'cover' });
    expect(await listContributions(db, c(), { subject: book })).toEqual([]);
    expect(await listShares(db, c(), { subject: book })).toEqual([]);
  });
});

describe('rights: who owns or licenses what', () => {
  it('records grants to a person or an outside party, in force by date, and finds an exclusive grant', async () => {
    const own = await addRights(db, c(), { subject: book, holderPersonId: ana, kind: 'owned', right: 'all' });
    const aud = await addRights(db, c(), { subject: book, holderName: 'Audible Studios', kind: 'licensed-out', right: 'audio', territory: 'UK, Ireland', language: 'en', startsOn: '2026-03-01', endsOn: '2028-02-29', exclusive: true, restrictions: 'No abridgement' });
    expect(aud).toMatchObject({ holderPersonId: null, holderName: 'Audible Studios', exclusive: true, territory: 'UK, Ireland', restrictions: 'No abridgement' });
    const all = await listRights(db, c(), { subject: book });
    expect(rightsInForce(all, '2026-02-01').map((r) => r.id)).toEqual([own.id]);
    expect(rightsInForce(all, '2027-01-01').map((r) => r.right).sort()).toEqual(['all', 'audio']);
    expect(rightsInForce(all, '2028-03-01').map((r) => r.id)).toEqual([own.id]);
    expect(exclusiveGrantOut(all, 'audio', '2027-01-01')?.holderName).toBe('Audible Studios');
    expect(exclusiveGrantOut(all, 'print', '2027-01-01')).toBeUndefined();
    expect((await updateRights(db, c(), aud.id, { endsOn: '2026-12-31' })).endsOn).toBe('2026-12-31');
    await setBusinessArchived(db, c(), 'rights', aud.id, true);
    expect((await listRights(db, c(), { subject: book })).map((r) => r.id)).toEqual([own.id]);
  });
  it('has one holder, valid kinds and periods', async () => {
    expect(await code(addRights(db, c(), { subject: book, kind: 'owned', right: 'all' }))).toBe('invalid');
    expect(await code(addRights(db, c(), { subject: book, holderPersonId: ana, holderName: 'X', kind: 'owned', right: 'all' }))).toBe('invalid');
    expect(await code(addRights(db, c(), { subject: book, holderName: 'X', kind: 'stolen', right: 'all' }))).toBe('invalid');
    expect(await code(addRights(db, c(), { subject: book, holderName: 'X', kind: 'owned', right: 'telepathy' }))).toBe('invalid');
    expect(await code(addRights(db, c(), { subject: book, holderName: 'X', kind: 'owned', right: 'all', startsOn: '2026-05-01', endsOn: '2026-01-01' }))).toBe('invalid');
    expect(rightsInForce([{ archivedAt: null, kind: 'reverted', startsOn: null, endsOn: null } as never], '2026-01-01')).toEqual([]); // reverted rights are not in force
  });
});

describe('revenue shares: who is paid what share', () => {
  const share = (over: Record<string, unknown> = {}) => ({ subject: book, personId: ana, shareBp: 6000, fromDate: '2026-01-01', ...over }) as Parameters<typeof addShare>[2];
  it('keeps shares as basis points and money as cents, and never lets live shares on a subject pass 100%', async () => {
    const a = await addShare(db, c(), share({ advanceMinor: 150000, currency: 'usd' }));
    expect(a).toMatchObject({ shareBp: 6000, advanceMinor: 150000, currency: 'USD', basis: 'net', toDate: null });
    await addShare(db, c(), share({ personId: bo, shareBp: 4000 }));
    expect(shareTotalOn(await listShares(db, c(), { subject: book }), '2026-06-01')).toBe(10000);
    expect(await code(addShare(db, c(), share({ personId: bo, shareBp: 1 })))).toBe('conflict'); // 100.01%
    await addShare(db, c(), share({ personId: bo, shareBp: 1, basis: 'profit' })); // a different pot
    expect(await code(updateShare(db, c(), a.id, { shareBp: 6001 }))).toBe('conflict');
    expect((await updateShare(db, c(), a.id, { shareBp: 5000 })).shareBp).toBe(5000);
  });
  it('checks overlap by day, so a share that starts later or ends earlier fits beside others', async () => {
    const a = await addShare(db, c(), share({ shareBp: 7000, toDate: '2026-06-30' }));
    await addShare(db, c(), share({ personId: bo, shareBp: 7000, fromDate: '2026-07-01' })); // starts the day after: no overlap
    expect(await code(addShare(db, c(), share({ personId: bo, shareBp: 4000, fromDate: '2026-06-15', toDate: '2026-07-15' })))).toBe('conflict'); // 110% on 1 July
    expect(await code(addShare(db, c(), share({ personId: bo, shareBp: 3000, fromDate: '2026-06-15', toDate: '2026-07-15' })))).toBe('ok'); // 70% + 30% before 1 July, 70% + 30% after: exactly 100% throughout
    expect(peakShare([a], { shareBp: 3000, fromDate: '2026-06-15', toDate: '2026-06-20', basis: 'net' })).toBe(10000);
    expect(peakShare([], { shareBp: 100, fromDate: '2026-01-01', toDate: null, basis: 'net' })).toBe(100);
  });
  it('refuses nonsense: fractions, zero, over 100%, negative advances, bad dates, other people’s subjects', async () => {
    for (const bad of [{ shareBp: 33.3 }, { shareBp: 0 }, { shareBp: 10001 }, { advanceMinor: -1 }, { advanceMinor: 1.5 }, { currency: 'dollars' }, { basis: 'vibes' }, { fromDate: '2026-13-01' }, { fromDate: '' }, { toDate: '2025-01-01' }]) expect(await code(addShare(db, c(), share(bad))), JSON.stringify(bad)).toBe('invalid');
    expect(await code(addShare(db, c({ studioId: 's2' }), share()))).toBe('not-found'); // the book is another studio's
  });
  it('archives and restores, and refuses a restore that would pass 100%', async () => {
    const a = await addShare(db, c(), share());
    await setBusinessArchived(db, c(), 'share', a.id, true);
    await addShare(db, c(), share({ personId: bo, shareBp: 9000 }));
    expect(await code(setBusinessArchived(db, c(), 'share', a.id, false))).toBe('conflict');
    expect(await code(setBusinessArchived(db, c(), 'share', 'ghost', true))).toBe('not-found');
    expect(await code(setBusinessArchived(db, c(), 'planet' as never, a.id, true))).toBe('invalid');
  });
  it('holds shares on series, IP and editions as well as books', async () => {
    const ip = await createIp(db, c(), { name: 'Dragons' });
    await addShare(db, c(), share({ subject: { kind: 'ip', id: ip.id }, shareBp: 10000 }));
    await addShare(db, c(), share({ subject: series, shareBp: 5000 }));
    expect((await listShares(db, c(), { subject: series })).map((s) => s.shareBp)).toEqual([5000]);
  });
});

describe('four concepts, four tables', () => {
  it('shares no column or reference between them: credit is not ownership, contribution is not share', async () => {
    const cols = async (t: string) => (await db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${t}')`)).map((r) => r.name);
    const [contribution, credit, rights, share] = await Promise.all([cols('contribution'), cols('credit'), cols('rights'), cols('revenue_share')]);
    expect(share).toContain('share_bp');
    for (const t of [contribution, credit, rights]) expect(t).not.toContain('share_bp');
    for (const t of [contribution, rights, share]) expect(t).not.toContain('placement');
    for (const t of [credit, contribution, share]) expect(t).not.toContain('territory');
    for (const t of [credit, contribution, rights]) expect(t).not.toContain('advance_minor');
    for (const t of ['contribution', 'credit', 'rights', 'revenue_share']) {
      const fks = (await db.all<{ table: string }>(`SELECT "table" FROM pragma_foreign_key_list('${t}')`)).map((r) => r.table);
      expect(fks.filter((x) => ['contribution', 'credit', 'rights', 'revenue_share'].includes(x)), t).toEqual([]); // none points at another of the four
    }
  });
  it('writes an audit row with every change', async () => {
    const x = await addContribution(db, c(), { subject: book, personId: ana, role: 'author' });
    await addShare(db, c(), { subject: book, personId: ana, shareBp: 5000, fromDate: '2026-01-01' });
    await setBusinessArchived(db, c(), 'contribution', x.id, true);
    expect((await db.all<{ action: string }>("SELECT action FROM audit WHERE action LIKE 'contribution.%' OR action LIKE 'share.%' ORDER BY id")).map((r) => r.action)).toEqual(['contribution.add', 'share.add', 'contribution.archive']);
  });
});
