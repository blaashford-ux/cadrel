import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppService } from '../src/main/service.js';

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-money-'));
  svc = new AppService({ userData: path.join(tmp, 'user'), openExternal: () => {}, revealInFolder: () => {} });
  await svc.setLibrary(path.join(tmp, 'lib'));
});
afterEach(async () => {
  await svc.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('money in the app service', () => {
  it('imports a KDP workbook and reports the month, the analysis and the statement', () => {
    const r = svc.importSales('KDP Orders.xlsx', workbook());
    expect(r.contains).toContain('royalties');
    expect(svc.moneyMonths()).toEqual(['2026-09', '2026-08']);
    const m = svc.moneyMonth('2026-09');
    // 30 + 5 GBP at the default rate, plus 2100 pages at (40.5-30)/2100 = $0.005 and 500 at (7-5)/500 = 0.004 GBP
    expect(m.totals.ebook).toBeGreaterThan(30);
    expect(m.kenp.find((k) => k.currency === 'USD')).toMatchObject({ pages: 2100, state: 'final' });
    expect(m.kenp.find((k) => k.currency === 'USD')!.rate).toBeCloseTo(0.005, 6);
    expect(m.previous).not.toBeNull();
    expect(svc.moneyAnalysis('2026-08', '2026-09').months.map((x) => x.month)).toEqual(['2026-08', '2026-09']);

    const blake = svc.savePerson({ name: 'Blake Ashford' });
    const loric = svc.savePerson({ name: 'Loric Thorne', penNames: ['L. Thorne'] });
    expect(svc.people().map((p) => p.name)).toEqual(['Blake Ashford', 'Loric Thorne']);
    svc.setBookSplit(A, [{ personId: blake.id, pct: 70 }, { personId: loric.id, pct: 30 }]);
    expect(svc.bookSplit(A)[0]!.shares.map((s) => s.pct)).toEqual([70, 30]);
    expect(Object.keys(svc.allSplits())).toEqual([A]);

    const s = svc.statement('2026-08', '2026-09', 'earned');
    expect(s.payees.map((p) => p.name)).toEqual(['Ashe Wilder', 'Blake Ashford', 'Loric Thorne']);
    const total = s.payees.reduce((a, p) => a + p.totalUsd, 0);
    expect(Math.round(total * 100) / 100).toBeCloseTo(svc.moneyAnalysis('2026-08', '2026-09').totals.usd, 2);

    svc.setFxRate('2026-09', 'GBP', 1.5);
    expect(svc.statement('2026-09', '2026-09', 'earned').fx.find((f) => f.currency === 'GBP')).toMatchObject({ toUsd: 1.5, source: 'user' });
    svc.setFxRate('2026-09', 'GBP', null);
    expect(svc.statement('2026-09', '2026-09', 'earned').fx.find((f) => f.currency === 'GBP')!.source).toBe('default');

    const csv = svc.statementFile('2026-09', '2026-09', 'csv', 'Loric Thorne', 'earned');
    expect(csv.filename).toBe('royalty-statement-Loric-Thorne-earned-2026-09.csv');
    expect(csv.content).toContain('Loric Thorne,2026-09,Anthology');
    expect(csv.content).not.toContain('Blake Ashford');
    expect(svc.statementFile('2026-08', '2026-09', 'html', 'Blake Ashford', 'earned').content).toContain('Royalty statement');
    expect(() => svc.statementFile('2026-09', '2026-09', 'html', null, 'earned')).toThrow(/choose an author/);
  });

  it('finds the authors on the books and splits by name without anyone being added first', () => {
    svc.importSales('KDP Orders.xlsx', workbook());
    expect(svc.detectedAuthors().map((d) => [d.name, d.asins, d.personId])).toEqual([['Ashe Wilder', [B], null], ['Blake Ashford', [A], null]]);
    svc.setBookSplit(A, [{ name: 'Blake Ashford', pct: 50 }, { name: 'Ashe Wilder', pct: 50 }]);
    expect(svc.people().map((p) => p.name)).toEqual(['Ashe Wilder', 'Blake Ashford']);
    expect(svc.detectedAuthors().every((d) => d.personId !== null)).toBe(true);
    expect(svc.statement('2026-08', '2026-09', 'earned').payees.map((p) => p.name)).toEqual(['Ashe Wilder', 'Blake Ashford']);
  });

  it('imports a KDP payment report and builds statements from what Amazon paid', () => {
    svc.importSales('KDP Orders.xlsx', workbook());
    const pay = xlsx({ Payments: [
      ['Sales Period - Start Date', 'Sales Period - End Date', 'Marketplace', 'Payment Number', 'Detail', 'Date', 'Payment Method', 'Currency', 'Accrued Royalty', 'Tax Withholding', 'Net Earnings', 'Source', 'FX Rate', 'Currency', 'Payout Amount', 'Payment Status'],
      ['2026-08-01', '2026-09-30', 'Amazon.com', '500', '', '2026-11-29', 'WIRE', 'USD', 30, 1.5, 28.5, '', 'Pending info from Bank', 'NZD', 'Pending info from Bank', 'Paid'],
      ['', '', '', '', '2026-09', '', '', 'USD', 20, 1, 19, 'Sales', '', '', '', ''],
      ['', '', '', '', '2026-08', '', '', 'USD', 10, 0.5, 9.5, 'Sales', '', '', '', ''],
    ] });
    const r = svc.importSales('KDP Payments.xlsx', pay);
    expect(r).toMatchObject({ contains: ['payments'], paymentCount: 1 });
    const rep = svc.payments();
    expect(rep.payments).toHaveLength(1);
    expect(rep.payments[0]).toMatchObject({ number: '500', accrued: 30, tax: 1.5, net: 28.5, fxRate: null });
    expect(rep.unpaid.some((u) => u.currency === 'GBP')).toBe(true);
    const paid = svc.statement('2026-10', '2026-12', 'paid');
    expect(paid.reconciled).toBe(true);
    expect(Math.round(paid.payees.reduce((a, p) => a + p.totalUsd, 0) * 100) / 100).toBe(28.5);
    expect(svc.statement('2026-07', '2026-09', 'paid').payees).toEqual([]);
    const f = svc.statementFile('2026-10', '2026-12', 'csv', null, 'paid');
    expect(f.filename).toBe('royalty-statement-paid-2026-10_to_2026-12.csv');
    expect(f.content).toContain('Tax withheld USD');
    expect(() => svc.statement('2026-10', '2026-12', 'bogus' as never)).toThrow(/basis/);
    svc.removePayment('500');
    expect(svc.payments().payments).toEqual([]);
    expect(() => svc.removePayment('x; drop')).toThrow(/bad payment number/);
  });

  it('calculates a payment, allocates it and rolls the quarter up with payouts', () => {
    svc.importSales('KDP Orders.xlsx', workbook());
    svc.importSales('KDP Payments.xlsx', xlsx({ Payments: [
      ['Sales Period - Start Date', 'Sales Period - End Date', 'Marketplace', 'Payment Number', 'Detail', 'Date', 'Payment Method', 'Currency', 'Accrued Royalty', 'Tax Withholding', 'Net Earnings', 'Source', 'FX Rate', 'Currency', 'Payout Amount', 'Payment Status'],
      ['2026-08-01', '2026-09-30', 'Amazon.com', '500', '', '2026-11-20', 'WIRE', 'USD', 20, 1, 19, '', 1.7, 'NZD', 32.3, 'Paid'],
      ['', '', '', '', '2026-09', '', '', 'USD', 20, 1, 19, 'Sales', '', '', '', ''],
    ] }));
    const blake = svc.savePerson({ name: 'Blake Ashford' });
    svc.setBookSplit(A, [{ personId: blake.id, pct: 100 }]);
    const o = svc.paymentOwed('500');
    expect(o.totalOwed).toBe(19);
    expect(o.allocation).toBeNull();
    expect(svc.allocatePayment('500').allocation!.changed).toBe(false);
    expect(svc.payments().allocated['500']).toBeTruthy();
    // the 20 November payment is before "today" in this test only if today is after it, so ask for a period that has passed
    const r = svc.payoutRollup('2026-11', '2026-11');
    expect(r.payments.length + r.scheduled.length).toBe(1);
    const p = svc.recordPayout({ payee: 'Blake Ashford', paidOn: '2026-12-01', usd: 5, period: '2026-11', note: 'wire' });
    expect(svc.payouts()).toEqual([expect.objectContaining({ id: p.id, usd: 5 })]);
    expect(svc.payoutRollup('2026-11', '2026-11').payees.find((x) => x.name === 'Blake Ashford')!.paidOut).toBe(5);
    const csv = svc.paymentFile('500', 'csv', null);
    expect(csv.filename).toBe('payment-500.csv');
    expect(csv.content).toContain('Blake Ashford');
    expect(svc.paymentFile('500', 'html', 'Blake Ashford').content).toContain('Royalty statement');
    expect(svc.rollupFile('2026-11', '2026-11', 'csv', null).content).toContain('Due now USD');
    expect(() => svc.rollupFile('2026-11', '2026-11', 'html', null)).toThrow(/choose an author/);
    expect(svc.allocateRollup('2026-11', '2026-11')).toEqual([]);
    svc.deletePayout(p.id);
    expect(svc.payouts()).toEqual([]);
    svc.unallocatePayment('500');
    expect(svc.paymentOwed('500').allocation).toBeNull();
    expect(() => svc.paymentOwed('x')).toThrow(/bad payment number/);
    expect(() => svc.recordPayout({ payee: 'B', paidOn: '2026-12-01', usd: -1, period: '2026-11' })).toThrow(/amount/);
  });

  it('refuses bad input', () => {
    expect(() => svc.moneyMonth('2026-13')).toThrow(/bad period/);
    expect(() => svc.statement('2026-10', '2026-09', 'earned')).toThrow(/bad period/);
    expect(() => svc.setBookSplit('nope', [])).toThrow(/bad ASIN/);
    const p = svc.savePerson({ name: 'X' });
    expect(() => svc.setBookSplit(A, [{ personId: p.id, pct: 90 }])).toThrow(/100/);
  });
});
