import type { Db } from '../schema.js';
import { exportUserData } from '../userdata.js';
import { bookAliases, marketplaceCurrency } from './royalty.js';

/**
 * What each book earned each month, in the currency KDP paid it in, with a USD figure beside it.
 *
 * Three sources: eBook royalties and print royalties (KDP's royalty sheets, exact) and Kindle Unlimited pages read (KENP), which
 * is pages times a rate per page. KDP fixes a month's rate around the 15th of the next month: after that, Summary minus the
 * sheets gives the money KDP paid for KENP in each currency, so the rate is exact ("final"). Before that the last final rate of
 * the currency stands in ("estimated"), and the current month's KENP is "pending" and left out of what is owed.
 */

export type EarningSource = 'ebook' | 'print' | 'kenp';
export type EarningState = 'final' | 'estimated' | 'pending';

export interface Earning {
  asin: string;
  month: string;
  source: EarningSource;
  currency: string;
  amount: number;
  /** Net units for royalty lines, KENP pages for KENP lines. */
  quantity: number;
  state: EarningState;
}

export interface MoneyLine extends Earning {
  usd: number;
  /** Where the USD rate came from: KDP's currency is already USD, a rate the user set, or the app's default. */
  fx: 'usd' | 'user' | 'default';
}

/** Rough rates (USD per unit of currency) used until the user sets a month's rate. */
export const DEFAULT_FX: Record<string, number> = { USD: 1, GBP: 1.27, EUR: 1.08, CAD: 0.73, AUD: 0.65, JPY: 0.0065, INR: 0.012, BRL: 0.18, MXN: 0.055, PLN: 0.25, SEK: 0.095 };
/** KENP per page, used when a currency has never had a final month. */
export const DEFAULT_KENP_RATE: Record<string, number> = { USD: 0.0045, GBP: 0.0033, EUR: 0.003, CAD: 0.0042, AUD: 0.004, JPY: 0.0045 * 150, INR: 0.0045 * 83, BRL: 0.0045 * 5.5, MXN: 0.0045 * 18, PLN: 0.0045 * 4, SEK: 0.0045 * 10 };

const cents = (n: number) => Math.round(n * 100) / 100;
export const monthOfDay = (d: string) => d.slice(0, 7);
export const thisMonth = (now = new Date()) => now.toISOString().slice(0, 7);

export interface KenpRate { month: string; currency: string; rate: number; state: 'final' | 'estimated'; user: boolean }

/** The KENP rate per page for every month and currency that has pages read. */
export function kenpRates(db: Db): Map<string, KenpRate> {
  const pages = db.prepare(`SELECT substr(day, 1, 7) AS month, marketplace, SUM(pages) AS pages FROM kenp_day GROUP BY month, marketplace`).all() as unknown as { month: string; marketplace: string; pages: number }[];
  const pageSum = new Map<string, number>();
  for (const r of pages) { const k = `${r.month}|${marketplaceCurrency(r.marketplace)}`; pageSum.set(k, (pageSum.get(k) ?? 0) + r.pages); }
  const sheets = new Map<string, number>();
  for (const r of db.prepare('SELECT month, currency, SUM(royalty) AS r FROM royalty_month GROUP BY month, currency').all() as unknown as { month: string; currency: string; r: number }[]) sheets.set(`${r.month}|${r.currency}`, r.r);
  const summary = new Map<string, number>();
  for (const r of db.prepare('SELECT month, currency, royalty FROM kdp_summary').all() as unknown as { month: string; currency: string; royalty: number }[]) summary.set(`${r.month}|${r.currency}`, r.royalty);
  // Kindle+ lines of a payment report are the money KDP actually paid for the month's pages: exact, to the cent
  const paidKenp = new Map<string, number>();
  for (const r of db.prepare("SELECT month, currency, SUM(accrued) AS a FROM payment_line WHERE source = 'kenp' GROUP BY month, currency").all() as unknown as { month: string; currency: string; a: number }[]) paidKenp.set(`${r.month}|${r.currency}`, r.a);
  const user = new Map<string, number>();
  for (const r of db.prepare('SELECT month, currency, rate FROM kenp_rate').all() as unknown as { month: string; currency: string; rate: number }[]) user.set(`${r.month}|${r.currency}`, r.rate);

  const out = new Map<string, KenpRate>();
  const keys = [...pageSum.keys()].sort();
  const lastFinal = new Map<string, number>();
  for (const k of keys) {
    const [month, currency] = k.split('|') as [string, string];
    const p = pageSum.get(k)!;
    const kenpMoney = summary.has(k) ? cents(summary.get(k)! - (sheets.get(k) ?? 0)) : 0;
    let rate: number; let state: 'final' | 'estimated'; let isUser = false;
    if (user.has(k)) { rate = user.get(k)!; state = 'final'; isUser = true; lastFinal.set(currency, rate); }
    else if (paidKenp.has(k) && p > 0) { rate = paidKenp.get(k)! / p; state = 'final'; lastFinal.set(currency, rate); }
    else if (kenpMoney > 0 && p > 0) { rate = kenpMoney / p; state = 'final'; lastFinal.set(currency, rate); }
    else { rate = lastFinal.get(currency) ?? DEFAULT_KENP_RATE[currency] ?? DEFAULT_KENP_RATE.USD!; state = 'estimated'; }
    out.set(k, { month, currency, rate, state, user: isUser });
  }
  return out;
}

/** Earnings per book per month and source. `today` decides which month is the current (pending KENP) one. */
export function monthlyEarnings(db: Db, range: { from?: string; to?: string } = {}, today = new Date()): Earning[] {
  const now = thisMonth(today);
  const out: Earning[] = [];
  const where = (col: string) => [range.from ? `${col} >= '${range.from}'` : '', range.to ? `${col} <= '${range.to}'` : ''].filter(Boolean).join(' AND ') || '1';
  const canon = bookAliases(db);
  const roy = new Map<string, Earning>();
  for (const r of db.prepare(
    `SELECT asin, month, CASE format WHEN 'ebook' THEN 'ebook' ELSE 'print' END AS source, currency, SUM(royalty) AS amount, SUM(net_units) AS quantity
       FROM royalty_month WHERE ${where('month')} GROUP BY asin, month, source, currency`,
  ).all() as unknown as { asin: string; month: string; source: EarningSource; currency: string; amount: number; quantity: number }[]) {
    const asin = canon(r.asin);
    const k = `${asin}|${r.month}|${r.source}|${r.currency}`;
    const c = roy.get(k);
    if (c) { c.amount = cents(c.amount + r.amount); c.quantity += r.quantity; } else roy.set(k, { ...r, asin, amount: cents(r.amount), state: 'final' });
  }
  out.push(...roy.values());
  const rates = kenpRates(db);
  const byKey = new Map<string, { asin: string; month: string; currency: string; pages: number }>();
  for (const r of db.prepare(`SELECT asin, substr(day, 1, 7) AS month, marketplace, SUM(pages) AS pages FROM kenp_day WHERE ${where('substr(day, 1, 7)')} GROUP BY asin, month, marketplace`).all() as unknown as { asin: string; month: string; marketplace: string; pages: number }[]) {
    const currency = marketplaceCurrency(r.marketplace);
    const k = `${r.asin}|${r.month}|${currency}`;
    const c = byKey.get(k);
    if (c) c.pages += r.pages; else byKey.set(k, { asin: r.asin, month: r.month, currency, pages: r.pages });
  }
  for (const k of byKey.values()) {
    const rate = rates.get(`${k.month}|${k.currency}`)!;
    const state: EarningState = k.month >= now ? 'pending' : rate.state === 'final' ? 'final' : 'estimated';
    out.push({ asin: k.asin, month: k.month, source: 'kenp', currency: k.currency, amount: cents(k.pages * rate.rate), quantity: k.pages, state });
  }
  return out.sort((a, b) => a.month.localeCompare(b.month) || a.asin.localeCompare(b.asin) || a.source.localeCompare(b.source));
}

export interface FxRate { month: string; currency: string; toUsd: number; source: 'usd' | 'user' | 'default' }

export function fxRate(db: Db, month: string, currency: string): FxRate {
  if (currency === 'USD') return { month, currency, toUsd: 1, source: 'usd' };
  const u = db.prepare('SELECT to_usd AS r FROM fx_rate WHERE month = ? AND currency = ?').get(month, currency) as { r: number } | undefined;
  if (u) return { month, currency, toUsd: u.r, source: 'user' };
  // the user's most recent earlier rate carries forward before the app's default does
  const prev = db.prepare('SELECT to_usd AS r FROM fx_rate WHERE currency = ? AND month < ? ORDER BY month DESC LIMIT 1').get(currency, month) as { r: number } | undefined;
  if (prev) return { month, currency, toUsd: prev.r, source: 'user' };
  return { month, currency, toUsd: DEFAULT_FX[currency] ?? 1, source: 'default' };
}

export function setFxRate(db: Db, root: string, month: string, currency: string, toUsd: number): void {
  if (!/^\d{4}-\d{2}$/.test(month) || !/^[A-Z]{3}$/.test(currency) || !(toUsd > 0)) throw new Error('bad rate');
  db.prepare('INSERT INTO fx_rate (month, currency, to_usd) VALUES (?,?,?) ON CONFLICT(month, currency) DO UPDATE SET to_usd = excluded.to_usd').run(month, currency, toUsd);
  exportUserData(db, root);
}

export function clearFxRate(db: Db, root: string, month: string, currency: string): void {
  db.prepare('DELETE FROM fx_rate WHERE month = ? AND currency = ?').run(month, currency);
  exportUserData(db, root);
}

export function setKenpRate(db: Db, root: string, month: string, currency: string, rate: number | null): void {
  if (rate === null) { db.prepare('DELETE FROM kenp_rate WHERE month = ? AND currency = ?').run(month, currency); exportUserData(db, root); return; }
  if (!/^\d{4}-\d{2}$/.test(month) || !/^[A-Z]{3}$/.test(currency) || !(rate > 0)) throw new Error('bad rate');
  db.prepare('INSERT INTO kenp_rate (month, currency, rate) VALUES (?,?,?) ON CONFLICT(month, currency) DO UPDATE SET rate = excluded.rate').run(month, currency, rate);
  exportUserData(db, root);
}

/** Earnings with their USD value. The currencies the user can set rates for are returned beside them. */
export function moneyLines(db: Db, range: { from?: string; to?: string } = {}, today = new Date()): { lines: MoneyLine[]; fx: FxRate[] } {
  const earnings = monthlyEarnings(db, range, today);
  const fx = new Map<string, FxRate>();
  const lines = earnings.map((e) => {
    const k = `${e.month}|${e.currency}`;
    if (!fx.has(k)) fx.set(k, fxRate(db, e.month, e.currency));
    const r = fx.get(k)!;
    return { ...e, usd: cents(e.amount * r.toUsd), fx: r.source };
  });
  return { lines, fx: [...fx.values()].sort((a, b) => a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency)) };
}

export const round2 = cents;
