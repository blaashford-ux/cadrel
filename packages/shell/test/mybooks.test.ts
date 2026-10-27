import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MyBooksError, bookPage, financeAccess, listBooks, saveBook, type BookService } from '../src/main/mybooks';
import { AppService } from '@cadrel/market-desktop/src/main/service';

const A = 'B0AAAAAAA1';
const B = 'B0BBBBBBB2';

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

const HEAD = ['Royalty Date', 'Title', 'Author Name', 'ASIN', 'Marketplace', 'Royalty Type', 'Transaction Type', 'Units Sold', 'Units Refunded', 'Net Units Sold', 'Royalty', 'Currency'];
const row = (m: string, t: string, au: string, a: string, mk: string, u: number, roy: number, c: string) => [m, t, au, a, mk, '70%', 'Standard', u, 0, u, roy, c];

const workbook = () => xlsx({
  'Summary': [['Date', 'Royalty (USD)', 'Royalty (GBP)'], ['September 2026', 40.5, 7], ['August 2026', 10, 0]],
  'eBook Royalty': [HEAD, row('2026-09', 'Anthology', 'Blake Ashford', A, 'Amazon.com', 10, 30, 'USD'), row('2026-09', 'Anthology', 'Blake Ashford', A, 'Amazon.co.uk', 2, 5, 'GBP'), row('2026-08', 'Lead Me', 'Ashe Wilder', B, 'Amazon.com', 4, 10, 'USD')],
  'KENP Read': [['Date', 'Title', 'Author Name', 'ASIN', 'Marketplace', 'Kindle Edition Normalized Page (KENP) Read'], ['2026-09-03', 'Anthology', 'Blake Ashford', A, 'Amazon.com', 2100], ['2026-09-04', 'Anthology', 'Blake Ashford', A, 'Amazon.co.uk', 500]],
});


let tmp: string, svc: AppService;
beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-mybooks-'));
  svc = new AppService({ userData: path.join(tmp, 'user'), openExternal: () => {}, revealInFolder: () => {} });
  await svc.setLibrary(path.join(tmp, 'lib'));
});
afterEach(async () => {
  await svc.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The real service, except that the library has no captured category lists (a capture needs the browser extension). */
const withCategory = (): BookService => ({
  status: () => svc.status(), ownBooks: () => svc.ownBooks(), ownBook: (a) => svc.ownBook(a), book: (a) => svc.book(a), cover: (a) => svc.cover(a),
  moneyMonths: () => svc.moneyMonths(), moneyAnalysis: (f, t) => svc.moneyAnalysis(f, t), bookSplit: (a) => svc.bookSplit(a), statement: (f, t, b) => svc.statement(f, t, b),
  statementFile: (f, t, k, p, b) => svc.statementFile(f, t, k, p, b), bookEarningsFile: (a, m) => svc.bookEarningsFile(a, m),
  bookLists: () => [{ key: 'romance', name: 'Romance' }],
  exportContent: async (key, kind) => ({ filename: `${key}.${kind}`, content: `category ${key} as ${kind}` })
});

const seed = () => {
  svc.importSales('KDP Orders.xlsx', workbook());
  const blake = svc.savePerson({ name: 'Blake Ashford' });
  const loric = svc.savePerson({ name: 'Loric Thorne' });
  svc.setBookSplit(A, [{ personId: blake.id, pct: 70 }, { personId: loric.id, pct: 30 }]);
};

describe('who sees the figures', () => {
  it('shows Finance to owner, admin, director and finance, and to no one else (an author sees only their own books, which cannot be told yet)', () => {
    for (const r of ['owner', 'admin', 'director', 'finance']) expect(financeAccess(r), r).toBe(true);
    for (const r of ['author', 'editor', 'series_lead', 'art_director', 'artist', 'marketing', 'analyst', 'guest', 'member', '', null, undefined]) expect(financeAccess(r as string), String(r)).toBe(false);
  });
});

describe('My Books list and page', () => {
  it('says nothing is available before Market has a library', async () => {
    const empty = new AppService({ userData: path.join(tmp, 'user2'), openExternal: () => {}, revealInFolder: () => {} });
    expect(listBooks(empty, true)).toEqual({ available: false, books: [], financeVisible: true });
    expect(bookPage(empty, A, true)).toBeNull();
    await empty.stop();
  });

  it('lists the studio’s books with figures only when Finance is visible, and absent (not zero) when it is not', () => {
    seed();
    const full = listBooks(svc, true);
    const a = full.books.find((b) => b.asin === A)!;
    expect(a).toMatchObject({ title: 'Anthology', captured: false });
    expect(a.money).toMatchObject({ paidUnits: 0, kenpPages: 2600, lastMonth: '2026-09' });
    expect(a.money!.lastMonthUsd).toBeGreaterThan(30);
    const hidden = listBooks(svc, false);
    expect(hidden.financeVisible).toBe(false);
    expect(hidden.books.every((b) => b.money === null)).toBe(true);
    expect(JSON.stringify(hidden)).not.toMatch(/paidUnits|lastMonthUsd|kenpPages/);
  });

  it('builds a book page with its months, split and authors, labelled reported or estimated', () => {
    seed();
    const p = bookPage(svc, A, true)!;
    expect(p.market).toMatchObject({ captured: false, categories: [] });
    expect(p.finance!.hasData).toBe(true);
    expect(p.finance!.months.map((m) => m.month)).toEqual(['2026-09']);
    expect(p.finance!.months[0]!.state).toBe('final');
    expect(p.finance!.split!.shares).toEqual([{ name: 'Blake Ashford', pct: 70 }, { name: 'Loric Thorne', pct: 30 }]);
    expect(p.finance!.payees).toEqual(['Blake Ashford', 'Loric Thorne']);
    expect(p.finance!.totalUsd).toBeCloseTo(svc.moneyAnalysis('2026-09', '2026-09').books.find((b) => b.asin === A)!.usd, 2);
  });

  it('leaves the finance section out entirely for a role without royalties', () => {
    seed();
    const p = bookPage(svc, A, false)!;
    expect(p.finance).toBeNull();
    expect(JSON.stringify(p)).not.toMatch(/totalUsd|paidUnits|split/);
  });

  it('a book with no sales says so instead of showing zeros', () => {
    svc.setOwnBook('B0CCCCCCC3', true);
    const p = bookPage(svc, 'B0CCCCCCC3', true)!;
    expect(p.finance).toMatchObject({ hasData: false, months: [], totalUsd: 0, split: null });
    expect(bookPage(svc, 'B0ZZZZZZZ9', true)).toBeNull();
  });
});

describe('saving from My Books', () => {
  it('writes the same bytes Finance and Market write: the statement file is the one Finance’s generator makes', async () => {
    seed();
    const parent = path.join(tmp, 'out');
    const r = await saveBook(withCategory(), A, 'all', true, { parent, months: 12 });
    expect(path.basename(r.folder)).toBe(`Anthology (${A})`);
    const rel = r.files.map((f) => path.relative(r.folder, f).replace(/\\/g, '/')).sort();
    expect(rel).toContain('Market/romance.csv');
    expect(rel).toContain('Market/romance.md');
    expect(rel).toContain('Finance/Anthology earnings.csv');
    const stmt = svc.statementFile('2025-10', '2026-09', 'csv', 'Blake Ashford', 'earned');
    expect(rel).toContain(`Finance/${stmt.filename}`);
    expect(fs.readFileSync(path.join(r.folder, 'Finance', stmt.filename), 'utf8')).toBe(stmt.content);
    expect(fs.readFileSync(path.join(r.folder, 'Market', 'romance.csv'), 'utf8')).toBe('category romance as csv');
  });

  it('earnings CSV is made by the service, states the basis of every month, oldest first, and equals what My Books saves', async () => {
    seed();
    const f = svc.bookEarningsFile(A);
    expect(f.filename).toBe('Anthology earnings.csv');
    expect(f.content.split('\r\n')[0]).toBe('Month,Royalties (USD),eBook,Print,Kindle+,Units,KENP pages,Basis');
    expect(f.content).toMatch(/^2026-09,49\.39,[\d.]+,[\d.]+,[\d.]+,12,2600,reported by KDP$/m);
    expect(svc.bookEarningsFile('B0BBBBBBB2').content).not.toContain('2026-09');
    const r = await saveBook(withCategory(), A, 'finance', true, { parent: path.join(tmp, 'out') });
    expect(fs.readFileSync(path.join(r.folder, 'Finance', f.filename), 'utf8')).toBe(f.content);
  });

  it('a per-book analysis counts only that book', () => {
    seed();
    const all = svc.moneyAnalysis('2026-08', '2026-09');
    const one = svc.moneyAnalysis('2026-08', '2026-09', B);
    expect(all.books.map((b) => b.asin).sort()).toEqual([A, B].sort());
    expect(one.books.map((b) => b.asin)).toEqual([B]);
    expect(one.totals.usd).toBeCloseTo(10, 2);
    expect(one.marketplaces.map((m) => m.key)).toEqual(['amazon.com']);
    expect(() => svc.moneyAnalysis('2026-08', '2026-09', 'nope')).toThrow();
  });

  it('never overwrites: a second save of the same book goes to a new folder', async () => {
    seed();
    const parent = path.join(tmp, 'out');
    const one = await saveBook(withCategory(), A, 'finance', true, { parent });
    const two = await saveBook(withCategory(), A, 'finance', true, { parent });
    expect(two.folder).not.toBe(one.folder);
    expect(fs.readdirSync(parent)).toHaveLength(2);
  });

  it('refuses Finance files to a role without royalties, but still saves Market’s', async () => {
    seed();
    const parent = path.join(tmp, 'out');
    await expect(saveBook(withCategory(), A, 'finance', false, { parent })).rejects.toThrow(MyBooksError);
    const r = await saveBook(withCategory(), A, 'all', false, { parent });
    expect(r.files.every((f) => f.includes(`${path.sep}Market${path.sep}`))).toBe(true);
    expect(fs.existsSync(path.join(r.folder, 'Finance'))).toBe(false);
  });

  it('says what is missing instead of writing an empty folder', async () => {
    svc.setOwnBook('B0CCCCCCC3', true);
    const parent = path.join(tmp, 'out');
    await expect(saveBook(svc, 'B0CCCCCCC3', 'market', true, { parent })).rejects.toThrow(/none of the captured category lists/);
    await expect(saveBook(svc, 'B0CCCCCCC3', 'finance', true, { parent })).rejects.toThrow(/nothing to save/);
    expect(fs.existsSync(parent) ? fs.readdirSync(parent) : []).toEqual([]);
    await expect(saveBook(svc, 'B0ZZZZZZZ9', 'all', true, { parent })).rejects.toThrow(/not in My Books/);
  });
});
