import { describe, expect, it } from 'vitest';
import { authorFinance, type PublishedBook } from '../src/main/authorFinance';
import type { MonthReport } from '../src/shared/api';

/** One book's report for one month, as the publisher's library makes it with the book named. */
function report(asin: string, month: string, o: { ebook: number; print?: number; kenp?: number; units: number; pages?: number; prev?: number; market?: string }): MonthReport {
  const print = o.print ?? 0, kenp = o.kenp ?? 0, usd = o.ebook + print + kenp, pages = o.pages ?? 0;
  return {
    from: month, to: month, month,
    totals: { usd, ebook: o.ebook, print, kenp, units: o.units, freeUnits: 0, pages, estimated: 0, pending: 0 },
    months: [{ month, usd, ebook: o.ebook, print, kenp, units: o.units, freeUnits: 0, pages, state: 'final' }],
    books: [{ asin, title: `Book ${asin}`, usd, ebook: o.ebook, print, kenp, units: o.units, pages, share: 1, estimated: 0 }],
    marketplaces: [{ key: o.market ?? 'amazon.com', usd, units: o.units }], royaltyTypes: [{ key: '70%', usd, units: o.units }], transactions: [{ key: 'Standard', usd, units: o.units }],
    daily: [{ day: `${month}-02`, units: o.units, free: 0, pages }], missingRoyalty: [],
    previous: o.prev === undefined ? null : { month: '2026-08', usd: o.prev }, lastYear: null, previousByBook: o.prev === undefined ? {} : { [asin]: o.prev },
    kenp: pages ? [{ currency: 'USD', rate: 0.005, state: 'final', pages }] : []
  } as MonthReport;
}

const books: PublishedBook[] = [
  { asin: 'B0AAAAAAA1', title: 'One', months: [{ month: '2026-09', report: report('B0AAAAAAA1', '2026-09', { ebook: 10, kenp: 5, units: 4, pages: 1000, prev: 8 }) }, { month: '2026-10', report: report('B0AAAAAAA1', '2026-10', { ebook: 20, units: 6 }) }] },
  { asin: 'B0AAAAAAA2', title: 'Two', months: [{ month: '2026-09', report: report('B0AAAAAAA2', '2026-09', { ebook: 1.5, print: 2, units: 3, market: 'amazon.co.uk', prev: 2 }) }] }
];
const fin = authorFinance(books);

describe('an author’s Finance, from the months published for their books', () => {
  it('is ready only when something was published, and lists the months newest first', () => {
    expect(authorFinance([]).ready()).toBe(false);
    expect(authorFinance([{ asin: 'B0AAAAAAA1', title: 'x', months: [] }]).ready()).toBe(false);
    expect(fin.ready()).toBe(true);
    expect(fin.moneyMonths()).toEqual(['2026-10', '2026-09']);
    expect(fin.books().map((b) => b.asin)).toEqual(['B0AAAAAAA1', 'B0AAAAAAA2']);
  });

  it('adds the author’s books together for a month, and keeps each book as a row', () => {
    const m = fin.moneyMonth('2026-09');
    expect(m.totals.usd).toBeCloseTo(18.5, 2);
    expect(m.totals).toMatchObject({ ebook: 11.5, print: 2, kenp: 5, units: 7, pages: 1000 });
    expect(m.books.map((b) => b.asin)).toEqual(['B0AAAAAAA1', 'B0AAAAAAA2']);
    expect(m.books[0]!.share).toBeCloseTo(15 / 18.5, 5);
    expect(m.marketplaces.map((x) => x.key).sort()).toEqual(['amazon.co.uk', 'amazon.com']);
    expect(m.previous).toEqual({ month: '2026-08', usd: 10 });
    expect(m.previousByBook).toEqual({ B0AAAAAAA1: 8, B0AAAAAAA2: 2 });
    expect(m.kenp).toEqual([{ currency: 'USD', rate: 0.005, state: 'final', pages: 1000 }]);
    expect(m.daily).toEqual([{ day: '2026-09-02', units: 7, free: 0, pages: 1000 }]);
  });

  it('limits a month or a period to one of the books when asked', () => {
    expect(fin.moneyMonth('2026-09', 'B0AAAAAAA2').totals.usd).toBeCloseTo(3.5, 2);
    expect(fin.moneyAnalysis('2026-09', '2026-10', 'B0AAAAAAA2').totals.usd).toBeCloseTo(3.5, 2);
  });

  it('gives a period as a row per month, with quiet months as zero rows, and per-book totals', () => {
    const a = fin.moneyAnalysis('2026-08', '2026-10');
    expect(a.months.map((x) => x.month)).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(a.months[0]).toMatchObject({ usd: 0, units: 0 });
    expect(a.totals.usd).toBeCloseTo(18.5 + 20, 2);
    expect(a.books.find((b) => b.asin === 'B0AAAAAAA1')).toMatchObject({ usd: 35, units: 10 });
    expect(a.books[0]!.asin).toBe('B0AAAAAAA1');
    expect(a.books.reduce((n, b) => n + b.share, 0)).toBeCloseTo(1, 5);
  });

  it('shows nothing for a month with nothing published, and refuses a malformed month', () => {
    expect(fin.moneyMonth('2026-07').totals.usd).toBe(0);
    expect(fin.moneyMonth('2026-07').books).toEqual([]);
    expect(() => fin.moneyMonth('July')).toThrow(/2026-09/);
    expect(() => fin.moneyAnalysis('2026-10', '2026-09')).toThrow(/period/);
  });
});
