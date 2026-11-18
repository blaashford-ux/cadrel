/**
 * What an Author sees in Finance: the figures the publisher's Cadrel published to the Studio for the books they wrote. Each published month is
 * one book's report for that month (never with another book in it). This turns them into the same reports the publisher's own Finance screens
 * draw (the Analysis charts and the Month view), by adding the books' months together, so the Author sees the same charts and tables for their
 * books. Electron-free; tested in test/authorFinance.test.ts.
 */
import type { AnalysisReport, MonthReport } from '../shared/api.js';

/** One book's published months, as the Studio holds them. */
export interface PublishedBook {
  asin: string;
  title: string;
  months: { month: string; report: MonthReport }[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const shift = (m: string, by: number): string => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, mo - 1 + by, 1)).toISOString().slice(0, 7);
};
const monthsBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let m = from; m <= to && out.length < 600; m = shift(m, 1)) out.push(m);
  return out;
};

type Slice = { key: string; usd: number; units: number };
function mergeSlices(lists: Slice[][]): Slice[] {
  const by = new Map<string, Slice>();
  for (const s of lists.flat()) {
    const cur = by.get(s.key) ?? { key: s.key, usd: 0, units: 0 };
    cur.usd = r2(cur.usd + s.usd);
    cur.units += s.units;
    by.set(s.key, cur);
  }
  return [...by.values()].sort((a, b) => b.usd - a.usd);
}

/** The month reports of all of an author's books, added together as one month: the same shape the publisher's Month view takes. */
function oneMonth(month: string, reports: MonthReport[]): MonthReport {
  const sum = (f: (r: MonthReport) => number) => reports.reduce((n, r) => n + f(r), 0);
  const money = (pick: (r: MonthReport) => number) => r2(sum(pick));
  const totals = {
    usd: money((r) => r.totals.usd), ebook: money((r) => r.totals.ebook), print: money((r) => r.totals.print), kenp: money((r) => r.totals.kenp),
    units: sum((r) => r.totals.units), freeUnits: sum((r) => r.totals.freeUnits), pages: sum((r) => r.totals.pages), estimated: money((r) => r.totals.estimated), pending: money((r) => r.totals.pending)
  };
  const state = reports.some((r) => r.months[0]?.state === 'pending') ? 'pending' : reports.some((r) => r.months[0]?.state === 'estimated') ? 'estimated' : 'final';
  const days = new Map<string, { day: string; units: number; free: number; pages: number }>();
  for (const d of reports.flatMap((r) => r.daily)) {
    const cur = days.get(d.day) ?? { day: d.day, units: 0, free: 0, pages: 0 };
    cur.units += d.units; cur.free += d.free; cur.pages += d.pages;
    days.set(d.day, cur);
  }
  const books = reports.flatMap((r) => r.books).sort((a, b) => b.usd - a.usd).map((b) => ({ ...b, share: totals.usd ? b.usd / totals.usd : 0 }));
  const lastOf = (pick: (r: MonthReport) => { month: string; usd: number } | null) => {
    const found = reports.map(pick).filter((x): x is { month: string; usd: number } => !!x);
    return found.length ? { month: found[0]!.month, usd: r2(found.reduce((n, x) => n + x.usd, 0)) } : null;
  };
  const kenp = new Map<string, MonthReport['kenp'][number]>();
  for (const k of reports.flatMap((r) => r.kenp)) {
    const cur = kenp.get(k.currency);
    kenp.set(k.currency, cur ? { ...cur, pages: cur.pages + k.pages, state: cur.state === 'estimated' || k.state === 'estimated' ? 'estimated' : 'final' } : { ...k });
  }
  return {
    from: month, to: month, month, totals,
    months: [{ month, usd: totals.usd, ebook: totals.ebook, print: totals.print, kenp: totals.kenp, units: totals.units, freeUnits: totals.freeUnits, pages: totals.pages, state }],
    books, marketplaces: mergeSlices(reports.map((r) => r.marketplaces)), royaltyTypes: mergeSlices(reports.map((r) => r.royaltyTypes)), transactions: mergeSlices(reports.map((r) => r.transactions)),
    daily: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    missingRoyalty: [...new Set(reports.flatMap((r) => r.missingRoyalty))].sort(),
    previous: lastOf((r) => r.previous), lastYear: lastOf((r) => r.lastYear),
    previousByBook: Object.assign({}, ...reports.map((r) => r.previousByBook)),
    kenp: [...kenp.values()].sort((a, b) => b.pages - a.pages)
  };
}

/** Several months, as one period report (the Analysis view). */
function period(from: string, to: string, months: MonthReport[]): AnalysisReport {
  const rows = monthsBetween(from, to).map((m) => months.find((x) => x.month === m) ?? null);
  const have = rows.filter((x): x is MonthReport => !!x);
  const sum = (f: (r: MonthReport) => number) => have.reduce((n, r) => n + f(r), 0);
  const totals = {
    usd: r2(sum((r) => r.totals.usd)), ebook: r2(sum((r) => r.totals.ebook)), print: r2(sum((r) => r.totals.print)), kenp: r2(sum((r) => r.totals.kenp)),
    units: sum((r) => r.totals.units), freeUnits: sum((r) => r.totals.freeUnits), pages: sum((r) => r.totals.pages), estimated: r2(sum((r) => r.totals.estimated)), pending: r2(sum((r) => r.totals.pending))
  };
  const books = new Map<string, AnalysisReport['books'][number]>();
  for (const b of have.flatMap((r) => r.books)) {
    const cur = books.get(b.asin) ?? { ...b, usd: 0, ebook: 0, print: 0, kenp: 0, units: 0, pages: 0, share: 0, estimated: 0 };
    cur.usd = r2(cur.usd + b.usd); cur.ebook = r2(cur.ebook + b.ebook); cur.print = r2(cur.print + b.print); cur.kenp = r2(cur.kenp + b.kenp);
    cur.units += b.units; cur.pages += b.pages; cur.estimated = r2(cur.estimated + b.estimated);
    books.set(b.asin, cur);
  }
  return {
    from, to, totals,
    months: monthsBetween(from, to).map((m, i) => rows[i]?.months[0] ?? { month: m, usd: 0, ebook: 0, print: 0, kenp: 0, units: 0, freeUnits: 0, pages: 0, state: 'final' as const }),
    books: [...books.values()].sort((a, b) => b.usd - a.usd).map((b) => ({ ...b, share: totals.usd ? b.usd / totals.usd : 0 })),
    marketplaces: mergeSlices(have.map((r) => r.marketplaces)), royaltyTypes: mergeSlices(have.map((r) => r.royaltyTypes)), transactions: mergeSlices(have.map((r) => r.transactions)),
    daily: have.flatMap((r) => r.daily).sort((a, b) => a.day.localeCompare(b.day)),
    missingRoyalty: [...new Set(have.flatMap((r) => r.missingRoyalty))].filter((m) => m >= from && m <= to).sort()
  };
}

/** The part of Finance an Author has: the charts and analysis and the month view, over the books they wrote. */
export interface AuthorFinance {
  /** Whether anything has been published for any of the books. */
  ready(): boolean;
  moneyMonths(): string[];
  moneyAnalysis(from: string, to: string, asin?: string): AnalysisReport;
  moneyMonth(month: string, asin?: string): MonthReport;
  /** The books with figures, for the pages that name them. */
  books(): { asin: string; title: string }[];
}

export function authorFinance(published: PublishedBook[]): AuthorFinance {
  const byMonth = (month: string, asin?: string): MonthReport[] =>
    published.filter((b) => !asin || b.asin === asin).flatMap((b) => b.months.filter((m) => m.month === month).map((m) => m.report));
  const months = [...new Set(published.flatMap((b) => b.months.map((m) => m.month)))].sort().reverse();
  const month = (m: string, asin?: string): MonthReport => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new Error('A month is written 2026-09.');
    return oneMonth(m, byMonth(m, asin));
  };
  return {
    ready: () => published.some((b) => b.months.length > 0),
    moneyMonths: () => months,
    moneyMonth: month,
    moneyAnalysis(from, to, asin) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(from) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(to) || from > to) throw new Error('A period is two months, the first not after the second.');
      return period(from, to, monthsBetween(from, to).filter((m) => byMonth(m, asin).length).map((m) => month(m, asin)));
    },
    books: () => published.filter((b) => b.months.length).map((b) => ({ asin: b.asin, title: b.title }))
  };
}
