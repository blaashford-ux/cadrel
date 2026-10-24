import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { zipSync, strToU8 } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Library, allocate, analysisReport, importSalesFile, kenpRates, monthReport, monthlyEarnings, parseRoyaltyFile, parseSalesFile, periodMonths, reportMonths,
  royaltyStatement, detectedAuthors, personForName, savePerson, setFxRate, setKenpRate, setSplit, splitHistory, statementCsv, statementHtml, deletePerson, listPeople, reindexSales, importUserData,
} from '../src/index.js';

const A = 'B0AAAAAAA1';
const B = 'B0BBBBBBB2';
const TODAY = new Date('2026-10-22T12:00:00Z');

let root: string;
let lib: Library;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bookscout-r-'));
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
const PAPER_HEAD = ['Royalty Date', 'Order Date', 'Title', 'Author Name', 'ISBN', 'Marketplace', 'Royalty Type', 'Transaction Type', 'Units Sold', 'Units Refunded', 'Net Units Sold', 'Avg. List Price without tax', 'Avg. Offer Price without tax', 'Avg. Manufacturing Cost', 'Royalty', 'Currency', 'ASIN'];
const ebook = (m: string, t: string, au: string, a: string, mk: string, rt: string, u: number, roy: number, cur: string) => [m, t, au, a, mk, rt, 'Standard', u, 0, u, 4.99, 4.99, 1, 0.1, roy, cur];

/** A workbook shaped like KDP's download: monthly royalties and Orders Processed, daily Orders Placed and KENP Read, and a Summary. */
function workbook(): Uint8Array {
  const combined = ['Royalty Date', 'Title', 'Author Name', 'ASIN/ISBN', 'Marketplace', 'Royalty Type', 'Transaction Type', 'Units Sold', 'Units Refunded', 'Net Units Sold', 'Avg. List Price without tax', 'Avg. Offer Price without tax', 'Avg. Delivery/Manufacturing cost', 'Royalty', 'Currency'];
  const eb = [
    ebook('2026-09', 'Anthology', 'Blake Ashford', A, 'Amazon.com', '70%', 10, 33.8, 'USD'),
    ebook('2026-09', 'Anthology', 'Blake Ashford', A, 'Amazon.co.uk', '70%', 2, 5, 'GBP'),
    ebook('2026-09', 'Lead Me', 'Ashe Wilder', B, 'Amazon.com', '35%', 1, 0.35, 'USD'),
    ebook('2026-10', 'Anthology', 'Blake Ashford', A, 'Amazon.com', '70%', 4, 13.52, 'USD'),
  ];
  return xlsx({
    'Summary': [
      ['Date', 'Paid Units Sold (eBook)', 'KENP', 'Royalty (USD)', 'Royalty (GBP)', 'Royalty (CAD)'],
      ['October 2026', 4, 200, 13.52, 0, 0],
      ['September 2026', 13, 1900, 41.65, 6.6, 5.96],
    ],
    'Combined Sales': [combined, ...eb.map((r) => [...r.slice(0, 12), 0.1, r[14]!, r[15]!]) ],
    'eBook Royalty': [EBOOK_HEAD, ...eb],
    'Paperback Royalty': [PAPER_HEAD, ['2026-09', '2026-09', 'Anthology', 'Blake Ashford', '9781067093679', 'Amazon.ca', '60%', 'Standard - Paperback', 1, 0, 1, 22.12, 22.12, 7.31, 5.96, 'CAD', '1067093672']],
    'Hardcover Royalty': [PAPER_HEAD],
    'Orders Processed': [['Date', 'Title', 'Author Name', 'ASIN', 'Marketplace', 'Paid Units', 'Free Units'], ['2026-09', 'Anthology', 'Blake Ashford', A, 'Amazon.com', 10, 0], ['2026-10', 'Anthology', 'Blake Ashford', A, 'Amazon.com', 4, 0]],
    'eBook Orders Placed': [['Date', 'Title', 'Author Name', 'ASIN', 'Marketplace', 'Paid Units', 'Free Units'], ['2026-10-20', 'Anthology', 'Blake Ashford', A, 'Amazon.com', 3, 0], ['2026-10-21', 'Anthology', 'Blake Ashford', A, 'Amazon.com', 1, 0]],
    'KENP Read': [
      ['Date', 'Title', 'Author Name', 'ASIN', 'Marketplace', 'Kindle Edition Normalized Page (KENP) Read'],
      ['2026-09-03', 'Anthology', 'Blake Ashford', A, 'Amazon.com', 1000],
      ['2026-09-04', 'Lead Me', 'Ashe Wilder', B, 'Amazon.com', 500],
      ['2026-09-05', 'Anthology', 'Blake Ashford', A, 'Amazon.co.uk', 400],
      ['2026-10-02', 'Anthology', 'Blake Ashford', A, 'Amazon.com', 200],
    ],
  });
}

const money = (n: number) => Math.round(n * 100) / 100;

describe('reading a KDP workbook', () => {
  it('does not take the monthly Orders Processed sheet for daily sales', () => {
    const p = parseSalesFile('KDP Orders.xlsx', workbook());
    expect(p.sheet).toBe('eBook Orders Placed');
    expect(p.rows.map((r) => [r.day, r.paidUnits])).toEqual([['2026-10-20', 3], ['2026-10-21', 1]]);
  });
  it('reads the per-format royalty sheets once (not also Combined Sales) and the Summary', () => {
    const p = parseRoyaltyFile('KDP Orders.xlsx', workbook());
    expect(p.rows).toHaveLength(5);
    expect(money(p.rows.reduce((a, r) => a + (r.currency === 'USD' ? r.royalty : 0), 0))).toBe(47.67);
    expect(p.rows.find((r) => r.format === 'paperback')).toMatchObject({ asin: '1067093672', month: '2026-09', marketplace: 'amazon.ca', currency: 'CAD', royalty: 5.96, royaltyType: '60%' });
    expect(p.summary.find((s) => s.month === '2026-09' && s.currency === 'USD')?.royalty).toBe(41.65);
  });
  it('imports everything, registers the books and replaces a month when it is imported again', () => {
    const r = importSalesFile(lib.db, root, 'KDP Orders.xlsx', workbook(), TODAY);
    expect(r.contains).toEqual(['orders', 'kenp', 'royalties']);
    expect(r.royaltyRows).toBe(5);
    expect(r.royaltyFrom).toBe('2026-09');
    expect(lib.db.scalar('SELECT count(*) FROM own_book')).toBe(2);
    importSalesFile(lib.db, root, 'KDP Orders.xlsx', workbook(), new Date('2026-10-23T12:00:00Z'));
    expect(lib.db.scalar('SELECT count(*) FROM royalty_month')).toBe(5);
    expect(lib.db.scalar('SELECT SUM(paid_units) FROM sales_day')).toBe(4);
  });
  it('rebuilds money from the saved files', () => {
    importSalesFile(lib.db, root, 'KDP Orders.xlsx', workbook(), TODAY);
    lib.db.exec('DELETE FROM royalty_month; DELETE FROM kdp_summary; DELETE FROM kenp_day;');
    reindexSales(lib.db, root);
    expect(lib.db.scalar('SELECT count(*) FROM royalty_month')).toBe(5);
    expect(lib.db.scalar('SELECT count(*) FROM kdp_summary')).toBe(6);
  });
});

describe('earnings', () => {
  beforeEach(() => { importSalesFile(lib.db, root, 'KDP Orders.xlsx', workbook(), TODAY); });

  it('prices KENP from Summary minus the royalty sheets once KDP has finalized the month', () => {
    const r = kenpRates(lib.db);
    expect(r.get('2026-09|USD')).toMatchObject({ state: 'final' });
    expect(r.get('2026-09|USD')!.rate).toBeCloseTo(0.005, 6);
    expect(r.get('2026-09|GBP')!.rate).toBeCloseTo(0.004, 6);
    // October has no KENP money yet: the last final rate stands in
    expect(r.get('2026-10|USD')).toMatchObject({ state: 'estimated' });
    expect(r.get('2026-10|USD')!.rate).toBeCloseTo(0.005, 6);
  });
  it('lists KENP money per book, leaving the current month pending', () => {
    const e = monthlyEarnings(lib.db, {}, TODAY);
    expect(e.find((x) => x.asin === A && x.month === '2026-09' && x.source === 'kenp' && x.currency === 'USD')).toMatchObject({ amount: 5, quantity: 1000, state: 'final' });
    expect(e.find((x) => x.asin === A && x.month === '2026-10' && x.source === 'kenp')).toMatchObject({ amount: 1, state: 'pending' });
    // the paperback has its own ASIN but is the same book as the eBook with that title
    expect(e.find((x) => x.source === 'print')).toMatchObject({ asin: A, currency: 'CAD', amount: 5.96 });
  });
  it('lets the user set a KENP rate for a month', () => {
    setKenpRate(lib.db, root, '2026-10', 'USD', 0.006);
    expect(monthlyEarnings(lib.db, {}, TODAY).find((x) => x.month === '2026-10' && x.source === 'kenp')!.amount).toBe(1.2);
  });
});

describe('analysis', () => {
  beforeEach(() => { importSalesFile(lib.db, root, 'KDP Orders.xlsx', workbook(), TODAY); });

  it('totals a month by source, book, marketplace and royalty type, and keeps pending KENP out', () => {
    const m = monthReport(lib.db, '2026-09', TODAY);
    // USD: ebook 33.80 + 0.35, GBP 5.00 * 1.27, print CAD 5.96 * 0.73, KENP 1000*.005 + 500*.005 in USD and 400*.004 GBP * 1.27
    expect(m.totals.ebook).toBeCloseTo(34.15 + 6.35, 2);
    expect(m.totals.print).toBeCloseTo(4.35, 2);
    expect(m.totals.kenp).toBeCloseTo(7.5 + 2.03, 2);
    expect(m.totals.usd).toBeCloseTo(m.totals.ebook + m.totals.print + m.totals.kenp, 2);
    expect(m.books.map((b) => b.asin)).toEqual([A, B]);
    expect(m.marketplaces.map((x) => x.key)).toContain('amazon.co.uk');
    expect(m.royaltyTypes.map((x) => x.key)).toEqual(expect.arrayContaining(['70%', '35%', '60%']));
    expect(m.kenp.find((k) => k.currency === 'USD')).toMatchObject({ pages: 1500, state: 'final' });
    expect(m.previous).toBeNull();
    const o = monthReport(lib.db, '2026-10', TODAY);
    expect(o.totals.kenp).toBe(0);
    expect(o.totals.pending).toBe(1);
    expect(o.previous!.usd).toBeCloseTo(m.totals.usd, 2);
    expect(o.previousByBook[A]).toBeGreaterThan(0);
  });
  it('gives a period report with a row per month and the months an import is missing', () => {
    const r = analysisReport(lib.db, { from: '2026-08', to: '2026-10' }, TODAY);
    expect(r.months.map((x) => x.month)).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(r.months[2]!.state).toBe('pending');
    expect(reportMonths(lib.db)[0]).toBe('2026-10');
  });
});

describe('splitting royalties', () => {
  beforeEach(() => { importSalesFile(lib.db, root, 'KDP Orders.xlsx', workbook(), TODAY); });
  const people = () => ({ blake: savePerson(lib.db, root, { name: 'Blake Ashford' }), loric: savePerson(lib.db, root, { name: 'Loric Thorne', penNames: ['Loric T'] }) });

  it('allocates cents so the parts always add up', () => {
    expect(allocate(0.1, [33.34, 33.33, 33.33]).reduce((a, b) => a + b, 0)).toBeCloseTo(0.1, 10);
    expect(allocate(10, [50, 50])).toEqual([5, 5]);
    expect(allocate(0.01, [50, 50]).reduce((a, b) => a + b, 0)).toBeCloseTo(0.01, 10);
    expect(allocate(-3.01, [60, 40]).reduce((a, b) => a + b, 0)).toBeCloseTo(-3.01, 10);
  });
  it('rejects splits that are not 100% or name unknown people', () => {
    const { blake, loric } = people();
    expect(() => setSplit(lib.db, root, A, [{ personId: blake.id, pct: 60 }, { personId: loric.id, pct: 30 }])).toThrow(/100/);
    expect(() => setSplit(lib.db, root, A, [{ personId: 999, pct: 100 }])).toThrow(/unknown/);
  });
  it('pays each author their share of eBook, print and KENP, with the unsplit book going to its author', () => {
    const { blake, loric } = people();
    setSplit(lib.db, root, A, [{ personId: blake.id, pct: 60 }, { personId: loric.id, pct: 40 }]);
    const s = royaltyStatement(lib.db, { from: '2026-09', to: '2026-10' }, TODAY);
    expect(s.payees.map((p) => p.name)).toEqual(['Ashe Wilder', 'Blake Ashford', 'Loric Thorne']);
    const total = (n: string) => s.payees.find((p) => p.name === n)!.totalUsd;
    const a = royaltyStatement(lib.db, { from: '2026-09', to: '2026-10' }, TODAY);
    const whole = monthReport(lib.db, '2026-09', TODAY).totals.usd + monthReport(lib.db, '2026-10', TODAY).totals.usd;
    expect(money(a.payees.reduce((x, p) => x + p.totalUsd, 0))).toBeCloseTo(whole, 2);
    expect(total('Ashe Wilder')).toBeCloseTo(0.35 + 2.5, 2);
    // a line's shares add up to the line
    for (const l of s.payees.flatMap((p) => p.lines).filter((x) => x.asin === A && x.month === '2026-09' && x.source === 'ebook' && x.currency === 'USD')) expect(l.gross).toBe(33.8);
    expect(s.payees.find((p) => p.name === 'Blake Ashford')!.lines.find((l) => l.source === 'ebook' && l.currency === 'USD' && l.month === '2026-09')!.amount).toBe(20.28);
    expect(s.payees.find((p) => p.name === 'Loric Thorne')!.lines.find((l) => l.source === 'ebook' && l.currency === 'USD' && l.month === '2026-09')!.amount).toBe(13.52);
    // October's KENP is pending, so it is listed apart and not owed yet
    expect(s.pending).toEqual([expect.objectContaining({ asin: A, month: '2026-10', amount: 1 })]);
    expect(s.payees.flatMap((p) => p.lines).some((l) => l.month === '2026-10' && l.source === 'kenp')).toBe(false);
  });
  it('keeps earlier months on the old split when a change applies from a later month', () => {
    const { blake, loric } = people();
    setSplit(lib.db, root, A, [{ personId: blake.id, pct: 60 }, { personId: loric.id, pct: 40 }]);
    setSplit(lib.db, root, A, [{ personId: blake.id, pct: 50 }, { personId: loric.id, pct: 50 }], '2026-10');
    expect(splitHistory(lib.db, A).map((v) => v.fromMonth)).toEqual(['0000-00', '2026-10']);
    const s = royaltyStatement(lib.db, { from: '2026-09', to: '2026-10' }, TODAY);
    const loricOct = s.payees.find((p) => p.name === 'Loric Thorne')!.lines.find((l) => l.month === '2026-10' && l.source === 'ebook')!;
    expect(loricOct).toMatchObject({ pct: 50, amount: 6.76 });
    const loricSep = s.payees.find((p) => p.name === 'Loric Thorne')!.lines.find((l) => l.month === '2026-09' && l.source === 'ebook' && l.currency === 'USD')!;
    expect(loricSep.pct).toBe(40);
  });
  it('converts other currencies at the month rate the user sets, and totals each currency', () => {
    const { blake } = people();
    setSplit(lib.db, root, A, [{ personId: blake.id, pct: 100 }]);
    setFxRate(lib.db, root, '2026-09', 'GBP', 1.3);
    const s = royaltyStatement(lib.db, { from: '2026-09', to: '2026-09' }, TODAY);
    const p = s.payees.find((x) => x.name === 'Blake Ashford')!;
    expect(p.lines.find((l) => l.currency === 'GBP' && l.source === 'ebook')).toMatchObject({ usd: 6.5, fx: 'user' });
    expect(p.byCurrency.map((c) => c.currency)).toEqual(['CAD', 'GBP', 'USD']);
    expect(s.fx.find((f) => f.currency === 'CAD')!.source).toBe('default');
  });
  it('writes CSV and a printable page per author', () => {
    const { blake } = people();
    setSplit(lib.db, root, A, [{ personId: blake.id, pct: 100 }]);
    const s = royaltyStatement(lib.db, { from: '2026-09', to: '2026-09' }, TODAY);
    const csv = statementCsv(s, 'Blake Ashford');
    expect(csv.split('\r\n')[0]).toContain('Amount owed USD');
    expect(csv).toContain('Blake Ashford,2026-09,Anthology');
    expect(csv).not.toContain('Ashe Wilder');
    const html = statementHtml(s, 'Blake Ashford');
    expect(html).toContain('Royalty statement');
    expect(html).toContain('Blake Ashford');
    expect(() => statementHtml(s, 'Nobody')).toThrow();
  });
  it('refuses to delete someone who is in a split, and restores people and splits from the user-data file', () => {
    const { blake, loric } = people();
    setSplit(lib.db, root, A, [{ personId: blake.id, pct: 60 }, { personId: loric.id, pct: 40 }]);
    expect(() => deletePerson(lib.db, root, blake.id)).toThrow(/split/);
    lib.close();
    fs.rmSync(path.join(root, 'scout.db'), { force: true });
    for (const f of fs.readdirSync(root)) if (f.startsWith('scout.db')) fs.rmSync(path.join(root, f), { force: true });
    lib = Library.open(root);
    expect(listPeople(lib.db).map((p) => p.name)).toEqual(['Blake Ashford', 'Loric Thorne']);
    expect(splitHistory(lib.db, A)[0]!.shares.map((s) => s.pct)).toEqual([60, 40]);
    expect(importUserData).toBeTypeOf('function');
  });
});

describe('author names found in the reports', () => {
  beforeEach(() => { importSalesFile(lib.db, root, 'KDP Orders.xlsx', workbook(), TODAY); });

  it('lists every author name on the books with the books it is on', () => {
    const d = detectedAuthors(lib.db);
    expect(d.map((x) => x.name)).toEqual(['Ashe Wilder', 'Blake Ashford']);
    expect(d.find((x) => x.name === 'Blake Ashford')).toMatchObject({ asins: [A], personId: null });
  });
  it('splits a book by author name, creating the people, so nothing has to be set up first', () => {
    setSplit(lib.db, root, A, [{ name: 'Blake Ashford', pct: 70 }, { name: 'New Collaborator', pct: 30 }]);
    expect(listPeople(lib.db).map((p) => p.name)).toEqual(['Blake Ashford', 'New Collaborator']);
    expect(detectedAuthors(lib.db).find((x) => x.name === 'Blake Ashford')!.personId).not.toBeNull();
    // the same name picked again finds the person instead of making another
    setSplit(lib.db, root, B, [{ name: 'blake ashford', pct: 50 }, { name: 'Ashe Wilder', pct: 50 }]);
    expect(listPeople(lib.db)).toHaveLength(3);
    const s = royaltyStatement(lib.db, { from: '2026-09', to: '2026-09' }, TODAY);
    expect(s.payees.map((p) => p.name)).toEqual(['Ashe Wilder', 'Blake Ashford', 'New Collaborator']);
  });
  it('pays an unsplit book to the person who writes under its pen name', () => {
    const real = savePerson(lib.db, root, { name: 'Jo Real', penNames: ['Ashe Wilder', 'Blake Ashford'] });
    expect(personForName(listPeople(lib.db), 'ashe wilder')!.id).toBe(real.id);
    expect(detectedAuthors(lib.db).every((x) => x.personId === real.id)).toBe(true);
    const s = royaltyStatement(lib.db, { from: '2026-09', to: '2026-09' }, TODAY);
    expect(s.payees.map((p) => p.name)).toEqual(['Jo Real']);
    expect(s.payees[0]!.totalUsd).toBeCloseTo(monthReport(lib.db, '2026-09', TODAY).totals.usd, 1);
  });
  it('still rejects a share with neither a person nor a name', () => {
    expect(() => setSplit(lib.db, root, A, [{ pct: 100 }])).toThrow(/choose who/);
  });
});

describe('capturing a book page brings its co-authors in', () => {
  const COLLAB = 'B0H7QRHNJR'; // a fixture page credited to two authors
  it('adds the authors credited on the captured page to the names found in the report', () => {
    importSalesFile(lib.db, root, 'orders.csv', new TextEncoder().encode(`Date,Title,Author Name,ASIN,Marketplace,Paid Units\n2026-10-16,Joint Book,Reported Author,${COLLAB},Amazon.com,3`));
    expect(detectedAuthors(lib.db).map((d) => d.name)).toEqual(['Reported Author']);
    const html = zlib.gunzipSync(fs.readFileSync(path.resolve(__dirname, `../../../fixtures/amazon-com/detail-kindle-${COLLAB}.html.gz`))).toString('utf8');
    lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${COLLAB}`, html, capturedAt: '2026-10-18T12:00:00Z' });
    const names = detectedAuthors(lib.db).filter((d) => d.asins.includes(COLLAB)).map((d) => d.name);
    expect(names).toContain('Reported Author');
    expect(names.length).toBeGreaterThanOrEqual(3);
    // and they can be split by name straight away
    setSplit(lib.db, root, COLLAB, names.map((name, i) => ({ name, pct: i === 0 ? 100 - 10 * (names.length - 1) : 10 })));
    expect(splitHistory(lib.db, COLLAB)[0]!.shares).toHaveLength(names.length);
  });
});

describe('statement periods', () => {
  it('gives month, quarter, year and custom ranges', () => {
    expect(periodMonths('month', '2026-09')).toEqual({ from: '2026-09', to: '2026-09' });
    expect(periodMonths('quarter', '2026-Q3')).toEqual({ from: '2026-07', to: '2026-09' });
    expect(periodMonths('quarter', '2026-Q4')).toEqual({ from: '2026-10', to: '2026-12' });
    expect(periodMonths('year', '2026')).toEqual({ from: '2026-01', to: '2026-12' });
    expect(periodMonths('custom', '2026-03..2026-05')).toEqual({ from: '2026-03', to: '2026-05' });
    expect(() => periodMonths('custom', '2026-05..2026-03')).toThrow();
  });
});
