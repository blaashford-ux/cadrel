import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Library, allocatePayment, allocateRollup, deletePayout, importSalesFile, listPayouts, paymentOwed, payoutRollup, recordPayout, rollupCsv, rollupHtml, savePerson, setSplit, unallocatePayment,
} from '../src/index.js';

const A = 'B0AAAAAAA1';
const B = 'B0BBBBBBB2';
const TODAY = new Date('2026-12-20T12:00:00Z');

let root: string;
let lib: Library;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bookscout-o-'));
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


const PHEAD = ['Sales Period - Start Date', 'Sales Period - End Date', 'Marketplace', 'Payment Number', 'Detail', 'Date', 'Payment Method', 'Currency', 'Accrued Royalty', 'Tax Withholding', 'Net Earnings', 'Source', 'FX Rate', 'Currency', 'Payout Amount', 'Payment Status'];
type Line = [string, string, number, number, number, string]; // month, currency, accrued, tax, net, source
const header = (num: string, paidOn: string, accrued: number, tax: number, net: number, fx: string | number = 'Pending info from Bank', payout: string | number = 'Pending info from Bank', cur = 'USD'): (string | number)[] =>
  ['2026-09-01', '2026-09-30', 'Amazon.com', num, '', paidOn, 'WIRE', cur, accrued, tax, net, '', fx, 'NZD', payout, 'Paid'];
const detail = (l: Line): (string | number)[] => ['', '', '', '', l[0], '', '', l[1], l[2], l[3], l[4], l[5], '', '', '', ''];
const payments = (...blocks: { head: (string | number)[]; lines: Line[] }[]) => xlsx({ Payments: [PHEAD, ...blocks.flatMap((b) => [b.head, ...b.lines.map(detail)])] });

const SEPT: Line[] = [['2026-09', 'USD', 34.15, 1.71, 32.44, 'Sales'], ['2026-09', 'USD', 7.5, 0.38, 7.12, 'Kindle+ Royalties']];
const P1 = () => payments({ head: header('1.0000154418274E14', '2026-10-29', 41.65, 2.09, 39.56), lines: SEPT });
const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;



beforeEach(() => {
  importSalesFile(lib.db, root, 'KDP Orders.xlsx', workbook(), TODAY);
  // two payments: Sept Kindle+ paid in August (an earlier quarter), Sept sales paid in October
  importSalesFile(lib.db, root, 'KDP Payments A.xlsx', payments({ head: header('200', '2026-08-29', 7.5, 0.38, 7.12), lines: [SEPT[1]!] }), TODAY);
  importSalesFile(lib.db, root, 'KDP Payments B.xlsx', payments({ head: header('300', '2026-10-29', 34.15, 1.71, 32.44), lines: [SEPT[0]!] }), TODAY);
  const blake = savePerson(lib.db, root, { name: 'Blake Ashford' });
  const loric = savePerson(lib.db, root, { name: 'Loric Thorne' });
  setSplit(lib.db, root, A, [{ personId: blake.id, pct: 60 }, { personId: loric.id, pct: 40 }]);
});

const Q4 = { from: '2026-10', to: '2026-12' };

describe('the calculator for one payment', () => {
  it('says what each author is owed from the payment, after tax, to the cent', () => {
    const o = paymentOwed(lib.db, '300', TODAY);
    expect(o.payment).toMatchObject({ number: '300', net: 32.44 });
    expect(o.payees.map((p) => p.name)).toEqual(['Ashe Wilder', 'Blake Ashford', 'Loric Thorne']);
    expect(o.totalAccrued).toBe(34.15);
    expect(o.totalTax).toBe(1.71);
    expect(o.totalOwed).toBe(32.44);
    expect(sum(o.payees.map((p) => p.owed))).toBe(32.44);
    expect(o.payees.find((p) => p.name === 'Ashe Wilder')).toMatchObject({ accrued: 0.35 });
    expect(o.allocation).toBeNull();
    expect(o.unmatchedNet).toBe(0);
    expect(() => paymentOwed(lib.db, '999', TODAY)).toThrow(/no payment/);
  });
  it('freezes the amounts when allocated, and notices when the split changes afterwards', () => {
    const before = paymentOwed(lib.db, '300', TODAY);
    const a = allocatePayment(lib.db, root, '300', TODAY, '2026-10-30T00:00:00Z');
    expect(a.allocation).toMatchObject({ at: '2026-10-30T00:00:00Z', changed: false });
    expect(a.allocation!.payees.map((p) => [p.name, p.owed])).toEqual(before.payees.map((p) => [p.name, p.owed]));
    const blake = lib.db.scalar<number>("SELECT id FROM person WHERE name = 'Blake Ashford'")!;
    const loric = lib.db.scalar<number>("SELECT id FROM person WHERE name = 'Loric Thorne'")!;
    setSplit(lib.db, root, A, [{ personId: blake, pct: 50 }, { personId: loric, pct: 50 }]);
    const after = paymentOwed(lib.db, '300', TODAY);
    expect(after.allocation!.changed).toBe(true);
    // the frozen amounts did not move; the live ones did
    expect(after.allocation!.payees.find((p) => p.name === 'Blake Ashford')!.owed).toBe(before.payees.find((p) => p.name === 'Blake Ashford')!.owed);
    expect(after.payees.find((p) => p.name === 'Blake Ashford')!.owed).not.toBe(before.payees.find((p) => p.name === 'Blake Ashford')!.owed);
    // allocating again takes the new split
    expect(allocatePayment(lib.db, root, '300', TODAY).allocation!.changed).toBe(false);
    unallocatePayment(lib.db, root, '300');
    expect(paymentOwed(lib.db, '300', TODAY).allocation).toBeNull();
  });
});

describe('the quarterly roll-up', () => {
  it('adds up what Amazon paid in the quarter and what was unpaid from before', () => {
    const r = payoutRollup(lib.db, Q4, TODAY);
    expect(r.payments.map((p) => p.number)).toEqual(['300']);
    expect(r.totals.owed).toBe(32.44);
    expect(r.totals.carriedIn).toBe(7.12);
    expect(r.totals.due).toBe(39.56);
    expect(r.unallocated).toEqual(['300']);
    const blake = r.payees.find((p) => p.name === 'Blake Ashford')!;
    expect(blake.due).toBe(sum([blake.carriedIn, blake.owed]));
    expect(blake.payments).toHaveLength(1);
    // the Sept Kindle+ was paid in August: Ashe's book B earned 2.50 of it, less 0.13 tax
    expect(r.payees.find((p) => p.name === 'Ashe Wilder')!.carriedIn).toBe(2.37);
    expect(sum(r.payees.map((p) => p.accrued))).toBe(34.15);
  });
  it('shows nothing owed from payments in a quarter with none, but the carried-in balance', () => {
    const r = payoutRollup(lib.db, { from: '2026-07', to: '2026-09' }, TODAY);
    expect(r.payments.map((p) => p.number)).toEqual(['200']);
    expect(r.totals.owed).toBe(7.12);
    expect(r.totals.carriedIn).toBe(0);
  });
  it('takes what has been paid out into account, for the quarter and for earlier ones', () => {
    recordPayout(lib.db, root, { payee: 'Blake Ashford', paidOn: '2026-12-15', usd: 10, period: '2026-10', note: 'bank transfer' });
    recordPayout(lib.db, root, { payee: 'Loric Thorne', paidOn: '2026-09-10', usd: 2, period: '2026-07' });
    const r = payoutRollup(lib.db, Q4, TODAY);
    const blake = r.payees.find((p) => p.name === 'Blake Ashford')!;
    expect(blake.paidOut).toBe(10);
    expect(blake.due).toBe(sum([blake.carriedIn, blake.owed, -10]));
    expect(blake.payouts).toEqual([expect.objectContaining({ usd: 10, note: 'bank transfer' })]);
    const loric = r.payees.find((p) => p.name === 'Loric Thorne')!;
    const noPrior = payoutRollup(lib.db, { from: '2026-10', to: '2026-12' }, TODAY).payees.find((p) => p.name === 'Loric Thorne')!;
    expect(loric.carriedIn).toBe(noPrior.carriedIn);
    expect(listPayouts(lib.db)).toHaveLength(2);
    deletePayout(lib.db, root, listPayouts(lib.db)[0]!.id);
    expect(listPayouts(lib.db)).toHaveLength(1);
  });
  it('uses frozen amounts for allocated payments, flags the rest, and can allocate them all', () => {
    allocatePayment(lib.db, root, '200', TODAY);
    let r = payoutRollup(lib.db, Q4, TODAY);
    expect(r.unallocated).toEqual(['300']);
    expect(allocateRollup(lib.db, root, Q4, TODAY)).toEqual(['300']);
    r = payoutRollup(lib.db, Q4, TODAY);
    expect(r.unallocated).toEqual([]);
    expect(r.changed).toEqual([]);
    const blake = lib.db.scalar<number>("SELECT id FROM person WHERE name = 'Blake Ashford'")!;
    const loric = lib.db.scalar<number>("SELECT id FROM person WHERE name = 'Loric Thorne'")!;
    const owedBefore = r.payees.find((p) => p.name === 'Blake Ashford')!.owed;
    setSplit(lib.db, root, A, [{ personId: blake, pct: 10 }, { personId: loric, pct: 90 }]);
    r = payoutRollup(lib.db, Q4, TODAY);
    expect(r.changed).toEqual(['300']);
    expect(r.payees.find((p) => p.name === 'Blake Ashford')!.owed).toBe(owedBefore);
  });
  it('leaves out a payment dated after today: it has not been received yet', () => {
    importSalesFile(lib.db, root, 'KDP Payments C.xlsx', payments({ head: header('400', '2027-01-15', 13.52, 0.68, 12.84), lines: [['2026-10', 'USD', 13.52, 0.68, 12.84, 'Sales']] }), TODAY);
    const r = payoutRollup(lib.db, { from: '2027-01', to: '2027-03' }, TODAY);
    expect(r.payments).toEqual([]);
    expect(r.scheduled.map((p) => p.number)).toEqual(['400']);
    expect(r.totals.owed).toBe(0);
    // the Q4 payments are still carried in, the scheduled one is not
    expect(r.totals.carriedIn).toBe(39.56);
  });
  it('refuses a payout without a payee, a date, a period or an amount', () => {
    const ok = { payee: 'Blake Ashford', paidOn: '2026-12-15', usd: 5, period: '2026-10' };
    expect(() => recordPayout(lib.db, root, { ...ok, payee: ' ' })).toThrow(/who/);
    expect(() => recordPayout(lib.db, root, { ...ok, paidOn: '15/12/2026' })).toThrow(/date/);
    expect(() => recordPayout(lib.db, root, { ...ok, period: '2026' })).toThrow(/period/);
    expect(() => recordPayout(lib.db, root, { ...ok, usd: 0 })).toThrow(/amount/);
  });
  it('writes CSV and a printable payout statement per author', () => {
    recordPayout(lib.db, root, { payee: 'Blake Ashford', paidOn: '2026-12-15', usd: 10, period: '2026-10' });
    const r = payoutRollup(lib.db, Q4, TODAY);
    const csv = rollupCsv(r);
    expect(csv).toContain('Due now USD');
    expect(csv).toContain('Blake Ashford');
    expect(csv).toContain('Not allocated (worked out now)');
    expect(rollupCsv(r, 'Loric Thorne')).not.toContain('Ashe Wilder');
    const html = rollupHtml(r, 'Blake Ashford');
    expect(html).toContain('Payout statement');
    expect(html).toContain('Due now');
    expect(html).toContain('not been allocated');
    expect(() => rollupHtml(r, 'Nobody')).toThrow();
  });
  it('comes back from the user-data file when the database is lost', () => {
    allocatePayment(lib.db, root, '300', TODAY);
    recordPayout(lib.db, root, { payee: 'Blake Ashford', paidOn: '2026-12-15', usd: 10, period: '2026-10' });
    const before = payoutRollup(lib.db, Q4, TODAY);
    lib.close();
    for (const f of fs.readdirSync(root)) if (f.startsWith('scout.db')) fs.rmSync(path.join(root, f), { force: true });
    lib = Library.open(root);
    const after = payoutRollup(lib.db, Q4, TODAY);
    expect(after.totals).toEqual(before.totals);
    expect(after.unallocated).toEqual(before.unallocated);
    expect(listPayouts(lib.db)).toHaveLength(1);
  });
});
