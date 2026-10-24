import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library, authorNamesOf, categoryBooks, getBook, getOwnBook, importSalesFile, isAuthorRole, listBooks, listOwnBooks, splitPenNames } from '../src/index.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const read = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');

describe('authorNamesOf', () => {
  const credits = [
    { name: 'Ann Writer', authorId: 'A1', role: 'Author' },
    { name: 'Bo Coauthor', authorId: 'A2', role: 'Author' },
    { name: 'Ed Itor', authorId: null, role: 'Editor' },
    { name: 'Ill Ustrator', authorId: null, role: 'Illustrator' },
    { name: 'Dual Role', authorId: null, role: 'Author Illustrator' },
    { name: 'No Role', authorId: null, role: null },
    { name: 'Foreword Person', authorId: null, role: 'Foreword' },
    { name: 'Ann Writer', authorId: 'A1', role: 'Author' },
  ];
  it('keeps every author of a collaboration, in order, and drops editors, illustrators and other roles', () => {
    expect(authorNamesOf(credits)).toEqual(['Ann Writer', 'Bo Coauthor', 'Dual Role', 'No Role']);
    expect(authorNamesOf(JSON.stringify(credits))).toEqual(['Ann Writer', 'Bo Coauthor', 'Dual Role', 'No Role']);
  });
  it('copes with nothing, bad JSON and odd entries', () => {
    expect(authorNamesOf(null)).toEqual([]);
    expect(authorNamesOf('not json')).toEqual([]);
    expect(authorNamesOf('{"a":1}')).toEqual([]);
    expect(authorNamesOf([{ name: '  ', role: 'Author' }, { name: 'Ok', role: 'AUTHOR' }] as never)).toEqual(['Ok']);
    expect(isAuthorRole('Editor')).toBe(false);
    expect(isAuthorRole('Contributor')).toBe(false);
    expect(isAuthorRole('Author')).toBe(true);
    expect(isAuthorRole(null)).toBe(true);
  });
});

describe('splitPenNames', () => {
  it('splits a collaboration written the usual ways', () => {
    expect(splitPenNames('Ann Writer & Bo Coauthor')).toEqual(['Ann Writer', 'Bo Coauthor']);
    expect(splitPenNames('Ann Writer and Bo Coauthor')).toEqual(['Ann Writer', 'Bo Coauthor']);
    expect(splitPenNames('Ann Writer; Bo Coauthor')).toEqual(['Ann Writer', 'Bo Coauthor']);
    expect(splitPenNames('Ann Writer, Bo Coauthor, Cy Third')).toEqual(['Ann Writer', 'Bo Coauthor', 'Cy Third']);
    expect(splitPenNames('Ann Writer / Bo Coauthor')).toEqual(['Ann Writer', 'Bo Coauthor']);
  });
  it('keeps one name as one: Last, First and names containing "and"', () => {
    expect(splitPenNames('Writer, Ann')).toEqual(['Writer, Ann']);
    expect(splitPenNames('Sandy Anderson')).toEqual(['Sandy Anderson']);
    expect(splitPenNames('Ann Writer')).toEqual(['Ann Writer']);
    expect(splitPenNames('ann writer & Ann Writer')).toEqual(['ann writer']); // repeats collapse
    expect(splitPenNames('')).toEqual([]);
    expect(splitPenNames(null)).toEqual([]);
  });
});

describe('collaborations through the library', () => {
  let root: string;
  let lib: Library;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'bookscout-au-')); lib = Library.open(root); });
  afterEach(() => { lib.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const ASIN = 'B0H7QRHNJR'; // a fixture page with two authors
  it('shows both authors of a captured collaboration (and not its editors) in the Library, categories and book detail', () => {
    lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${ASIN}`, html: read(`detail-kindle-${ASIN}.html.gz`), capturedAt: '2026-10-18T12:00:00Z' });
    const raw = JSON.parse(lib.db.scalar<string>('SELECT authors FROM snapshot WHERE asin = ?', ASIN)!) as { name: string; role: string | null }[];
    expect(raw.length).toBeGreaterThanOrEqual(2);
    // pretend the page also credited an editor and an illustrator
    lib.db.prepare('UPDATE snapshot SET authors = ? WHERE asin = ?').run(JSON.stringify([...raw, { name: 'Ed Itor', authorId: null, role: 'Editor' }, { name: 'Ill Ustrator', authorId: null, role: 'Illustrator' }]), ASIN);
    const expected = raw.filter((r) => !r.role || /author/i.test(r.role)).map((r) => r.name);
    expect(expected.length).toBeGreaterThanOrEqual(2);
    expect(listBooks(lib.db).find((b) => b.asin === ASIN)!.authorNames).toEqual(expected);
    expect(getBook(lib.db, ASIN)!.authorNames).toEqual(expected);

    // flagged as the user's own: the pen names are the authors; a report's wording wins when there is one
    lib.db.prepare("INSERT INTO own_book (asin, title, author, source, added_at) VALUES (?, 'T', NULL, 'manual', '2026-10-18T00:00:00Z')").run(ASIN);
    expect(getOwnBook(lib.db, ASIN)).toMatchObject({ authorNames: expected, penNames: expected });
    importSalesFile(lib.db, root, 'orders.csv', new TextEncoder().encode(`Date,Title,Author Name,ASIN,Marketplace,Paid Units\n2026-10-16,T,Ann Writer & Bo Coauthor,${ASIN},Amazon.com,3`));
    // the report did not fill an author in because the book already existed with none: it does now
    expect(getOwnBook(lib.db, ASIN)!.penNames).toEqual(['Ann Writer', 'Bo Coauthor']);
    expect(listOwnBooks(lib.db)[0]!.authorNames).toEqual(expected);
  });

  it('names the authors of a collaboration in a report-created book that is not captured yet', () => {
    importSalesFile(lib.db, root, 'orders.csv', new TextEncoder().encode(`Date,Title,Author Name,ASIN,Marketplace,Paid Units\n2026-10-16,Joint Book,"Ann Writer, Bo Coauthor",B0AAAAAAAA,Amazon.com,3`));
    expect(getOwnBook(lib.db, 'B0AAAAAAAA')).toMatchObject({ penNames: ['Ann Writer', 'Bo Coauthor'], authorNames: [], snapshots: 0 });
  });

  it('category books carry every author, so exports and reports show the collaboration', () => {
    lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: read('bestsellers-kindle-humorous-fantasy.html.gz'), capturedAt: '2026-10-18T12:00:00Z' });
    lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${ASIN}`, html: read(`detail-kindle-${ASIN}.html.gz`), capturedAt: '2026-10-18T13:00:00Z' });
    const books = categoryBooks(lib.db, 'amazon.com:kindle:11650864011');
    const b = books.find((x) => x.asin === ASIN);
    if (b) expect(b.author).toBe(authorNamesOf(lib.db.scalar<string>('SELECT authors FROM snapshot WHERE asin = ?', ASIN)).join(', '));
    expect(books.every((x) => x.author === null || typeof x.author === 'string')).toBe(true);
  });
});
