import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { zipSync, strToU8 } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Library, METHODS, listBooks, getOwnBook, isOwnBook, listOwnBooks, registerOwnBooks, setOwnBook, applyCalibration, getCompletion, kenpcFor, kuBooks, parseKenpFile, setCompletion, setKenpc, calibrationPoints, calibrationPreview, clearSalesData, estimateSalesRange, fitSalesCurve, getCalibration,
  getSalesCurve, importRankFile, importSalesFile, parseDates, parseRankFile, parseSalesFile, resetCalibration, salesStatus, setSalesCurve, DEFAULT_SALES_CURVE,
} from '../src/index.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const BOOKS = ['B0C1R52V2J', 'B0G7R6X55V', 'B0GPRVQ8QJ', 'B0GSCPBJLJ'];
const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));

let root: string;
let lib: Library;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-market-s-'));
  lib = Library.open(root);
});
afterEach(() => {
  lib.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A minimal .xlsx: one sheet per entry, strings as shared strings, numbers as numbers. */
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

describe('reading a KDP orders report', () => {
  const csv = ['Date,Title,Author,ASIN,Marketplace,Paid Units,Free Units,Orders Placed', '2026-10-16,A,Me,B0C1R52V2J,Amazon.com,2,0,2', '2026-10-17,A,Me,B0C1R52V2J,Amazon.com,1,3,1', '2026-10-17,B,Me,B0G7R6X55V,Amazon.co.uk,5,0,5', 'x,bad row,,,,,,'].join('\n');
  it('reads a CSV, lower-casing the marketplace, skipping rows it cannot read and keeping free units apart', () => {
    const p = parseSalesFile('orders.csv', bytes(csv));
    expect(p.rows).toEqual([
      { asin: 'B0C1R52V2J', day: '2026-10-16', marketplace: 'amazon.com', paidUnits: 2, freeUnits: 0, title: 'A', author: 'Me' },
      { asin: 'B0C1R52V2J', day: '2026-10-17', marketplace: 'amazon.com', paidUnits: 1, freeUnits: 3, title: 'A', author: 'Me' },
      { asin: 'B0G7R6X55V', day: '2026-10-17', marketplace: 'amazon.co.uk', paidUnits: 5, freeUnits: 0, title: 'B', author: 'Me' },
    ]);
    expect(p.skipped).toBe(1);
  });
  it('reads an .xlsx, preferring the sheet named like orders, with Excel date serials', () => {
    const wb = xlsx({
      'Combined Sales': [['Royalty Date', 'ASIN', 'Net Units Sold'], ['2026-09', 'B0C1R52V2J', 40]],
      'Orders Processed': [['Report', 'for', 'me'], ['Date', 'ASIN', 'Paid Units'], [46311, 'B0C1R52V2J', 4], [46312, 'B0C1R52V2J', 6]],
    });
    const p = parseSalesFile('KDP Orders.xlsx', wb);
    expect(p.sheet).toBe('Orders Processed');
    expect(p.rows.map((r) => [r.day, r.paidUnits, r.marketplace])).toEqual([['2026-10-16', 4, 'amazon.com'], ['2026-10-17', 6, 'amazon.com']]);
  });
  it('explains what it found when the layout is not recognised', () => {
    expect(() => parseSalesFile('x.csv', bytes('Foo,Bar,Baz\n1,2,3'))).toThrow(/Found: .*Foo, Bar, Baz/);
    expect(() => parseSalesFile('x.xlsx', bytes('not a zip'))).toThrow(/xlsx/);
  });
  it('reads dates in several forms, deciding day-first or month-first from the whole column', () => {
    expect(parseDates(['2026-10-05', '10/5/2026', '46311', 'Oct 5, 2026'])).toEqual(['2026-10-05', '2026-10-05', '2026-10-16', '2026-10-05']);
    expect(parseDates(['13/10/2026', '05/10/2026'])).toEqual(['2026-10-13', '2026-10-05']);
    expect(parseDates(['junk'])).toEqual([null]);
  });
});

describe('reading a rank history', () => {
  it('needs an ASIN from the file or the caller, and keeps timestamps', () => {
    const csv = 'Date,Sales Rank\n2026-10-16 08:30:00,1200\n2026-10-17,950\n2026-10-18,\n';
    expect(() => parseRankFile('r.csv', bytes(csv))).toThrow(/no ASIN/);
    const p = parseRankFile('r.csv', bytes(csv), 'B0C1R52V2J');
    expect(p.rows).toEqual([{ asin: 'B0C1R52V2J', at: '2026-10-16T08:30:00Z', rank: 1200 }, { asin: 'B0C1R52V2J', at: '2026-10-17T12:00:00Z', rank: 950 }]);
    expect(p.skipped).toBe(1);
  });
});

describe('fitSalesCurve', () => {
  const pts = (a: number, b: number, ranks: number[], wobble = (i: number) => 1) => ranks.map((rank, i) => ({ rank, unitsPerDay: a * rank ** -b * wobble(i) }));
  it('recovers the slope and level of clean data across a wide range of ranks', () => {
    const f = fitSalesCurve(pts(5000, 0.9, [200, 900, 3000, 12000, 50000]))!;
    expect(f.mode).toBe('fitted');
    expect(f.b).toBeCloseTo(0.9, 6);
    expect(f.a).toBeCloseTo(5000, 3);
    expect(f.spread).toBeCloseTo(1.15, 6); // floored: clean data is not proof of a tight curve
  });
  it('keeps the default slope when the ranks barely differ or there are few points, fitting only the level', () => {
    const narrow = fitSalesCurve(pts(8000, 0.5, [900, 1000, 1100, 1200, 1300]))!;
    expect(narrow.mode).toBe('fixed-slope');
    expect(narrow.b).toBe(DEFAULT_SALES_CURVE.b);
    const two = fitSalesCurve(pts(8000, 0.79, [500, 5000]))!;
    expect(two.mode).toBe('fixed-slope');
    expect(two.a).toBeCloseTo(8000, 3);
    expect(fitSalesCurve(pts(8000, 0.79, [500]))).toBeNull();
  });
  it('rejects an absurd fitted slope instead of using it', () => {
    const f = fitSalesCurve(pts(1e6, 2.2, [200, 900, 3000, 12000, 50000]))!;
    expect(f.mode).toBe('fixed-slope');
  });
  it('widens the range as the points scatter', () => {
    const noisy = fitSalesCurve(pts(5000, 0.9, [200, 900, 3000, 12000, 50000, 80000], (i) => (i % 2 ? 2 : 0.5)))!;
    expect(noisy.spread).toBeGreaterThan(1.8);
  });
});

describe('estimateSalesRange', () => {
  it('spans the published methods until calibrated, with the middle between', () => {
    for (const rank of [50, 1000, 10000, 100000]) {
      const r = estimateSalesRange(lib.db, rank);
      const all = METHODS.map((m) => m.at(rank));
      expect(r.basis).toBe('methods');
      expect(r.low).toBeCloseTo(Math.min(...all), 1);
      expect(r.high).toBeCloseTo(Math.max(...all), 1);
      expect(r.low).toBeLessThanOrEqual(r.mid);
      expect(r.mid).toBeLessThanOrEqual(r.high);
    }
    expect(estimateSalesRange(lib.db, 1000).high / estimateSalesRange(lib.db, 1000).low).toBeGreaterThan(2); // the methods really do disagree
    expect(() => estimateSalesRange(lib.db, 0)).toThrow();
  });
  it('is continuous where Automateed switches formula, and extrapolates Bookwriter beyond its table', () => {
    const at = (id: string, r: number) => METHODS.find((m) => m.id === id)!.at(r);
    expect(at('automateed', 99.99) / at('automateed', 100)).toBeCloseTo(1, 1);
    expect(at('bookwriter', 1000)).toBeCloseTo(148, 6);
    expect(at('bookwriter', 1e6)).toBeCloseTo(0.15, 2);
  });
  it('uses a hand-edited curve as the middle, keeping the methods\' relative spread', () => {
    setSalesCurve(lib.db, { a: 20000, b: 0.8 });
    const r = estimateSalesRange(lib.db, 1000);
    expect(r.basis).toBe('custom');
    expect(r.mid).toBeCloseTo(20000 * 1000 ** -0.8, 1);
    expect(r.low).toBeLessThan(r.mid);
    expect(r.high).toBeGreaterThan(r.mid);
  });
});

describe('calibrating from imported sales and captured pages', () => {
  const rankOf = (asin: string) => lib.db.scalar<number>("SELECT r.rank FROM rank_entry r JOIN snapshot s ON s.id = r.snapshot_id WHERE s.asin = ? AND r.scope = 'overall' AND r.store = 'kindle'", asin);
  const capture = (asin: string, at: string) => lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${asin}`, html: zlib.gunzipSync(fs.readFileSync(path.join(FIX, `detail-kindle-${asin}.html.gz`))).toString('utf8'), capturedAt: at });
  const report = (rows: [string, string, number][]) => ['Date,ASIN,Marketplace,Paid Units,Free Units', ...rows.map(([d, a, u]) => `${d},${a},Amazon.com,${u},0`)].join('\n');

  it('pairs each captured rank with the average of the three days ending then, and fits and applies it', () => {
    const got = BOOKS.map((a) => { capture(a, '2026-10-18T12:00:00Z'); return [a, rankOf(a)] as const; }).filter(([, r]) => r);
    expect(got.length).toBeGreaterThanOrEqual(3);
    // sell exactly a * rank^-b units/day for each book, over the three days ending on the capture day
    const a = 9000, b = 0.85;
    const rows: [string, string, number][] = [];
    for (const [asin, rank] of got) {
      const perDay = a * rank! ** -b;
      for (const d of ['2026-10-16', '2026-10-17', '2026-10-18']) rows.push([d, asin, perDay]);
    }
    const summary = importSalesFile(lib.db, root, 'orders.csv', bytes(report(rows.map(([d, x, u]) => [d, x, Math.round(u * 1000) / 1000]))));
    expect(summary).toMatchObject({ from: '2026-10-16', to: '2026-10-18', books: got.length });

    const set = calibrationPoints(lib.db);
    expect(set.points).toHaveLength(got.length);
    expect(set.points.every((p) => p.source === 'capture')).toBe(true);
    for (const p of set.points) expect(p.unitsPerDay).toBeCloseTo(Math.round(a * p.rank ** -b * 1000) / 1000 || 0, 0);

    const prev = calibrationPreview(lib.db);
    expect(prev.fit).toBeTruthy();
    expect(prev.comparison.map((c) => c.rank)).toEqual([100, 1000, 10000, 100000]);
    expect(prev.current).toBeNull();

    const cal = applyCalibration(lib.db, {}, '2026-10-20T00:00:00Z');
    expect(cal.n).toBe(got.length);
    expect(getSalesCurve(lib.db)).toEqual({ a: cal.a, b: cal.b });
    expect(getCalibration(lib.db)?.fittedAt).toBe('2026-10-20T00:00:00Z');
    const r = estimateSalesRange(lib.db, 2000);
    expect(r.basis).toBe('calibrated');
    expect(r.high / r.mid).toBeCloseTo(cal.spread, 1); // figures are rounded to 2 places
    expect(r.mid / r.low).toBeCloseTo(cal.spread, 1);

    // editing the curve by hand afterwards means it is no longer "the fit"
    setSalesCurve(lib.db, { a: cal.a * 2, b: cal.b });
    expect(estimateSalesRange(lib.db, 2000).basis).toBe('custom');

    resetCalibration(lib.db);
    expect(getSalesCurve(lib.db)).toEqual(DEFAULT_SALES_CURVE);
    expect(estimateSalesRange(lib.db, 2000).basis).toBe('methods');
  });

  it('counts readings with no sales or outside the imported days, instead of guessing', () => {
    capture(BOOKS[0]!, '2026-10-18T12:00:00Z');
    capture(BOOKS[1]!, '2026-09-01T12:00:00Z');
    importSalesFile(lib.db, root, 'o.csv', bytes(report([['2026-10-15', BOOKS[0]!, 1], ['2026-10-18', BOOKS[1]!, 4]])));
    const set = calibrationPoints(lib.db);
    // book 0: window 16-18 has no sales; book 1's 09-01 capture is before the imported range
    expect(set.points).toHaveLength(0);
    expect(set.noSales).toBe(1);
    expect(set.outsideRange).toBe(1);
    const prev = calibrationPreview(lib.db);
    expect(prev.fit).toBeNull();
    expect(prev.reason).toMatch(/minimum/);
    expect(() => applyCalibration(lib.db)).toThrow(/minimum/);
  });

  it('uses imported rank history too, and treats days missing inside the imported range as no orders', () => {
    importSalesFile(lib.db, root, 'o.csv', bytes(report([['2026-10-10', BOOKS[0]!, 3], ['2026-10-11', BOOKS[0]!, 3], ['2026-10-12', BOOKS[0]!, 3], ['2026-10-20', BOOKS[0]!, 0]])));
    importRankFile(lib.db, root, 'ranks.csv', bytes('Date,Rank\n2026-10-12,2000\n2026-10-13,5000\n'), BOOKS[0]!);
    const pts = calibrationPoints(lib.db).points;
    expect(pts.map((p) => [p.day, p.rank, p.source, p.unitsPerDay])).toEqual([['2026-10-12', 2000, 'import', 3], ['2026-10-13', 5000, 'import', 2]]);
  });

  it('restores imported data from the saved files when the database is lost, and can be cleared', () => {
    importSalesFile(lib.db, root, 'o.csv', bytes(report([['2026-10-10', BOOKS[0]!, 3]])));
    importRankFile(lib.db, root, 'r.csv', bytes('Date,Rank\n2026-10-10,2000\n'), BOOKS[0]!);
    expect(salesStatus(lib.db)).toMatchObject({ days: 1, books: 1, from: '2026-10-10', rankImported: 1 });
    lib.close();
    fs.rmSync(path.join(root, 'scout.db'), { force: true });
    fs.rmSync(path.join(root, 'scout.db-wal'), { force: true });
    fs.rmSync(path.join(root, 'scout.db-shm'), { force: true });
    lib = Library.open(root);
    expect(salesStatus(lib.db)).toMatchObject({ days: 1, books: 1, rankImported: 1 });
    clearSalesData(lib.db, root);
    expect(salesStatus(lib.db).days).toBe(0);
    expect(fs.existsSync(path.join(root, 'sales'))).toBe(false);
  });

  it('adds up two rows for the same book and day, and replaces days when a report is imported again', () => {
    importSalesFile(lib.db, root, 'o.csv', bytes(report([['2026-10-10', BOOKS[0]!, 3], ['2026-10-10', BOOKS[0]!, 2]])));
    expect(lib.db.scalar('SELECT paid_units FROM sales_day')).toBe(5);
    importSalesFile(lib.db, root, 'o2.csv', bytes(report([['2026-10-10', BOOKS[0]!, 7]])), new Date(Date.now() + 5000));
    expect(lib.db.scalar('SELECT paid_units FROM sales_day')).toBe(7);
  });
});

describe('Kindle Unlimited', () => {
  const rankOf = (asin: string) => lib.db.scalar<number>("SELECT r.rank FROM rank_entry r JOIN snapshot s ON s.id = r.snapshot_id WHERE s.asin = ? AND r.scope = 'overall' AND r.store = 'kindle'", asin);
  const capture = (asin: string, at: string) => lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${asin}`, html: zlib.gunzipSync(fs.readFileSync(path.join(FIX, `detail-kindle-${asin}.html.gz`))).toString('utf8'), capturedAt: at });
  const DAYS = ['2026-10-16', '2026-10-17', '2026-10-18'];
  const kenpCsv = (rows: [string, string, number][]) => ['Date,Title,Author Name,ASIN,Marketplace,KENP Read', ...rows.map(([d, a, p]) => `${d},T,A,${a},Amazon.com,${p}`)].join('\n');

  it('reads a KENP Read report, and a workbook holding both the Orders and KENP tabs', () => {
    expect(parseKenpFile('k.csv', bytes(kenpCsv([['2026-10-16', BOOKS[0]!, 1200], ['2026-10-17', BOOKS[0]!, 900]]))).rows.map((r) => [r.day, r.pages])).toEqual([['2026-10-16', 1200], ['2026-10-17', 900]]);
    expect(() => parseKenpFile('x.csv', bytes('Date,ASIN,Paid Units\n2026-10-16,B0C1R52V2J,3'))).toThrow(/KENP Read table/);
    const wb = xlsx({ 'Orders Processed': [['Date', 'ASIN', 'Paid Units'], [46311, BOOKS[0]!, 4]], 'KENP Read': [['Date', 'ASIN', 'KENP Read'], [46311, BOOKS[0]!, 700]] });
    const sum = importSalesFile(lib.db, root, 'KDP.xlsx', wb);
    expect(sum.contains).toEqual(['orders', 'kenp']);
    expect(lib.db.scalar('SELECT paid_units FROM sales_day')).toBe(4);
    expect(lib.db.scalar('SELECT pages FROM kenp_day')).toBe(700);
    expect(salesStatus(lib.db)).toMatchObject({ days: 1, kenpDays: 1, kenpBooks: 1 });
    // a CSV that is only KENP is stored as pages, never as paid units
    importSalesFile(lib.db, root, 'k.csv', bytes(kenpCsv([['2026-10-17', BOOKS[0]!, 50]])), new Date(Date.now() + 5000));
    expect(lib.db.scalar('SELECT COUNT(*) FROM sales_day')).toBe(1);
  });

  it('uses the user\'s page count over the captured print length, and drops books that have neither', () => {
    capture(BOOKS[0]!, '2026-10-18T12:00:00Z');
    const printLength = lib.db.scalar<number>('SELECT pages FROM snapshot WHERE asin = ?', BOOKS[0]!);
    expect(kenpcFor(lib.db, BOOKS[0]!)).toEqual(printLength ? { asin: BOOKS[0], kenpc: printLength, from: 'print length' } : null);
    setKenpc(lib.db, BOOKS[0]!, 321);
    expect(kenpcFor(lib.db, BOOKS[0]!)).toEqual({ asin: BOOKS[0], kenpc: 321, from: 'you' });
    setKenpc(lib.db, BOOKS[0]!, null);
    expect(kenpcFor(lib.db, BOOKS[0]!)?.from).not.toBe('you');
    expect(() => setKenpc(lib.db, BOOKS[0]!, 0)).toThrow(/KENPC/);
    expect(() => setKenpc(lib.db, 'bad', 10)).toThrow(/ASIN/);
    expect(kenpcFor(lib.db, 'B000000000')).toBeNull();
    expect(() => setCompletion(lib.db, 0.01)).toThrow(/between/);
    expect(getCompletion(lib.db)).toBe(1);
  });

  it('fits a book that sells only through borrows: invisible to a paid-only fit, recovered when borrows count', () => {
    const got = BOOKS.map((a) => { capture(a, '2026-10-18T12:00:00Z'); return [a, rankOf(a)] as const; }).filter(([, r]) => r);
    expect(got.length).toBeGreaterThanOrEqual(3);
    const a = 6000, b = 0.8, kenpc = 300;
    for (const [asin] of got) setKenpc(lib.db, asin, kenpc);
    const pages: [string, string, number][] = [];
    for (const [asin, rank] of got) for (const d of DAYS) pages.push([d, asin, Math.round(a * rank! ** -b * kenpc)]);
    importSalesFile(lib.db, root, 'kenp.csv', bytes(kenpCsv(pages)));

    const prev = calibrationPreview(lib.db);
    expect(prev).toMatchObject({ kuAvailable: true, includeKu: true, paidAssumedZero: true });
    expect(prev.fitPaid).toBeNull(); // no paid sales anywhere: nothing to compare the ranks with
    expect(prev.fitKu!.b).toBeCloseTo(b, 1);
    expect(prev.fitKu!.a / a).toBeGreaterThan(0.9);
    expect(prev.fitKu!.a / a).toBeLessThan(1.1);
    expect(prev.points.every((p) => p.paidPerDay === 0 && p.borrowsPerDay > 0)).toBe(true);
    expect(prev.kuBooks.map((k) => [k.kenpc, k.kenpcFrom])).toEqual(got.map(() => [kenpc, 'you']));
    expect(prev.comparison[1]!.ku!.mid).toBeGreaterThan(0);
    expect(prev.comparison[1]!.paid).toBeNull();

    const forcedPaid = calibrationPreview(lib.db, { includeKu: false });
    expect(forcedPaid.includeKu).toBe(false);
    expect(forcedPaid.fit).toBeNull();
    expect(forcedPaid.reason).toMatch(/no paid sales/);

    const cal = applyCalibration(lib.db);
    expect(cal).toMatchObject({ includesKu: true, completion: 1 });
    expect(estimateSalesRange(lib.db, 2000)).toMatchObject({ basis: 'calibrated', includesKu: true });
    expect(() => applyCalibration(lib.db, { includeKu: false })).toThrow(/no paid sales/);
    resetCalibration(lib.db);
    expect(estimateSalesRange(lib.db, 2000).includesKu).toBe(false);
  });

  it('a smaller assumed share of a book read means more borrows from the same pages', () => {
    capture(BOOKS[0]!, '2026-10-18T12:00:00Z');
    setKenpc(lib.db, BOOKS[0]!, 300);
    importSalesFile(lib.db, root, 'k.csv', bytes(kenpCsv(DAYS.map((d) => [d, BOOKS[0]!, 600] as [string, string, number]))));
    const full = calibrationPoints(lib.db, { includeKu: true }).points[0]!;
    expect(full.borrowsPerDay).toBeCloseTo(2, 6);
    setCompletion(lib.db, 0.5);
    expect(calibrationPoints(lib.db, { includeKu: true }).points[0]!.borrowsPerDay).toBeCloseTo(4, 6);
    expect(kuBooks(lib.db)[0]!.borrows).toBeCloseTo(12, 1);
  });

  it('adds borrows to paid sales in a window, drops books with pages read but no page count, and counts the days outside the KENP report', () => {
    const [x, y] = [BOOKS[0]!, BOOKS[1]!];
    capture(x, '2026-10-18T12:00:00Z');
    capture(y, '2026-10-18T12:00:00Z');
    setKenpc(lib.db, x, 200);
    lib.db.prepare('UPDATE snapshot SET pages = NULL WHERE asin = ?').run(y); // y has neither a typed page count nor a captured print length
    const orders = ['Date,ASIN,Marketplace,Paid Units', ...DAYS.map((d) => `${d},${x},Amazon.com,3`), ...DAYS.map((d) => `${d},${y},Amazon.com,3`)].join('\n');
    importSalesFile(lib.db, root, 'o.csv', bytes(orders));
    importSalesFile(lib.db, root, 'k.csv', bytes(kenpCsv([...DAYS.map((d) => [d, x, 400] as [string, string, number]), ...DAYS.map((d) => [d, y, 400] as [string, string, number])])), new Date(Date.now() + 5000));
    const set = calibrationPoints(lib.db, { includeKu: true });
    expect(set.noKenpc).toEqual([y]);
    expect(set.points).toHaveLength(1);
    expect(set.points[0]).toMatchObject({ asin: x, paidPerDay: 3, borrowsPerDay: 2, unitsPerDay: 5 });
    expect(calibrationPoints(lib.db, { includeKu: false }).points.map((p) => p.unitsPerDay)).toEqual([3, 3]);
    // a capture after the KENP report ends cannot be given borrows
    capture(BOOKS[2]!, '2026-10-25T12:00:00Z');
    importSalesFile(lib.db, root, 'o2.csv', bytes(['Date,ASIN,Marketplace,Paid Units', `2026-10-25,${BOOKS[2]},Amazon.com,2`, `2026-10-24,${BOOKS[2]},Amazon.com,2`, `2026-10-23,${BOOKS[2]},Amazon.com,2`].join('\n')), new Date(Date.now() + 9000));
    expect(calibrationPoints(lib.db, { includeKu: true }).outsideRange).toBe(1);
    expect(calibrationPoints(lib.db, { includeKu: false }).points).toHaveLength(3);
  });

  it('restores pages read from the saved files when the database is lost', () => {
    importSalesFile(lib.db, root, 'k.csv', bytes(kenpCsv([['2026-10-16', BOOKS[0]!, 500]])));
    lib.close();
    for (const f of ['scout.db', 'scout.db-wal', 'scout.db-shm']) fs.rmSync(path.join(root, f), { force: true });
    lib = Library.open(root);
    expect(salesStatus(lib.db)).toMatchObject({ kenpDays: 1 });
    expect(lib.db.scalar('SELECT COUNT(*) FROM sales_day')).toBe(0);
  });
});

describe('My Books', () => {
  const capture = (asin: string, at: string) => lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${asin}`, html: zlib.gunzipSync(fs.readFileSync(path.join(FIX, `detail-kindle-${asin}.html.gz`))).toString('utf8'), capturedAt: at });
  const orders = ['Date,Title,Author Name,ASIN,Marketplace,Paid Units,Free Units', `2026-10-16,Dragon Tea,Jo Writer,${BOOKS[0]},Amazon.com,3,0`, `2026-10-17,Dragon Tea,Jo Writer,${BOOKS[0]},Amazon.com,2,1`, `2026-10-17,Second Cup,Jo Writer,${BOOKS[1]},Amazon.com,4,0`].join('\n');
  const kenp = ['Date,Title,Author Name,ASIN,Marketplace,KENP Read', `2026-10-16,Third Brew,Jo Writer,${BOOKS[2]},Amazon.com,800`, `2026-10-17,Dragon Tea,Jo Writer,${BOOKS[0]},Amazon.com,150`].join('\n');

  it('creates the books named in a report, flagged as the user\'s own, before any page is captured', () => {
    const s = importSalesFile(lib.db, root, 'orders.csv', bytes(orders));
    expect(s).toMatchObject({ newBooks: 2, titles: 2 });
    expect(lib.db.scalar('SELECT COUNT(*) FROM book')).toBe(0); // nothing captured: no page-derived rows are invented
    const mine = listOwnBooks(lib.db);
    expect(mine.map((b) => [b.asin, b.title, b.penNames, b.snapshots, b.paidUnits, b.lastSaleDay, b.source])).toEqual([
      [BOOKS[0], 'Dragon Tea', ['Jo Writer'], 0, 5, '2026-10-17', 'report'],
      [BOOKS[1], 'Second Cup', ['Jo Writer'], 0, 4, '2026-10-17', 'report'],
    ]);
    // a KENP report adds books that only sell through Kindle Unlimited, and does not re-add known ones
    expect(importSalesFile(lib.db, root, 'kenp.csv', bytes(kenp), new Date(Date.now() + 5000))).toMatchObject({ newBooks: 1, titles: 2 });
    expect(getOwnBook(lib.db, BOOKS[2]!)).toMatchObject({ title: 'Third Brew', paidUnits: 0, kenpPages: 800 });
    expect(getOwnBook(lib.db, BOOKS[0]!)).toMatchObject({ paidUnits: 5, kenpPages: 150 });
    expect(importSalesFile(lib.db, root, 'orders2.csv', bytes(orders), new Date(Date.now() + 9000)).newBooks).toBe(0);
  });

  it('shows the captured title and rank once the book is captured, and puts captured books first', () => {
    importSalesFile(lib.db, root, 'orders.csv', bytes(orders));
    capture(BOOKS[1]!, '2026-10-18T12:00:00Z');
    const mine = listOwnBooks(lib.db);
    expect(mine.map((b) => b.asin)).toEqual([BOOKS[1], BOOKS[0]]);
    expect(mine[0]).toMatchObject({ snapshots: 1, lastCaptured: '2026-10-18T12:00:00Z', paidUnits: 4 });
    expect(mine[0]!.title).not.toBe('Second Cup'); // the captured page's own title wins
    expect(mine[0]!.ratingCount).toBeGreaterThan(0);
    expect(mine[1]).toMatchObject({ snapshots: 0, title: 'Dragon Tea', overallRank: null });
    // the same figures the Library's All books list shows for the book, so the two tables agree column for column
    const lb = listBooks(lib.db).find((b) => b.asin === BOOKS[1])!;
    expect(mine[0]).toMatchObject({ authorNames: lb.authorNames, listRank: lb.listRank, listCategory: lb.listCategory, text: lb.text, overallRank: lb.overallRank, ratingCount: lb.ratingCount, kindlePrice: lb.kindlePrice, snapshots: lb.snapshots });
    expect(mine[0]!.penNames).toEqual(['Jo Writer']); // the pen name is what the report says, not the captured author
    expect(mine[1]).toMatchObject({ authorNames: [], listRank: null, text: null });
    // a book flagged by hand takes its pen name from the captured page
    capture(BOOKS[2]!, '2026-10-18T12:00:00Z');
    setOwnBook(lib.db, root, BOOKS[2]!, true);
    expect(getOwnBook(lib.db, BOOKS[2]!)!.penNames).toEqual(getOwnBook(lib.db, BOOKS[2]!)!.authorNames);
    expect(getOwnBook(lib.db, BOOKS[2]!)!.penNames.length).toBeGreaterThan(0);
    // the All books list marks them
    const all = listBooks(lib.db);
    expect(all.find((b) => b.asin === BOOKS[1])!.own).toBe(1);
  });

  it('can flag and unflag a captured book by hand, and refuses bad ASINs', () => {
    capture(BOOKS[0]!, '2026-10-18T12:00:00Z');
    expect(isOwnBook(lib.db, BOOKS[0]!)).toBe(false);
    setOwnBook(lib.db, root, BOOKS[0]!, true);
    expect(getOwnBook(lib.db, BOOKS[0]!)).toMatchObject({ source: 'manual', snapshots: 1 });
    setOwnBook(lib.db, root, BOOKS[0]!, true); // twice is fine
    expect(listOwnBooks(lib.db)).toHaveLength(1);
    setOwnBook(lib.db, root, 'B000000099', true); // a book not yet captured or in any report
    expect(getOwnBook(lib.db, 'B000000099')).toMatchObject({ title: null, snapshots: 0 });
    setOwnBook(lib.db, root, BOOKS[0]!, false);
    expect(isOwnBook(lib.db, BOOKS[0]!)).toBe(false);
    expect(() => setOwnBook(lib.db, root, 'nope', true)).toThrow(/ASIN/);
    expect(registerOwnBooks(lib.db, [{ asin: 'short' }, { asin: BOOKS[3]!, title: 'Late' }], 'manual')).toBe(1);
  });

  it('survives losing the database: report books come back from the saved files, manual ones from user-data.json', () => {
    importSalesFile(lib.db, root, 'orders.csv', bytes(orders));
    setOwnBook(lib.db, root, 'B000000099', true);
    lib.close();
    for (const f of ['scout.db', 'scout.db-wal', 'scout.db-shm']) fs.rmSync(path.join(root, f), { force: true });
    lib = Library.open(root);
    expect(listOwnBooks(lib.db).map((b) => [b.asin, b.source]).sort()).toEqual([[BOOKS[0], 'report'], [BOOKS[1], 'report'], ['B000000099', 'manual']].sort());
    expect(getOwnBook(lib.db, BOOKS[0]!)).toMatchObject({ title: 'Dragon Tea', paidUnits: 5 });
  });
});
