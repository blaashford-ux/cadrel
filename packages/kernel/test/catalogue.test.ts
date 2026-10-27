import { beforeEach, describe, expect, it } from 'vitest';
import {
  CatalogueError, addEdition, bookByAsin, createBook, createIp, createSeries, getBook, getEdition, isId, listBooks, listIps, listSeries, moveBook, newRecordId, normalizeAsin, normalizeIsbn,
  bookProjectLinks, linkBookProject, setCatalogueArchived, updateBook, updateEdition, type Ctx
} from '../src/index';
import type { Db } from '../src/vault';
import { memoryDb } from './sqlite';

let db: Db;
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ studioId: 's1', actor: 'ana', now: '2026-10-27T10:00:00.000Z', ...over });
beforeEach(() => {
  db = memoryDb();
});
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof CatalogueError ? e.code : `other:${e}`));
const audits = () => db.all<{ actor: string; action: string; target: string }>('SELECT actor, action, target FROM audit ORDER BY id');

describe('ids', () => {
  it('are UUIDv7: valid, unique, and ordered by time', async () => {
    const a = newRecordId(1_700_000_000_000);
    const b = newRecordId(1_700_000_000_001);
    expect(isId(a)).toBe(true);
    expect(a[14]).toBe('7');
    expect(a < b).toBe(true);
    expect(new Set(Array.from({ length: 200 }, () => newRecordId())).size).toBe(200);
  });
});

describe('ASIN and ISBN', () => {
  it('normalises an ASIN and refuses a malformed one', () => {
    expect(normalizeAsin(' b0c1r52v2j ')).toBe('B0C1R52V2J');
    expect(normalizeAsin('')).toBeNull();
    expect(normalizeAsin(null)).toBeNull();
    expect(() => normalizeAsin('B0C1R52V2')).toThrow(CatalogueError);
    expect(() => normalizeAsin('B0C1R52V2!')).toThrow(/10 letters/);
  });
  it('checks ISBN digits and stores 13 digits, converting an ISBN-10', () => {
    expect(normalizeIsbn('978-0-306-40615-7')).toBe('9780306406157');
    expect(normalizeIsbn('0-306-40615-2')).toBe('9780306406157');
    expect(normalizeIsbn('080442957X')).toBe('9780804429573');
    expect(() => normalizeIsbn('978-0-306-40615-8')).toThrow(/check digit/);
    expect(() => normalizeIsbn('0306406153')).toThrow(/check digit/);
    expect(() => normalizeIsbn('12345')).toThrow(/10 or 13/);
    expect(normalizeIsbn(undefined)).toBeNull();
  });
});

describe('IP, series and books', () => {
  it('builds a series of three books with positions, and lists them in order', async () => {
    const ip = await createIp(db, ctx(), { name: 'The Salt Road', description: 'a world' });
    const series = await createSeries(db, ctx(), { name: 'Salt Road Trilogy', ipId: ip.id });
    const one = await createBook(db, ctx(), { title: 'Landfall', seriesId: series.id, penName: 'Ana Reyes' });
    const three = await createBook(db, ctx(), { title: 'Harvest', seriesId: series.id, position: 3 });
    const two = await createBook(db, ctx(), { title: 'Tidewater', seriesId: series.id, position: 2 });
    expect([one.position, two.position, three.position]).toEqual([1, 2, 3]);
    expect((await listBooks(db, ctx(), { seriesId: series.id })).map((b) => b.title)).toEqual(['Landfall', 'Tidewater', 'Harvest']);
    expect(one).toMatchObject({ studioId: 's1', penName: 'Ana Reyes', createdBy: 'ana', createdAt: '2026-10-27T10:00:00.000Z', archivedAt: null, editions: [] });
    expect((await listSeries(db, ctx(), { ipId: ip.id })).map((s) => s.name)).toEqual(['Salt Road Trilogy']);
    expect((await listIps(db, ctx())).map((i) => i.name)).toEqual(['The Salt Road']);
  });

  it('picks the next free position, allows a novella at 2.5, and refuses a taken position or a position without a series', async () => {
    const s = await createSeries(db, ctx(), { name: 'S' });
    const a = await createBook(db, ctx(), { title: 'A', seriesId: s.id });
    const b = await createBook(db, ctx(), { title: 'B', seriesId: s.id });
    const n = await createBook(db, ctx(), { title: 'Novella', seriesId: s.id, position: 1.5 });
    expect([a.position, b.position, n.position]).toEqual([1, 2, 1.5]);
    expect(await code(createBook(db, ctx(), { title: 'C', seriesId: s.id, position: 2 }))).toBe('exists');
    expect(await code(createBook(db, ctx(), { title: 'D', position: 2 }))).toBe('invalid');
    expect(await code(createBook(db, ctx(), { title: 'E', seriesId: s.id, position: 0 }))).toBe('invalid');
  });

  it('keeps names unique among live rows, ignoring case, but allows a name again once the other is archived', async () => {
    const ip = await createIp(db, ctx(), { name: 'World' });
    expect(await code(createIp(db, ctx(), { name: '  world ' }))).toBe('exists');
    expect(await code(createSeries(db, ctx(), { name: 'Same' }))).toBe('ok');
    expect(await code(createSeries(db, ctx(), { name: 'SAME' }))).toBe('exists');
    await setCatalogueArchived(db, ctx(), 'ip', ip.id, true);
    expect(await code(createIp(db, ctx(), { name: 'World' }))).toBe('ok');
    expect(await code(setCatalogueArchived(db, ctx(), 'ip', ip.id, false))).toBe('exists'); // the live one is in the way
    expect(await code(createIp(db, ctx(), { name: '   ' }))).toBe('invalid');
    expect(await code(createIp(db, ctx(), { name: 'x'.repeat(201) }))).toBe('invalid');
  });

  it('allows the same title in different series and outside any series, but not twice in one place', async () => {
    const s1 = await createSeries(db, ctx(), { name: 'One' });
    const s2 = await createSeries(db, ctx(), { name: 'Two' });
    expect(await code(createBook(db, ctx(), { title: 'Dawn', seriesId: s1.id }))).toBe('ok');
    expect(await code(createBook(db, ctx(), { title: 'Dawn', seriesId: s2.id }))).toBe('ok');
    expect(await code(createBook(db, ctx(), { title: 'Dawn' }))).toBe('ok');
    expect(await code(createBook(db, ctx(), { title: 'dawn', seriesId: s1.id }))).toBe('exists');
    expect(await code(createBook(db, ctx(), { title: 'DAWN' }))).toBe('exists');
  });

  it('refuses a series in a missing or archived IP, and a book in a missing or archived series', async () => {
    expect(await code(createSeries(db, ctx(), { name: 'X', ipId: 'nope' }))).toBe('not-found');
    const ip = await createIp(db, ctx(), { name: 'I' });
    await setCatalogueArchived(db, ctx(), 'ip', ip.id, true);
    expect(await code(createSeries(db, ctx(), { name: 'X', ipId: ip.id }))).toBe('archived');
    const s = await createSeries(db, ctx(), { name: 'S' });
    await setCatalogueArchived(db, ctx(), 'series', s.id, true);
    expect(await code(createBook(db, ctx(), { title: 'B', seriesId: s.id }))).toBe('archived');
    expect(await code(createBook(db, ctx(), { title: 'B', seriesId: 'nope' }))).toBe('not-found');
  });

  it('updates and moves a book, and audits both with the old values', async () => {
    const s = await createSeries(db, ctx(), { name: 'S' });
    const t = await createSeries(db, ctx(), { name: 'T' });
    const b = await createBook(db, ctx(), { title: 'Draft Title', seriesId: s.id });
    const u = await updateBook(db, ctx({ actor: 'bo', now: '2026-10-28T00:00:00.000Z' }), b.id, { title: 'Final Title' });
    expect(u).toMatchObject({ title: 'Final Title', updatedBy: 'bo', updatedAt: '2026-10-28T00:00:00.000Z', createdBy: 'ana' });
    const m = await moveBook(db, ctx(), b.id, t.id, 4);
    expect(m).toMatchObject({ seriesId: t.id, position: 4 });
    expect(await moveBook(db, ctx(), b.id, null)).toMatchObject({ seriesId: null, position: null });
    const log = await db.all<{ action: string; detail: string }>("SELECT action, detail FROM audit WHERE action LIKE 'catalogue.book.%' ORDER BY id");
    expect(log.map((l) => l.action)).toEqual(['catalogue.book.create', 'catalogue.book.update', 'catalogue.book.move', 'catalogue.book.move']);
    expect(JSON.parse(log[1]!.detail).from.title).toBe('Draft Title');
  });
});

describe('editions and the ASIN join', () => {
  it('adds editions by format, and finds the book from an ASIN', async () => {
    const b = await createBook(db, ctx(), { title: 'Landfall' });
    const e = await addEdition(db, ctx(), b.id, { format: 'ebook', asin: 'b0c1r52v2j', price: 4.99, publishedOn: '2026-11-01' });
    const p = await addEdition(db, ctx(), b.id, { format: 'paperback', isbn: '978-0-306-40615-7', price: 12.5, currency: 'gbp' });
    expect(e).toMatchObject({ format: 'ebook', asin: 'B0C1R52V2J', price: 4.99, currency: 'USD', publishedOn: '2026-11-01' });
    expect(p).toMatchObject({ isbn: '9780306406157', currency: 'GBP' });
    expect((await getBook(db, ctx(), b.id))!.editions.map((x) => x.format)).toEqual(['ebook', 'paperback']);
    const hit = await bookByAsin(db, ctx(), 'B0C1R52V2J');
    expect(hit!.book.title).toBe('Landfall');
    expect(hit!.edition.id).toBe(e.id);
    expect(await bookByAsin(db, ctx(), 'B0ZZZZZZZZ')).toBeNull();
    expect(await bookByAsin(db, ctx(), 'bad')).toBeNull();
  });

  it('keeps an ASIN with exactly one book, says which, and keeps it even when that edition is archived', async () => {
    const a = await createBook(db, ctx(), { title: 'First' });
    const b = await createBook(db, ctx(), { title: 'Second' });
    const e = await addEdition(db, ctx(), a.id, { format: 'ebook', asin: 'B0AAAAAAA1' });
    await expect(addEdition(db, ctx(), b.id, { format: 'ebook', asin: 'B0AAAAAAA1' })).rejects.toThrow(/belongs to “First”/);
    await setCatalogueArchived(db, ctx(), 'edition', e.id, true);
    expect(await code(addEdition(db, ctx(), b.id, { format: 'ebook', asin: 'B0AAAAAAA1' }))).toBe('exists');
    expect((await bookByAsin(db, ctx(), 'B0AAAAAAA1'))!.book.title).toBe('First'); // sales reported under it still join
  });

  it('allows one live edition per format and per ISBN, and edits an ASIN with the old value in the log', async () => {
    const a = await createBook(db, ctx(), { title: 'A' });
    const b = await createBook(db, ctx(), { title: 'B' });
    const e = await addEdition(db, ctx(), a.id, { format: 'ebook' });
    expect(e.asin).toBeNull();
    await expect(addEdition(db, ctx(), a.id, { format: 'ebook' })).rejects.toThrow(/already has a ebook edition/);
    await addEdition(db, ctx(), a.id, { format: 'paperback', isbn: '9780306406157' });
    await expect(addEdition(db, ctx(), b.id, { format: 'paperback', isbn: '0-306-40615-2' })).rejects.toThrow(/ISBN 9780306406157 already belongs to “A”/);
    const u = await updateEdition(db, ctx(), e.id, { asin: 'B0BBBBBBB2', price: 3.99 });
    expect(u).toMatchObject({ asin: 'B0BBBBBBB2', price: 3.99 });
    const cleared = await updateEdition(db, ctx(), e.id, { asin: null });
    expect(cleared.asin).toBeNull();
    const log = await db.all<{ detail: string }>("SELECT detail FROM audit WHERE action = 'catalogue.edition.update' ORDER BY id");
    expect(JSON.parse(log[0]!.detail).from.asin).toBeNull();
    expect(JSON.parse(log[1]!.detail).from.asin).toBe('B0BBBBBBB2');
    expect(await code(addEdition(db, ctx(), a.id, { format: 'vinyl' }))).toBe('invalid');
    expect(await code(addEdition(db, ctx(), a.id, { format: 'audiobook', price: -1 }))).toBe('invalid');
    expect(await code(addEdition(db, ctx(), a.id, { format: 'hardcover', publishedOn: '31/10/2026' }))).toBe('invalid');
    expect(await code(addEdition(db, ctx(), 'nope', { format: 'hardcover' }))).toBe('not-found');
  });
});

describe('archiving', () => {
  it('archiving an IP archives its series, books and editions together, and restoring takes back only what is asked', async () => {
    const ip = await createIp(db, ctx(), { name: 'World' });
    const s = await createSeries(db, ctx(), { name: 'S', ipId: ip.id });
    const b1 = await createBook(db, ctx(), { title: 'One', seriesId: s.id });
    const b2 = await createBook(db, ctx(), { title: 'Two', seriesId: s.id });
    const e = await addEdition(db, ctx(), b1.id, { format: 'ebook', asin: 'B0AAAAAAA1' });
    await setCatalogueArchived(db, ctx({ now: '2026-11-01T00:00:00.000Z' }), 'ip', ip.id, true);
    expect(await listBooks(db, ctx())).toEqual([]);
    expect((await listBooks(db, ctx(), { archived: true })).map((b) => b.title).sort()).toEqual(['One', 'Two']);
    expect((await getEdition(db, ctx(), e.id))!.archivedAt).toBe('2026-11-01T00:00:00.000Z');
    expect(await code(setCatalogueArchived(db, ctx(), 'series', s.id, false))).toBe('archived'); // its IP is still archived
    await setCatalogueArchived(db, ctx(), 'ip', ip.id, false);
    expect(await listSeries(db, ctx())).toEqual([]); // the IP came back, the series did not: restoring is only the record asked for
    await setCatalogueArchived(db, ctx(), 'series', s.id, false);
    expect(await code(setCatalogueArchived(db, ctx(), 'book', b1.id, false))).toBe('ok');
    expect((await listBooks(db, ctx(), { seriesId: s.id })).map((b) => b.title)).toEqual(['One']);
    expect(b2.id).toBeTruthy();
  });

  it('refuses to restore a book into an archived series, and an edition into an archived book', async () => {
    const s = await createSeries(db, ctx(), { name: 'S' });
    const b = await createBook(db, ctx(), { title: 'B', seriesId: s.id });
    const e = await addEdition(db, ctx(), b.id, { format: 'ebook' });
    await setCatalogueArchived(db, ctx(), 'series', s.id, true);
    expect(await code(setCatalogueArchived(db, ctx(), 'book', b.id, false))).toBe('archived');
    expect(await code(setCatalogueArchived(db, ctx(), 'edition', e.id, false))).toBe('archived');
    expect(await code(updateBook(db, ctx(), b.id, { title: 'X' }))).toBe('archived');
    expect(await code(setCatalogueArchived(db, ctx(), 'book', 'nope', true))).toBe('not-found');
  });
});

describe('studios and the audit log', () => {
  it('keeps one studio’s records out of another’s reach', async () => {
    const mine = await createBook(db, ctx(), { title: 'Mine' });
    const other = ctx({ studioId: 's2' });
    expect(await getBook(db, other, mine.id)).toBeNull();
    expect(await listBooks(db, other)).toEqual([]);
    expect(await code(updateBook(db, other, mine.id, { title: 'Stolen' }))).toBe('not-found');
    expect(await code(addEdition(db, other, mine.id, { format: 'ebook' }))).toBe('not-found');
    await addEdition(db, ctx(), mine.id, { format: 'ebook', asin: 'B0AAAAAAA1' });
    expect(await bookByAsin(db, other, 'B0AAAAAAA1')).toBeNull();
    // the same name and ASIN are fine in a different studio
    const theirs = await createBook(db, other, { title: 'Mine' });
    expect(await code(addEdition(db, other, theirs.id, { format: 'ebook', asin: 'B0AAAAAAA1' }))).toBe('ok');
  });

  it('writes one audit row per change, by the actor, and none for a change that failed', async () => {
    const ip = await createIp(db, ctx({ actor: 'ana' }), { name: 'World' });
    await createSeries(db, ctx({ actor: 'bo' }), { name: 'S', ipId: ip.id });
    await code(createIp(db, ctx({ actor: 'cy' }), { name: 'world' }));
    await code(createSeries(db, ctx({ actor: 'cy' }), { name: 'X', ipId: 'nope' }));
    const log = await audits();
    expect(log.map((l) => [l.actor, l.action])).toEqual([['ana', 'catalogue.ip.create'], ['bo', 'catalogue.series.create']]);
    expect(log[0]!.target).toBe(ip.id);
  });
});

describe('the project a book is made in', () => {
  it('links a book to one project and a project to one book, and unlinks', async () => {
    const a = await createBook(db, ctx(), { title: 'A' });
    const b = await createBook(db, ctx(), { title: 'B' });
    await linkBookProject(db, ctx(), a.id, 'proj1');
    expect(await bookProjectLinks(db, ctx())).toEqual([{ bookId: a.id, projectId: 'proj1' }]);
    expect(await code(linkBookProject(db, ctx(), b.id, 'proj1'))).toBe('exists'); // that project is taken
    await linkBookProject(db, ctx(), a.id, 'proj2'); // relinking replaces
    expect(await bookProjectLinks(db, ctx())).toEqual([{ bookId: a.id, projectId: 'proj2' }]);
    await linkBookProject(db, ctx(), b.id, 'proj1'); // free now
    await linkBookProject(db, ctx(), a.id, null);
    expect((await bookProjectLinks(db, ctx())).map((l) => l.bookId)).toEqual([b.id]);
    expect(await code(linkBookProject(db, ctx(), 'nope', 'p'))).toBe('not-found');
    expect((await audits()).map((x) => x.action).filter((x) => x.startsWith('book.') && x !== 'book.create')).toEqual(['book.link', 'book.link', 'book.link', 'book.unlink']);
  });
  it('is separate by studio', async () => {
    const a = await createBook(db, ctx(), { title: 'A' });
    await linkBookProject(db, ctx(), a.id, 'p');
    expect(await bookProjectLinks(db, ctx({ studioId: 's2' }))).toEqual([]);
  });
});
