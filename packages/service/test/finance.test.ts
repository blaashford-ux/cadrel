import { describe, expect, it } from 'vitest';
import { ROLE_KEYS, defaultRole, type Assignment, type RoleKey } from '@cadrel/kernel';
import { memoryStudioDb } from '@cadrel/store';
import { PermissionDenied, StudioService, type Access } from '../src/index';

const S = 'studio1';
const NOW = () => new Date('2026-11-17T10:00:00.000Z');
const roles = ROLE_KEYS.map((k) => defaultRole(k));
const A1 = 'B0AAAAAAA1';
const A2 = 'B0AAAAAAA2';
const A3 = 'B0AAAAAAA3';

/** A report for one month, as the finance code makes it for one book: only that book is in it. */
const report = (asin: string, month: string, usd: number) => ({ from: month, to: month, month, totals: { usd }, months: [{ month, usd }], books: [{ asin, title: `T ${asin}`, usd }] });

const people: [string, RoleKey][] = [['pub', 'finance'], ['ann', 'author'], ['bea', 'author'], ['cat', 'author'], ['dee', 'director'], ['ed', 'editor']];

async function studio() {
  const db = memoryStudioDb();
  const assignments: Assignment[] = [...people, ['boss', 'owner' as RoleKey]].map(([id, key]) => ({ id: `a-${id}`, subject: { kind: 'person', id: id! }, roleId: `role_${key}`, scope: { kind: 'studio', id: S } }));
  const access: Access = { assignments: () => assignments, roles: () => roles };
  const svc = new StudioService({ db, studioId: S, access, now: NOW });
  const boss = svc.as('boss');
  for (const [id] of [...people, ['boss']] as [string][]) await boss.people.create({ id, name: id });
  // book one: Ann alone; book two: written together by Ann and Bea (one of them under a pen name); book three: nobody credited
  const s = await boss.catalogue.createSeries({ name: 'Saga' });
  const b1 = await boss.catalogue.createBook({ title: 'One', seriesId: s.id });
  const b2 = await boss.catalogue.createBook({ title: 'Two', seriesId: s.id });
  const b3 = await boss.catalogue.createBook({ title: 'Three', seriesId: s.id });
  await boss.catalogue.addEdition(b1.id, { format: 'ebook', asin: A1 });
  await boss.catalogue.addEdition(b2.id, { format: 'ebook', asin: A2 });
  await boss.catalogue.addEdition(b3.id, { format: 'ebook', asin: A3 });
  const pen = await boss.people.createPenName({ displayName: 'B. Pen', personIds: ['bea'] });
  await boss.business.addCredit({ subject: { kind: 'book', id: b1.id }, personId: 'ann', role: 'author', placement: 'cover' });
  await boss.business.addCredit({ subject: { kind: 'book', id: b2.id }, personId: 'ann', role: 'author', placement: 'cover' });
  await boss.business.addCredit({ subject: { kind: 'book', id: b2.id }, penNameId: pen.id, role: 'co-author', placement: 'cover' });
  // the editor is credited, but as an editor: that is not owning the book
  await boss.business.addCredit({ subject: { kind: 'book', id: b1.id }, personId: 'ed', role: 'editor', placement: 'title-page' });
  const publish = (asin: string) => svc.as('pub').finance.publish({ asin, title: `T ${asin}`, months: [{ month: '2026-09', report: report(asin, '2026-09', 10) }, { month: '2026-10', report: report(asin, '2026-10', 20) }] });
  await publish(A1); await publish(A2); await publish(A3);
  return { svc, db, publish };
}
const denied = (p: Promise<unknown>) => p.then(() => false, (e) => e instanceof PermissionDenied);
const asins = async (svc: StudioService, who: string) => (await svc.as(who).finance.books()).map((b) => b.asin).sort();

describe('what the books earned, for the people who wrote them', () => {
  it('shows an author the books they wrote, and each of several authors the book they wrote together', async () => {
    const { svc } = await studio();
    expect(await asins(svc, 'ann')).toEqual([A1, A2]);
    expect(await asins(svc, 'bea')).toEqual([A2]); // credited through her pen name
    expect(await asins(svc, 'cat')).toEqual([]);
  });

  it('gives an author every month and nothing from a book they did not write', async () => {
    const { svc } = await studio();
    const months = await svc.as('bea').finance.book(A2);
    expect(months.map((m) => m.month)).toEqual(['2026-09', '2026-10']);
    expect(await denied(svc.as('bea').finance.book(A1))).toBe(true);
    expect(await denied(svc.as('cat').finance.book(A3))).toBe(true);
    expect(await denied(svc.as('ann').finance.book(A3))).toBe(true);
  });

  it('does not count a credit as editor, and gives nothing to a role that holds no royalties.read', async () => {
    const { svc } = await studio();
    await svc.as('boss').business.addCredit({ subject: { kind: 'book', id: (await svc.as('boss').catalogue.byAsin(A3))!.book.id }, personId: 'cat', role: 'editor', placement: 'title-page' });
    expect(await asins(svc, 'cat')).toEqual([]);
    expect(await denied(svc.as('ed').finance.books())).toBe(true);
  });

  it('shows the roles that manage or oversee royalties every book', async () => {
    const { svc } = await studio();
    for (const who of ['pub', 'dee', 'boss']) expect(await asins(svc, who), who).toEqual([A1, A2, A3]);
  });

  it('only lets those who manage royalties publish', async () => {
    const { svc } = await studio();
    for (const who of ['ann', 'dee', 'ed']) expect(await denied(svc.as(who).finance.publish({ asin: A1, months: [] })), who).toBe(true);
  });

  it('publishes a book again as a replacement, so a corrected or removed month is corrected or gone', async () => {
    const { svc, publish } = await studio();
    await svc.as('pub').finance.publish({ asin: A1, months: [{ month: '2026-10', report: report(A1, '2026-10', 25) }] });
    const months = await svc.as('ann').finance.book(A1);
    expect(months.map((m) => m.month)).toEqual(['2026-10']);
    expect((months[0]!.report as { totals: { usd: number } }).totals.usd).toBe(25);
    await publish(A1);
    expect((await svc.as('ann').finance.books()).find((b) => b.asin === A1)!.months).toEqual(['2026-10', '2026-09']);
  });

  it('refuses a report with another book in it, a bad ASIN and a bad month', async () => {
    const { svc } = await studio();
    const pub = svc.as('pub').finance;
    await expect(pub.publish({ asin: A1, months: [{ month: '2026-10', report: { ...report(A1, '2026-10', 1), books: [{ asin: A1 }, { asin: A2 }] } }] })).rejects.toThrow(/other books/);
    await expect(pub.publish({ asin: 'nope', months: [] })).rejects.toThrow(/ASIN/);
    await expect(pub.publish({ asin: A1, months: [{ month: '2026-13', report: report(A1, '2026-10', 1) }] })).rejects.toThrow(/2026-09/);
  });

  it('logs every read of a book’s figures', async () => {
    const { svc, db } = await studio();
    await svc.as('ann').finance.book(A1);
    const rows = await db.all<{ actor: string; target: string }>("SELECT actor, target FROM audit WHERE action = 'read.royalties'");
    expect(rows).toEqual([{ actor: 'ann', target: A1 }]);
  });
});
