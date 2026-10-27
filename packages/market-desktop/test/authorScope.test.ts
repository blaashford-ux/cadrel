import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppService } from '../src/main/service.js';

const A = 'B0AAAAAAA1';
const B = 'B0BBBBBBB2';

function xlsx(rows: (string | number)[][]): Uint8Array {
  const strings: string[] = [];
  const sst = (s: string) => { const i = strings.indexOf(s); if (i >= 0) return i; strings.push(s); return strings.length - 1; };
  const col = (i: number) => String.fromCharCode(65 + i);
  const sheet = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => (typeof v === 'number' ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="s"><v>${sst(v)}</v></c>`)).join('')}</row>`).join('');
  return zipSync({
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${sheet}</sheetData></worksheet>`),
    'xl/sharedStrings.xml': strToU8(`<sst>${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`),
    'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="eBook Royalty" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
  });
}
const HEAD = ['Royalty Date', 'Title', 'Author Name', 'ASIN', 'Marketplace', 'Royalty Type', 'Transaction Type', 'Units Sold', 'Units Refunded', 'Net Units Sold', 'Royalty', 'Currency'];
const row = (t: string, au: string, a: string) => ['2026-09', t, au, a, 'Amazon.com', '70%', 'Standard', 3, 0, 3, 9, 'USD'];
const report = () => xlsx([HEAD, row('Anthology', 'Blake Ashford', A), row('Lead Me', 'Ashe Wilder', B)]);

let tmp: string;
let scope: string[] | null;
let svc: AppService;
beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-authorscope-'));
  scope = ['Blake Ashford'];
  svc = new AppService({ userData: path.join(tmp, 'user'), openExternal: () => {}, revealInFolder: () => {}, authorScope: () => scope });
  await svc.setLibrary(path.join(tmp, 'lib'));
});
afterEach(async () => {
  await svc.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a Studio’s pen names limit what Market imports and shows', () => {
  it('brings in only the Studio’s pen names, and says what it left out', () => {
    const r = svc.importSales('KDP.xlsx', report());
    expect(r.newBooks).toBe(1);
    expect(r.excluded).toMatchObject({ books: 1, authors: ['Ashe Wilder'] });
    expect(svc.ownBooks().map((b) => b.asin)).toEqual([A]);
  });

  it('brings in nothing while the Studio has no pen names', () => {
    scope = [];
    const r = svc.importSales('KDP.xlsx', report());
    expect(r.noPenNames).toBe(true);
    expect(svc.ownBooks()).toEqual([]);
  });

  it('hides books of other pen names when the pen names change, and removes them only when asked', () => {
    scope = null;
    svc.importSales('KDP.xlsx', report());
    expect(svc.ownBooks().map((b) => b.asin).sort()).toEqual([A, B]);
    expect(svc.booksOutsideScope()).toEqual([]);
    scope = ['Ashe Wilder'];
    expect(svc.ownBooks().map((b) => b.asin)).toEqual([B]);
    expect(svc.booksOutsideScope().map((b) => b.asin)).toEqual([A]);
    expect(svc.removeBooksOutsideScope()).toBe(1);
    scope = null;
    expect(svc.ownBooks().map((b) => b.asin)).toEqual([B]);
  });
});
