import { beforeEach, describe, expect, it } from 'vitest';
import { addContribution, addCredit, addEdition, addRights, addShare, createBook, createPenName, createPerson, createSeries, deleteBook, getBook, linkBookProject, listBooks, listContributions, setCatalogueArchived, type Ctx } from '../src/index';
import type { Db } from '../src/vault';
import { memoryDb } from './sqlite';

let db: Db;
const c = (over: Partial<Ctx> = {}): Ctx => ({ studioId: 's1', actor: 'ana', now: '2026-11-10T10:00:00.000Z', ...over });

/** Every text value in every table of the file, to look for a leftover. */
async function everything(): Promise<string> {
  const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  const out: string[] = [];
  for (const t of tables) out.push(JSON.stringify(await db.all(`SELECT * FROM "${t.name}"`)));
  return out.join('\n');
}

beforeEach(() => {
  db = memoryDb();
});

describe('deleting a book added by mistake', () => {
  it('leaves nothing of it in the records, and nothing else changes', async () => {
    const ana = (await createPerson(db, c(), { name: 'Ana Reyes' })).id;
    const pen = await createPenName(db, c(), { displayName: 'Mara Quinn' });
    const s = await createSeries(db, c(), { name: 'Dragon Rider' });
    const keep = await createBook(db, c(), { title: 'Keeper', seriesId: s.id, position: 1 });
    await addEdition(db, c(), keep.id, { format: 'ebook', asin: 'B0KEEPKEEP' });
    const bad = await createBook(db, c(), { title: 'Mistaken Title', seriesId: s.id, position: 2 });
    const ebook = await addEdition(db, c(), bad.id, { format: 'ebook', asin: 'B0BADBAD01', isbn: '9780306406157' });
    await addEdition(db, c(), bad.id, { format: 'paperback', asin: 'B0BADBAD02' });
    await linkBookProject(db, c(), bad.id, 'proj-mistake');
    const book = { kind: 'book' as const, id: bad.id };
    await addContribution(db, c(), { subject: book, personId: ana, role: 'author' });
    await addCredit(db, c(), { subject: { kind: 'edition', id: ebook.id }, penNameId: pen.id, role: 'author', placement: 'cover' });
    await addRights(db, c(), { subject: book, holderName: 'Mistaken Press', kind: 'licensed-out', right: 'print' });
    await addShare(db, c(), { subject: book, personId: ana, shareBp: 5000, fromDate: '2026-01-01' });
    await setCatalogueArchived(db, c(), 'book', bad.id, true); // log rows of every kind about it

    const gone = await deleteBook(db, c({ actor: 'bo', now: '2026-11-11T10:00:00.000Z' }), bad.id);
    expect(gone.asins.sort()).toEqual(['B0BADBAD01', 'B0BADBAD02']);
    expect(await getBook(db, c(), bad.id)).toBeNull();
    const rest = await everything();
    for (const needle of [bad.id, ebook.id, 'Mistaken Title', 'B0BADBAD01', 'B0BADBAD02', '9780306406157', 'proj-mistake', 'Mistaken Press']) expect(rest).not.toContain(needle);
    // the other book, the series, the person and the pen name are untouched
    expect((await listBooks(db, c())).map((b) => b.title)).toEqual(['Keeper']);
    expect(rest).toContain('B0KEEPKEEP');
    expect(rest).toContain('Mara Quinn');
    expect(await listContributions(db, c(), { subject: book })).toEqual([]);
    // the only trace is that someone deleted a book: who and when, and no name
    const trace = await db.all<{ actor: string; action: string; detail: string }>("SELECT actor, action, detail FROM audit WHERE action = 'catalogue.book.delete'");
    expect(trace).toEqual([{ actor: 'bo', action: 'catalogue.book.delete', detail: '{}' }]);
  });

  it('says so when the book is not there', async () => {
    await expect(deleteBook(db, c(), 'nope')).rejects.toMatchObject({ code: 'not-found' });
  });
});
