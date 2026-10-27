import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library, booksOutsideScope, foldName, importSalesFile, inScope, listOwnBooks, reindexSales, removeBooksOutsideScope, scopeMatcher } from '../src/index.js';

const A = 'B0AAAAAAA1'; // Blake Ashford
const B = 'B0BBBBBBB2'; // Ashe Wilder
const C = 'B0CCCCCCC3'; // Wilder, Ashe  (the same pen name written the other way round)
const NOW = new Date('2026-10-22T12:00:00Z');

let root: string;
let lib: Library;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-scope-'));
  lib = Library.open(root);
});
afterEach(() => {
  lib.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function xlsx(sheets: Record<string, (string | number)[][]>): Uint8Array {
  const strings: string[] = [];
  const sst = (s: string) => { const i = strings.indexOf(s); if (i >= 0) return i; strings.push(s); return strings.length - 1; };
  const col = (i: number) => String.fromCharCode(65 + i);
  const files: Record<string, Uint8Array> = {};
  const names = Object.keys(sheets);
  names.forEach((n, k) => {
    const rows = sheets[n]!.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => (typeof v === 'number' ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="s"><v>${sst(v)}</v></c>`)).join('')}</row>`).join('');
    files[`xl/worksheets/sheet${k + 1}.xml`] = strToU8(`<worksheet><sheetData>${rows}</sheetData></worksheet>`);
  });
  files['xl/sharedStrings.xml'] = strToU8(`<sst>${strings.map((s) => `<si><t>${s.replace(/&/g, '&amp;')}</t></si>`).join('')}</sst>`);
  files['xl/workbook.xml'] = strToU8(`<workbook><sheets>${names.map((n, k) => `<sheet name="${n}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`).join('')}</sheets></workbook>`);
  files['xl/_rels/workbook.xml.rels'] = strToU8(`<Relationships>${names.map((_, k) => `<Relationship Id="rId${k + 1}" Target="worksheets/sheet${k + 1}.xml"/>`).join('')}</Relationships>`);
  return zipSync(files);
}
const EBOOK_HEAD = ['Royalty Date', 'Title', 'Author Name', 'ASIN', 'Marketplace', 'Royalty Type', 'Transaction Type', 'Units Sold', 'Units Refunded', 'Net Units Sold', 'Avg. List Price without tax', 'Avg. Offer Price without tax', 'Avg. File Size (MB)', 'Avg. Delivery Cost', 'Royalty', 'Currency'];
const ebook = (m: string, t: string, au: string, a: string, roy: number) => [m, t, au, a, 'Amazon.com', '70%', 'Standard', 5, 0, 5, 4.99, 4.99, 1, 0.1, roy, 'USD'];
const PHEAD = ['Sales Period - Start Date', 'Sales Period - End Date', 'Marketplace', 'Payment Number', 'Detail', 'Date', 'Payment Method', 'Currency', 'Accrued Royalty', 'Tax Withholding', 'Net Earnings', 'Source', 'FX Rate', 'Currency', 'Payout Amount', 'Payment Status'];

/** One KDP account with three pen names' books: what KDP's download looks like when the Studio publishes under only one of them. */
const workbook = (): Uint8Array => xlsx({
  Summary: [['Date', 'Royalty (USD)'], ['September 2026', 90]],
  'eBook Royalty': [EBOOK_HEAD, ebook('2026-09', 'Anthology', 'Blake Ashford', A, 30), ebook('2026-09', 'Lead Me', 'Ashe Wilder', B, 40), ebook('2026-09', 'Hold Me', 'Wilder, Ashe', C, 20)],
  'eBook Orders Placed': [['Date', 'Title', 'Author Name', 'ASIN', 'Marketplace', 'Paid Units', 'Free Units'], ['2026-09-20', 'Anthology', 'Blake Ashford', A, 'Amazon.com', 3, 0], ['2026-09-21', 'Lead Me', 'Ashe Wilder', B, 'Amazon.com', 2, 0], ['2026-09-22', 'Hold Me', 'Wilder, Ashe', C, 'Amazon.com', 1, 0]],
  'KENP Read': [['Date', 'Title', 'Author Name', 'ASIN', 'Marketplace', 'Kindle Edition Normalized Page (KENP) Read'], ['2026-09-03', 'Anthology', 'Blake Ashford', A, 'Amazon.com', 1000], ['2026-09-04', 'Lead Me', 'Ashe Wilder', B, 'Amazon.com', 500]]
});
/** The KDP payments report: whole-account lump sums, with no author in it. */
const payments = (): Uint8Array => xlsx({ Payments: [PHEAD, ['2026-09-01', '2026-09-30', 'Amazon.com', '1.0000154418274E14', '', '2026-10-29', 'WIRE', 'USD', 90, 4, 86, '', 'Pending info from Bank', 'NZD', 'Pending info from Bank', 'Paid'], ['', '', '', '', '2026-09', '', '', 'USD', 90, 4, 86, 'Sales', '', '', '', '']] });

const asins = () => (lib.db.prepare('SELECT asin FROM own_book ORDER BY asin').all() as { asin: string }[]).map((r) => r.asin);
const count = (t: string) => lib.db.scalar<number>(`SELECT COUNT(*) FROM ${t}`) ?? 0;

describe('a library limited to a Studio’s pen names', () => {
  it('compares names without case, accents or punctuation, and "Last, First" the other way round', () => {
    expect(foldName('  Ashe   WILDER ')).toBe('ashe wilder');
    expect(foldName('Zoë O’Neil-Smith')).toBe('zoe o neil smith');
    const m = scopeMatcher(['Ashe Wilder']);
    expect([m.inScope('Ashe Wilder'), m.inScope('wilder, ashe'), m.inScope('Ashe Wilder & Blake Ashford'), m.inScope('Blake Ashford'), m.inScope('')]).toEqual([true, true, true, false, null]);
    expect(scopeMatcher(null).inScope('Anyone')).toBe(true);
    expect(scopeMatcher([]).inScope('Ashe Wilder')).toBe(false);
  });

  it('brings in only the books under the Studio’s pen names: orders, pages read and royalties together', () => {
    const r = importSalesFile(lib.db, root, 'KDP.xlsx', workbook(), NOW, ['Ashe Wilder']);
    expect(asins()).toEqual([B, C]); // "Wilder, Ashe" is the same pen name
    expect((lib.db.prepare('SELECT DISTINCT asin FROM sales_day ORDER BY asin').all() as { asin: string }[]).map((x) => x.asin)).toEqual([B, C]);
    expect((lib.db.prepare('SELECT DISTINCT asin FROM kenp_day').all() as { asin: string }[]).map((x) => x.asin)).toEqual([B]);
    expect((lib.db.prepare('SELECT DISTINCT asin FROM royalty_month ORDER BY asin').all() as { asin: string }[]).map((x) => x.asin)).toEqual([B, C]);
    expect(r.excluded).toMatchObject({ books: 1, authors: ['Blake Ashford'], accountTotalsSkipped: true });
    expect(r.excluded!.rows).toBeGreaterThanOrEqual(3);
    expect(count('kdp_summary')).toBe(0); // KDP's monthly summary is the whole account's
  });

  it('keeps everything when nothing in the file belongs to anyone else, including the account totals', () => {
    const r = importSalesFile(lib.db, root, 'KDP.xlsx', workbook(), NOW, ['Ashe Wilder', 'Blake Ashford']);
    expect(asins()).toEqual([A, B, C]);
    expect(r.excluded).toEqual({ books: 0, rows: 0, authors: [], accountTotalsSkipped: false });
    expect(count('kdp_summary')).toBeGreaterThan(0);
  });

  it('is unchanged for a library with no scope', () => {
    const r = importSalesFile(lib.db, root, 'KDP.xlsx', workbook(), NOW, null);
    expect(asins()).toEqual([A, B, C]);
    expect(r.excluded).toBeUndefined();
    expect(count('kdp_summary')).toBeGreaterThan(0);
  });

  it('brings in nothing, and says why, for a Studio with no pen names', () => {
    const r = importSalesFile(lib.db, root, 'KDP.xlsx', workbook(), NOW, []);
    expect(asins()).toEqual([]);
    expect(count('sales_day') + count('kenp_day') + count('royalty_month')).toBe(0);
    expect(r).toMatchObject({ noPenNames: true, books: 0, excluded: { books: 3 } });
    expect(r.excluded!.authors.sort()).toEqual(['Ashe Wilder', 'Blake Ashford', 'Wilder, Ashe']);
  });

  it('leaves a payments report out when it cannot tell whose money it is, and keeps one that comes with a file showing nothing is anyone else’s', () => {
    const p = importSalesFile(lib.db, root, 'Payments.xlsx', payments(), NOW, ['Ashe Wilder']);
    expect(count('payment')).toBe(0);
    expect(p.excluded?.accountTotalsSkipped).toBe(true);
    importSalesFile(lib.db, root, 'Payments.xlsx', payments(), NOW, null);
    expect(count('payment')).toBe(1); // an unrestricted library keeps it, as before
  });

  it('keeps a book the library already holds (flagged by hand, no author) when a later file names it without an author', () => {
    lib.db.prepare("INSERT INTO own_book (asin, title, author, source, added_at) VALUES (?, 'Mine', NULL, 'manual', '2026-01-01')").run(A);
    const csv = new TextEncoder().encode(`Date,ASIN,Marketplace,Paid Units\n2026-09-20,${A},Amazon.com,3\n2026-09-20,${B},Amazon.com,9`);
    importSalesFile(lib.db, root, 'orders.csv', csv, NOW, ['Ashe Wilder']);
    expect((lib.db.prepare('SELECT DISTINCT asin FROM sales_day').all() as { asin: string }[]).map((x) => x.asin)).toEqual([A]); // B names no author and is not known: left out
  });

  it('filters the library’s listing and reading again from the saved reports in the same way', () => {
    importSalesFile(lib.db, root, 'KDP.xlsx', workbook(), NOW, null);
    expect(listOwnBooks(lib.db).map((b) => b.asin).sort()).toEqual([A, B, C]);
    expect(listOwnBooks(lib.db, ['Ashe Wilder']).map((b) => b.asin).sort()).toEqual([B, C]);
    expect(inScope({ penNames: [], authorNames: [] }, ['Ashe Wilder'])).toBe(true); // flagged by hand: the user's own
    lib.db.exec('DELETE FROM sales_day; DELETE FROM kenp_day; DELETE FROM royalty_month; DELETE FROM own_book;');
    expect(reindexSales(lib.db, root, ['Ashe Wilder'])).toBeGreaterThan(0);
    expect(asins()).toEqual([B, C]);
  });

  it('can remove what an earlier, unrestricted import left of other pen names, and nothing else', () => {
    importSalesFile(lib.db, root, 'KDP.xlsx', workbook(), NOW, null);
    importSalesFile(lib.db, root, 'Payments.xlsx', payments(), NOW, null);
    expect(booksOutsideScope(lib.db, ['Ashe Wilder']).map((b) => b.asin)).toEqual([A]);
    expect(booksOutsideScope(lib.db, null)).toEqual([]);
    expect(removeBooksOutsideScope(lib.db, root, ['Ashe Wilder'])).toBe(1);
    expect(asins()).toEqual([B, C]);
    expect((lib.db.prepare('SELECT DISTINCT asin FROM sales_day').all() as { asin: string }[]).map((x) => x.asin).sort()).toEqual([B, C]);
    expect(count('payment') + count('kdp_summary')).toBe(0); // account totals cannot be told apart, so they go with it
    expect(removeBooksOutsideScope(lib.db, root, ['Ashe Wilder'])).toBe(0);
  });
});
