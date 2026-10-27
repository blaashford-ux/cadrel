/**
 * My Books: the portal for a published book. It assembles what Market and Finance know about one book and saves through their own
 * generators (the same `exportContent` / `statementFile` Market's and Finance's own Save buttons call), so output is identical and there is
 * one implementation. It keeps no data of its own. Electron-free; tested in test/mybooks.test.ts.
 *
 * Finance's figures are shown only to roles that hold `royalties.read`. An Author holds it for their own books only, which cannot be
 * told apart until agreements exist (M7), so until then an Author sees no figures: they are left out, never shown as zero.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { ROLE_KEYS, defaultRole } from '@cadrel/kernel';
import { uniqueName } from '@cadrel/write/src/shared/projects';
import type { AppService } from '@cadrel/market-desktop/src/main/service';
import type { BookPage, BookSaveResult, MyBookRow, MyBooksList } from '../shared/api';

export class MyBooksError extends Error {}

/** May this role see Finance's figures here? */
export function financeAccess(roleKey: string | null | undefined): boolean {
  if (!roleKey || !(ROLE_KEYS as readonly string[]).includes(roleKey)) return false;
  if (roleKey === 'author') return false;
  const r = defaultRole(roleKey as (typeof ROLE_KEYS)[number]);
  return !!r.all || r.capabilities.includes('royalties.read');
}

/** The part of the library service My Books reads. */
export type BookService = Pick<
  AppService,
  'status' | 'ownBooks' | 'ownBook' | 'book' | 'bookLists' | 'cover' | 'moneyMonths' | 'moneyAnalysis' | 'bookSplit' | 'exportContent' | 'statement' | 'statementFile' | 'bookEarningsFile'
>;

const shift = (m: string, by: number): string => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, mo - 1 + by, 1)).toISOString().slice(0, 7);
};

/** Month by month for one book, newest first: what each month's analysis says about this ASIN alone. */
function monthsFor(svc: BookService, asin: string, limit: number): NonNullable<BookPage['finance']>['months'] {
  const out: NonNullable<BookPage['finance']>['months'] = [];
  for (const m of svc.moneyMonths().slice(0, limit)) {
    const r = svc.moneyAnalysis(m, m);
    const b = r.books.find((x) => x.asin === asin);
    if (!b || (!b.usd && !b.units && !b.pages)) continue;
    out.push({ month: m, usd: b.usd, units: b.units, pages: b.pages, state: r.months[0]?.state ?? 'final' });
  }
  return out;
}

export function listBooks(svc: BookService, financeVisible: boolean): MyBooksList {
  if (!svc.status().libraryRoot) return { available: false, books: [], financeVisible };
  const books: MyBookRow[] = svc.ownBooks().map((b) => {
    let money: MyBookRow['money'] = null;
    if (financeVisible) {
      const last = monthsFor(svc, b.asin, 1)[0] ?? null;
      money = { paidUnits: b.paidUnits, kenpPages: b.kenpPages, lastSaleDay: b.lastSaleDay, lastMonth: last?.month ?? null, lastMonthUsd: last?.usd ?? null, lastMonthState: last?.state ?? null };
    }
    return {
      asin: b.asin, title: b.title ?? b.asin, penNames: b.penNames, authors: b.authorNames, captured: b.snapshots > 0, overallRank: b.overallRank, listRank: b.listRank,
      kindlePrice: b.kindlePrice, ratingValue: b.ratingValue, ratingCount: b.ratingCount, money
    };
  });
  return { available: true, books, financeVisible };
}

export function bookPage(svc: BookService, asin: string, financeVisible: boolean, monthsShown = 12): BookPage | null {
  if (!svc.status().libraryRoot) return null;
  const own = svc.ownBook(asin);
  if (!own) return null;
  const detail = svc.book(asin);
  const history = (detail?.history ?? []).map((h) => ({ capturedAt: h.capturedAt, price: h.kindlePrice, rank: h.overallRank, ratings: h.ratingCount }));
  const page: BookPage = {
    asin, title: own.title ?? asin, penNames: own.penNames, authors: own.authorNames, cover: svc.cover(asin), source: own.source, addedAt: own.addedAt,
    market: {
      captured: own.snapshots > 0, lastCaptured: own.lastCaptured, overallRank: own.overallRank, listRank: own.listRank, listCategory: own.listCategory, kindlePrice: own.kindlePrice,
      ratingValue: own.ratingValue, ratingCount: own.ratingCount, text: own.text, history, categories: svc.bookLists(asin).map((c) => ({ key: c.key, name: c.name ?? c.key }))
    },
    finance: null
  };
  if (financeVisible) {
    const months = monthsFor(svc, asin, monthsShown);
    const splits = svc.bookSplit(asin);
    const cur = splits[splits.length - 1] ?? null;
    const detailed = months.length ? svc.moneyAnalysis(months[months.length - 1]!.month, months[0]!.month).books.find((b) => b.asin === asin) : undefined;
    page.finance = {
      hasData: own.paidUnits > 0 || own.kenpPages > 0 || months.length > 0,
      paidUnits: own.paidUnits, kenpPages: own.kenpPages, firstSaleDay: own.firstSaleDay, lastSaleDay: own.lastSaleDay,
      months, totalUsd: months.reduce((a, m) => a + m.usd, 0), estimatedUsd: detailed?.estimated ?? 0,
      split: cur ? { fromMonth: cur.fromMonth, shares: cur.shares.map((s) => ({ name: s.name, pct: s.pct })) } : null,
      payees: cur ? cur.shares.map((s) => s.name) : []
    };
  }
  return page;
}

// ---- saving -----------------------------------------------------------------------------------------------------------------

const slug = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Book';

/** Writes statements as PDFs (Finance's printer); given by the host so this file stays free of Electron. */
export type PdfStatements = (dir: string, from: string, to: string, payees: string[], basis: 'paid' | 'earned') => Promise<string[]>;

async function freshFolder(parent: string, name: string): Promise<string> {
  const existing = await fsp.readdir(parent).catch(() => [] as string[]);
  const dir = path.join(parent, uniqueName(name, existing));
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function writeMarket(svc: BookService, page: BookPage, dir: string, topN: number): Promise<string[]> {
  if (!page.market.categories.length) return [];
  const out: string[] = [];
  await fsp.mkdir(dir, { recursive: true });
  for (const c of page.market.categories) {
    for (const kind of ['csv', 'md'] as const) {
      const { filename, content } = await svc.exportContent(c.key, kind, topN);
      const file = path.join(dir, filename);
      await fsp.writeFile(file, content);
      out.push(file);
    }
  }
  return out;
}

async function writeFinance(svc: BookService, page: BookPage, dir: string, months: number, pdf: PdfStatements | null): Promise<string[]> {
  if (!page.finance) throw new MyBooksError('Your role does not include royalties, so there are no figures to save.');
  if (!page.finance.hasData) return [];
  const out: string[] = [];
  await fsp.mkdir(dir, { recursive: true });
  const book = svc.bookEarningsFile(page.asin, months);
  const earnings = path.join(dir, book.filename);
  await fsp.writeFile(earnings, book.content);
  out.push(earnings);
  const latest = svc.moneyMonths()[0];
  if (!latest) return out;
  const from = shift(latest, -(Math.max(1, months) - 1));
  // What authors were paid, once a KDP payment report has been imported; until then what they have earned (Finance shows the same choice).
  const paid = svc.statement(from, latest, 'paid');
  const basis = paid.reconciled ? 'paid' : 'earned';
  const statement = paid.reconciled ? paid : svc.statement(from, latest, 'earned');
  const payees = statement.payees.filter((p) => p.lines.some((l) => l.asin === page.asin)).map((p) => p.name);
  for (const name of payees) {
    const f = svc.statementFile(from, latest, 'csv', name, basis);
    const file = path.join(dir, f.filename);
    await fsp.writeFile(file, f.content);
    out.push(file);
  }
  if (pdf && payees.length) out.push(...(await pdf(dir, from, latest, payees, basis)));
  return out;
}

export interface SaveOptions {
  /** The folder the person chose; a folder for this book is made inside it. */
  parent: string;
  months?: number;
  /** Categories exported per book are the top this many books. Market's own Export uses its page's setting; 50 is the page's usual. */
  topN?: number;
  pdf?: PdfStatements | null;
}

export async function saveBook(svc: BookService, asin: string, what: 'market' | 'finance' | 'all', financeVisible: boolean, o: SaveOptions): Promise<BookSaveResult> {
  const page = bookPage(svc, asin, financeVisible, 24);
  if (!page) throw new MyBooksError('That book is not in My Books.');
  if (what !== 'market' && !page.finance) {
    if (what === 'finance') throw new MyBooksError('Your role does not include royalties, so there are no figures to save.');
  }
  const folder = await freshFolder(o.parent, `${slug(page.title)} (${asin})`);
  const files: string[] = [];
  if (what !== 'finance') files.push(...(await writeMarket(svc, page, path.join(folder, 'Market'), o.topN ?? 50)));
  if (what !== 'market' && page.finance) files.push(...(await writeFinance(svc, page, path.join(folder, 'Finance'), o.months ?? 12, o.pdf ?? null)));
  if (!files.length) {
    await fsp.rm(folder, { recursive: true, force: true });
    throw new MyBooksError(what === 'market' ? 'This book is in none of the captured category lists, so there is no Market export for it yet.' : 'There is nothing to save for this book yet. Import a KDP report in Finance first.');
  }
  return { folder, files };
}
