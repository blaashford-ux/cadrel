import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Library, importSalesFile, kenpRates, listPayments, parsePaymentFile, reconcile, royaltyStatement, savePerson, setSplit, statementCsv, statementHtml, unpaidEarnings, reindexSales, paymentUsd, hasPayments,
} from '../src/index.js';

const A = 'B0AAAAAAA1';
const B = 'B0BBBBBBB2';
const TODAY = new Date('2026-10-22T12:00:00Z');

let root: string;
let lib: Library;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-market-p-'));
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

describe('reading a KDP payment report', () => {
  it('reads the payment, its lines and the pending bank figures, and the long payment number', () => {
    const r = parsePaymentFile('KDP Payments.xlsx', P1());
    expect(r.payments).toHaveLength(1);
    expect(r.payments[0]).toMatchObject({ number: '100001544182740', paidOn: '2026-10-29', currency: 'USD', accrued: 41.65, tax: 2.09, net: 39.56, fxRate: null, payoutAmount: null, payoutCurrency: 'NZD', status: 'Paid', periodFrom: '2026-09-01', periodTo: '2026-09-30' });
    expect(r.payments[0]!.lines).toEqual([
      { month: '2026-09', source: 'sales', currency: 'USD', accrued: 34.15, tax: 1.71, net: 32.44 },
      { month: '2026-09', source: 'kenp', currency: 'USD', accrued: 7.5, tax: 0.38, net: 7.12 },
    ]);
  });
  it('reads the FX rate and payout once the bank has them, and several payments in one file', () => {
    const r = parsePaymentFile('p.xlsx', payments({ head: header('111', '2026-10-29', 10, 0.5, 9.5, 1.7, 16.15), lines: [['2026-08', 'USD', 10, 0.5, 9.5, 'Sales']] }, { head: header('222', '2026-11-29', 5, 0.25, 4.75), lines: [['2026-09', 'USD', 5, 0.25, 4.75, 'Sales']] }));
    expect(r.payments.map((p) => [p.number, p.fxRate, p.payoutAmount, p.lines.length])).toEqual([['111', 1.7, 16.15, 1], ['222', null, null, 1]]);
  });
  it('is not fooled by a royalty workbook', () => {
    expect(parsePaymentFile('x.xlsx', workbook()).payments).toEqual([]);
  });
  it('is stored under its number, replaced when imported again, and rebuilt from the saved file', () => {
    const r = importSalesFile(lib.db, root, 'KDP Payments.xlsx', P1(), TODAY);
    expect(r).toMatchObject({ contains: ['payments'], paymentCount: 1, paymentFrom: '2026-10-29' });
    importSalesFile(lib.db, root, 'KDP Payments.xlsx', payments({ head: header('100001544182740', '2026-10-29', 41.65, 2.09, 39.56, 1.7, 67.25), lines: SEPT }), new Date('2026-10-30T12:00:00Z'));
    expect(listPayments(lib.db)).toHaveLength(1);
    expect(listPayments(lib.db)[0]).toMatchObject({ fxRate: 1.7, payoutAmount: 67.25 });
    expect(lib.db.scalar('SELECT count(*) FROM payment_line')).toBe(2);
    lib.db.exec('DELETE FROM payment_line; DELETE FROM payment;');
    expect(hasPayments(lib.db)).toBe(false);
    reindexSales(lib.db, root);
    expect(listPayments(lib.db)).toHaveLength(1);
  });
});

describe('matching payments to earnings', () => {
  beforeEach(() => {
    importSalesFile(lib.db, root, 'KDP Orders.xlsx', workbook(), TODAY);
    importSalesFile(lib.db, root, 'KDP Payments.xlsx', P1(), TODAY);
  });

  it('prices KENP exactly from the Kindle+ line', () => {
    const r = kenpRates(lib.db).get('2026-09|USD')!;
    expect(r.state).toBe('final');
    expect(r.rate).toBeCloseTo(0.005, 8);
  });
  it('gives every book its share of each line, with the tax, exact to the cent', () => {
    const r = reconcile(lib.db, TODAY);
    expect(r.unmatched).toEqual([]);
    expect(r.differences).toEqual([]);
    expect(sum(r.pieces.map((p) => p.accrued))).toBe(41.65);
    expect(sum(r.pieces.map((p) => p.tax))).toBe(2.09);
    expect(sum(r.pieces.map((p) => p.net))).toBe(39.56);
    const a = r.pieces.find((p) => p.asin === A && p.source === 'ebook')!;
    expect(a).toMatchObject({ accrued: 33.8, month: '2026-09', paymentNumber: '100001544182740', scheduled: true, derived: false });
    expect(r.pieces.find((p) => p.asin === B && p.source === 'kenp')!.accrued).toBe(2.5);
  });
  it('lists what has not been paid yet, by currency', () => {
    const u = unpaidEarnings(lib.db, TODAY);
    expect(u.find((x) => x.month === '2026-09' && x.currency === 'GBP' && x.source === 'ebook')).toMatchObject({ amount: 5 });
    expect(u.find((x) => x.month === '2026-09' && x.currency === 'CAD' && x.source === 'print')).toMatchObject({ amount: 5.96 });
    expect(u.find((x) => x.month === '2026-10' && x.currency === 'USD' && x.source === 'ebook')).toMatchObject({ amount: 13.52 });
    expect(u.some((x) => x.month === '2026-09' && x.currency === 'USD' && x.source !== 'kenp')).toBe(false);
  });
  it('credits what KDP paid, and shows the rest as still owed to the books, when a month was revised after payment', () => {
    importSalesFile(lib.db, root, 'p2.xlsx', payments({ head: header('100001544182740', '2026-10-29', 37.5, 1.88, 35.62), lines: [['2026-09', 'USD', 30, 1.5, 28.5, 'Sales'], SEPT[1]!] }), TODAY);
    const r = reconcile(lib.db, TODAY);
    expect(r.differences).toEqual([expect.objectContaining({ month: '2026-09', source: 'sales', currency: 'USD', reported: 34.15, paid: 30 })]);
    expect(sum(r.pieces.filter((p) => p.source !== 'kenp').map((p) => p.accrued))).toBe(30);
    const s = royaltyStatement(lib.db, { from: '2026-09', to: '2026-09' }, TODAY, 'earned');
    expect(s.differences).toHaveLength(1);
    expect(s.payees.reduce((a, p) => a + p.awaitingUsd, 0)).toBeGreaterThan(4);
  });
  it('lists a payment line for a month with no royalty report as unmatched', () => {
    importSalesFile(lib.db, root, 'p3.xlsx', payments({ head: header('333', '2026-11-29', 3, 0.15, 2.85), lines: [['2026-06', 'USD', 3, 0.15, 2.85, 'Sales']] }), TODAY);
    expect(reconcile(lib.db, TODAY).unmatched).toEqual([{ paymentNumber: '333', month: '2026-06', source: 'sales', currency: 'USD', net: 2.85 }]);
  });
  it('works out the USD of a line in another currency from the payment total', () => {
    importSalesFile(lib.db, root, 'p4.xlsx', payments({ head: header('444', '2026-11-29', 48.5, 2.43, 46.07), lines: [...SEPT, ['2026-09', 'GBP', 5, 0.25, 4.75, 'Sales']] }), TODAY);
    const p = listPayments(lib.db).find((x) => x.number === '444')!;
    const u = paymentUsd(lib.db, p);
    expect(u.find((x) => x.line.currency === 'GBP')).toMatchObject({ accrued: 6.85, derived: true });
    const pieces = reconcile(lib.db, TODAY).pieces.filter((x) => x.paymentNumber === '444');
    expect(sum(pieces.map((x) => x.accrued))).toBe(48.5);
    expect(pieces.some((x) => x.derived)).toBe(true);
  });
});

describe('statements from payments', () => {
  beforeEach(() => {
    importSalesFile(lib.db, root, 'KDP Orders.xlsx', workbook(), TODAY);
    importSalesFile(lib.db, root, 'KDP Payments.xlsx', P1(), TODAY);
    const blake = savePerson(lib.db, root, { name: 'Blake Ashford' });
    const loric = savePerson(lib.db, root, { name: 'Loric Thorne' });
    setSplit(lib.db, root, A, [{ personId: blake.id, pct: 60 }, { personId: loric.id, pct: 40 }]);
  });

  it('paid in the period: the payment dated in the quarter, split by each line, after tax, to the cent', () => {
    const s = royaltyStatement(lib.db, { from: '2026-10', to: '2026-12' }, TODAY, 'paid');
    expect(s.basis).toBe('paid');
    expect(s.reconciled).toBe(true);
    expect(s.payees.map((p) => p.name)).toEqual(['Ashe Wilder', 'Blake Ashford', 'Loric Thorne']);
    expect(sum(s.payees.map((p) => p.totalUsd))).toBe(39.56);
    expect(sum(s.payees.map((p) => p.taxUsd))).toBe(2.09);
    expect(sum(s.payees.map((p) => p.accruedUsd))).toBe(41.65);
    expect(s.payees.every((p) => p.awaitingUsd === 0)).toBe(true);
    expect(s.payees.flatMap((p) => p.lines).every((l) => l.status === 'paid' && l.paymentNumber === '100001544182740' && l.currency === 'USD')).toBe(true);
    expect(s.payments).toEqual([expect.objectContaining({ number: '100001544182740', net: 39.56, scheduled: true })]);
    // Ashe is paid for B only: 0.35 + 2.50 before tax
    expect(s.payees.find((p) => p.name === 'Ashe Wilder')!.accruedUsd).toBe(2.85);
  });
  it('paid in the period: nothing for a quarter before the payment', () => {
    const s = royaltyStatement(lib.db, { from: '2026-07', to: '2026-09' }, TODAY, 'paid');
    expect(s.payees).toEqual([]);
    expect(s.payments).toEqual([]);
  });
  it('earned in the period: paid sales are owed, unpaid ones are estimates that are not owed yet', () => {
    const s = royaltyStatement(lib.db, { from: '2026-09', to: '2026-09' }, TODAY, 'earned');
    expect(sum(s.payees.map((p) => p.totalUsd))).toBe(39.56);
    expect(sum(s.payees.map((p) => p.awaitingUsd))).toBeGreaterThan(8);
    const waiting = s.payees.flatMap((p) => p.lines).filter((l) => l.status === 'awaiting');
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting.every((l) => l.currency !== 'USD')).toBe(true);
    // the owed total never includes an awaiting line
    for (const p of s.payees) expect(p.totalUsd).toBe(sum(p.lines.filter((l) => l.status !== 'awaiting').map((l) => l.usd)));
  });
  it('without any payment report, earned statements are as before and flagged as not checked; paid has nothing', () => {
    lib.db.exec('DELETE FROM payment_line; DELETE FROM payment;');
    const e = royaltyStatement(lib.db, { from: '2026-09', to: '2026-09' }, TODAY, 'earned');
    expect(e.reconciled).toBe(false);
    expect(e.payees.flatMap((p) => p.lines).every((l) => l.status === 'unreconciled')).toBe(true);
    expect(sum(e.payees.map((p) => p.totalUsd))).toBeGreaterThan(40);
    expect(royaltyStatement(lib.db, { from: '2026-10', to: '2026-12' }, TODAY, 'paid').payees).toEqual([]);
  });
  it('writes CSV and a printable page with the payment, tax and unpaid lines', () => {
    const s = royaltyStatement(lib.db, { from: '2026-09', to: '2026-09' }, TODAY, 'earned');
    const csv = statementCsv(s, 'Blake Ashford');
    expect(csv).toContain('Tax withheld USD');
    expect(csv).toContain('100001544182740');
    expect(csv).toContain('Awaiting payment (estimate)');
    expect(csv).not.toContain('Ashe Wilder');
    const html = statementHtml(s, 'Blake Ashford');
    expect(html).toContain('tax withheld by Amazon');
    expect(html).toContain('Not owed yet');
    expect(html).toContain('100001544182740');
    expect(html).toContain('Kindle+');
  });
});
