import type { Db } from '../schema.js';
import { readXlsx, isXlsx, norm, parseDates, num, type Grid } from './grid.js';
import { monthlyEarnings, fxRate, round2, type Earning } from './earnings.js';

/**
 * KDP payment reports. Amazon pays one lump sum, in USD, covering many sales months (it holds royalties until a balance passes a
 * minimum), less tax withheld. The report lists the payment and, under it, one line per sales month and source: Sales (eBook and
 * print royalties) or Kindle+ Royalties (Kindle Unlimited pages read). How each marketplace's own currency became the USD total is
 * not reported; the conversion that is reported (FX rate, payout amount) is the lump sum into the user's bank currency.
 */

export type PaymentSource = 'sales' | 'kenp';

export interface PaymentLine { month: string; source: PaymentSource; currency: string; accrued: number; tax: number; net: number }

export interface PaymentRow {
  number: string;
  /** The paying entity KDP names (Amazon.com). */
  entity: string | null;
  paidOn: string;
  method: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  currency: string;
  accrued: number;
  tax: number;
  net: number;
  /** KDP's conversion of the lump sum into the bank currency; null while "Pending info from Bank". */
  fxRate: number | null;
  payoutCurrency: string | null;
  payoutAmount: number | null;
  status: string | null;
  lines: PaymentLine[];
}

export interface PaymentParse { payments: PaymentRow[]; skipped: number }

const COLS = {
  from: ['sales period start date'],
  to: ['sales period end date'],
  entity: ['marketplace'],
  number: ['payment number'],
  detail: ['detail'],
  date: ['date'],
  method: ['payment method'],
  accrued: ['accrued royalty'],
  tax: ['tax withholding'],
  net: ['net earnings'],
  source: ['source'],
  fx: ['fx rate'],
  payout: ['payout amount'],
  status: ['payment status'],
};

/** A payment number as KDP's workbook stores it: a long integer that spreadsheets write as 1.0000154418274E14. */
function paymentNumber(v: string): string {
  const t = v.trim();
  if (/^\d+$/.test(t)) return t;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n)).toString() : t;
}

const money = (v: string | undefined): number | null => {
  const n = num((v ?? '').replace(/[^0-9.,-]/g, ''));
  return n === null || !(v ?? '').trim() || /^[a-z]/i.test((v ?? '').trim()) ? null : n;
};

const dateOf = (v: string | undefined) => (v ? parseDates([v])[0] ?? null : null);

/** Read the Payments sheet: each header row (it has a payment number) followed by its detail rows. */
export function parsePaymentFile(name: string, bytes: Uint8Array): PaymentParse {
  if (!isXlsx(name, bytes)) return { payments: [], skipped: 0 };
  const sheet = readXlsx(bytes).find((s) => /payment/i.test(s.name)) ?? null;
  if (!sheet) return { payments: [], skipped: 0 };
  const rows: Grid = sheet.rows;
  const hi = rows.findIndex((r) => r.map(norm).includes('payment number') && r.map(norm).includes('accrued royalty'));
  if (hi < 0) return { payments: [], skipped: 0 };
  const heads = rows[hi]!.map(norm);
  const at = (key: keyof typeof COLS) => heads.findIndex((h) => COLS[key].includes(h));
  const cur = heads.map((h, i) => (h === 'currency' ? i : -1)).filter((i) => i >= 0);
  const col = { from: at('from'), to: at('to'), entity: at('entity'), number: at('number'), detail: at('detail'), date: at('date'), method: at('method'), accrued: at('accrued'), tax: at('tax'), net: at('net'), source: at('source'), fx: at('fx'), payout: at('payout'), status: at('status') };
  if (col.number < 0 || col.accrued < 0 || col.net < 0 || col.date < 0 || cur.length < 1) return { payments: [], skipped: 0 };
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  const out: PaymentRow[] = [];
  let skipped = 0;
  let current: PaymentRow | null = null;
  for (const r of rows.slice(hi + 1).filter((x) => x.some(Boolean))) {
    if (cell(r, col.number)) {
      const paidOn = dateOf(cell(r, col.date));
      const accrued = money(cell(r, col.accrued));
      const tax = money(cell(r, col.tax));
      const net = money(cell(r, col.net));
      if (!paidOn || accrued === null || net === null) { current = null; skipped++; continue; }
      current = {
        number: paymentNumber(cell(r, col.number)), entity: cell(r, col.entity) || null, paidOn, method: cell(r, col.method) || null,
        periodFrom: dateOf(cell(r, col.from)), periodTo: dateOf(cell(r, col.to)), currency: (cell(r, cur[0]!) || 'USD').toUpperCase(),
        accrued, tax: tax ?? round2(accrued - net), net,
        fxRate: money(cell(r, col.fx)), payoutCurrency: (cell(r, cur[1] ?? -1) || '').toUpperCase() || null, payoutAmount: money(cell(r, col.payout)),
        status: cell(r, col.status) || null, lines: [],
      };
      out.push(current);
      continue;
    }
    const month = /^(\d{4}-(?:0[1-9]|1[0-2]))/.exec(cell(r, col.detail))?.[1];
    const src = /kindle|kenp/i.test(cell(r, col.source)) ? 'kenp' : /sales?/i.test(cell(r, col.source)) ? 'sales' : null;
    const accrued = money(cell(r, col.accrued));
    const net = money(cell(r, col.net));
    if (!current || !month || !src || accrued === null || net === null) { skipped++; continue; }
    current.lines.push({ month, source: src, currency: (cell(r, cur[0]!) || current.currency).toUpperCase(), accrued, tax: money(cell(r, col.tax)) ?? round2(accrued - net), net });
  }
  return { payments: out, skipped };
}

/** Store payments. A payment number is unique: importing one again replaces it and its lines (a later report has the bank figures). */
export function savePayments(db: Db, payments: PaymentRow[], source: string, now = new Date().toISOString()): void {
  const del = db.prepare('DELETE FROM payment WHERE number = ?');
  const delLines = db.prepare('DELETE FROM payment_line WHERE payment_number = ?');
  const ins = db.prepare(
    `INSERT INTO payment (number, entity, paid_on, method, period_from, period_to, currency, accrued, tax, net, fx_rate, payout_currency, payout_amount, status, source, imported_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insLine = db.prepare('INSERT INTO payment_line (payment_number, month, source, currency, accrued, tax, net) VALUES (?,?,?,?,?,?,?)');
  db.transaction(() => {
    for (const p of payments) {
      delLines.run(p.number);
      del.run(p.number);
      ins.run(p.number, p.entity, p.paidOn, p.method, p.periodFrom, p.periodTo, p.currency, p.accrued, p.tax, p.net, p.fxRate, p.payoutCurrency, p.payoutAmount, p.status, source, now);
      for (const l of p.lines) insLine.run(p.number, l.month, l.source, l.currency, l.accrued, l.tax, l.net);
    }
  })();
}

export function listPayments(db: Db): PaymentRow[] {
  const rows = db.prepare('SELECT number, entity, paid_on AS paidOn, method, period_from AS periodFrom, period_to AS periodTo, currency, accrued, tax, net, fx_rate AS fxRate, payout_currency AS payoutCurrency, payout_amount AS payoutAmount, status FROM payment ORDER BY paid_on DESC, number').all() as unknown as Omit<PaymentRow, 'lines'>[];
  const q = db.prepare('SELECT month, source, currency, accrued, tax, net FROM payment_line WHERE payment_number = ? ORDER BY month, source');
  return rows.map((r) => ({ ...r, lines: q.all(r.number) as unknown as PaymentLine[] }));
}

export const hasPayments = (db: Db): boolean => !!db.scalar('SELECT 1 FROM payment');

export function removePayment(db: Db, number: string): void {
  db.prepare('DELETE FROM payment_line WHERE payment_number = ?').run(number);
  db.prepare('DELETE FROM payment WHERE number = ?').run(number);
}

// ---------------------------------------------------------------- matching payments to earnings

/** One piece of a payment that covers (part of) one book's earnings for a month and source, in USD. */
export interface PaidPiece {
  asin: string;
  month: string;
  source: Earning['source'];
  /** The currency of the earning this piece pays (the payment line's own currency); amounts below are USD. */
  currency: string;
  paymentNumber: string;
  paidOn: string;
  /** The payment is dated after today (KDP has scheduled it). */
  scheduled: boolean;
  /** USD: accrued before tax, tax withheld, and net (what the authors share). */
  accrued: number;
  tax: number;
  net: number;
  /** The accrued amount in the earning's own currency, to see how much of the earning is still unpaid. */
  native: number;
  /** The payment line was in a currency other than USD, so its USD value is worked out (see paymentUsd). */
  derived: boolean;
}

export interface Unmatched { paymentNumber: string; month: string; source: PaymentSource; currency: string; net: number }

export interface Reconciled {
  earnings: Earning[];
  pieces: PaidPiece[];
  /** Payment lines for which no earnings were imported (the month's royalty report is missing), so no book can be credited. */
  unmatched: Unmatched[];
  /** Per payment line: the royalty report's total against the line (a difference means KDP revised the month after paying it). */
  differences: { paymentNumber: string; month: string; source: PaymentSource; currency: string; reported: number; paid: number }[];
}

/** Split `total` (cents) across weights so the parts add up exactly. */
function spread(total: number, weights: number[]): number[] {
  const c = Math.round(total * 100);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!c || !sum) return weights.map(() => 0);
  const raw = weights.map((w) => (c * w) / sum);
  const parts = raw.map(Math.floor);
  let left = c - parts.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, rem: r - Math.floor(r) })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const o of order) { if (left <= 0) break; parts[o.i]!++; left--; }
  return parts.map((p) => p / 100);
}

/** USD value of each payment line. USD lines are as reported; for other currencies KDP does not say what rate it used, so the difference between the payment's total and its USD lines is shared across them in proportion to their estimates. */
export function paymentUsd(db: Db, p: PaymentRow): { line: PaymentLine; accrued: number; tax: number; net: number; derived: boolean }[] {
  const usd = p.lines.filter((l) => l.currency === 'USD');
  const other = p.lines.filter((l) => l.currency !== 'USD');
  const known = round2(usd.reduce((a, l) => a + l.accrued, 0));
  const est = other.map((l) => l.accrued * fxRate(db, l.month, l.currency).toUsd);
  const total = est.reduce((a, b) => a + b, 0);
  const residual = round2(p.accrued - known);
  // the residual is usable only when it is positive and in the neighbourhood of the estimates; otherwise the estimates stand
  const scale = other.length && total > 0 && residual > 0 && residual / total > 0.4 && residual / total < 2.5 ? residual / total : 1;
  const taxRatio = p.accrued ? p.tax / p.accrued : 0;
  return p.lines.map((l) => {
    if (l.currency === 'USD') return { line: l, accrued: l.accrued, tax: l.tax, net: l.net, derived: false };
    const accrued = round2(est[other.indexOf(l)]! * scale);
    const tax = round2(accrued * taxRatio);
    return { line: l, accrued, tax, net: round2(accrued - tax), derived: true };
  });
}

/**
 * Match every payment line to the earnings of the same sales month, source (Sales covers eBook and print) and currency, and give
 * each book's earning its share of the line, exact to the cent. The KENP rates are exact where a Kindle+ line sets them, so a
 * paid KENP line and the earnings it covers agree.
 */
export function reconcile(db: Db, today = new Date()): Reconciled {
  const earnings = monthlyEarnings(db, {}, today);
  const groups = new Map<string, Earning[]>();
  for (const e of earnings) {
    const k = `${e.month}|${e.source === 'kenp' ? 'kenp' : 'sales'}|${e.currency}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const pieces: PaidPiece[] = [];
  const unmatched: Unmatched[] = [];
  const differences: Reconciled['differences'] = [];
  const todayIso = today.toISOString().slice(0, 10);
  for (const p of listPayments(db)) {
    const usd = paymentUsd(db, p);
    const reported = new Map<string, number>();
    const paid = new Map<string, number>();
    for (const u of usd) {
      const l = u.line;
      const key = `${l.month}|${l.source}|${l.currency}`;
      paid.set(key, (paid.get(key) ?? 0) + l.accrued);
      const rows = (groups.get(key) ?? []).filter((e) => e.state !== 'pending' && e.amount !== 0);
      if (!rows.length) { unmatched.push({ paymentNumber: p.number, month: l.month, source: l.source, currency: l.currency, net: u.net }); continue; }
      reported.set(key, rows.reduce((a, e) => a + e.amount, 0));
      const w = rows.map((e) => e.amount);
      const acc = spread(u.accrued, w);
      const tax = spread(u.tax, w);
      const nat = spread(l.accrued, w);
      rows.forEach((e, i) => {
        if (!acc[i] && !tax[i]) return;
        pieces.push({ asin: e.asin, month: e.month, source: e.source, currency: e.currency, paymentNumber: p.number, paidOn: p.paidOn, scheduled: p.paidOn > todayIso, accrued: acc[i]!, tax: tax[i]!, net: round2(acc[i]! - tax[i]!), native: nat[i]!, derived: u.derived });
      });
    }
    for (const [key, rep] of reported) {
      const [month, source, currency] = key.split('|') as [string, PaymentSource, string];
      const pd = round2(paid.get(key) ?? 0);
      if (Math.abs(pd - round2(rep)) > 0.011) differences.push({ paymentNumber: p.number, month, source, currency, reported: round2(rep), paid: pd });
    }
  }
  return { earnings, pieces, unmatched, differences };
}

export interface UnpaidRow { month: string; source: Earning['source']; currency: string; amount: number; usd: number; state: Earning['state'] }

/** Earnings KDP has not paid yet (no payment line covers them, or only part of them), by sales month, source and currency. */
export function unpaidEarnings(db: Db, today = new Date()): UnpaidRow[] {
  const r = reconcile(db, today);
  const paid = new Map<string, number>();
  for (const p of r.pieces) { const k = `${p.asin}|${p.month}|${p.source}|${p.currency}`; paid.set(k, (paid.get(k) ?? 0) + p.native); }
  const out = new Map<string, UnpaidRow>();
  for (const e of r.earnings) {
    const left = round2(e.amount - (paid.get(`${e.asin}|${e.month}|${e.source}|${e.currency}`) ?? 0));
    if (left <= 0.004) continue;
    const k = `${e.month}|${e.source}|${e.currency}`;
    const row = out.get(k) ?? { month: e.month, source: e.source, currency: e.currency, amount: 0, usd: 0, state: e.state };
    row.amount = round2(row.amount + left);
    row.usd = round2(row.usd + left * fxRate(db, e.month, e.currency).toUsd);
    out.set(k, row);
  }
  return [...out.values()].sort((a, b) => a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency) || a.source.localeCompare(b.source));
}

export interface PaymentsReport {
  payments: (PaymentRow & { scheduled: boolean })[];
  /** Payment lines with no royalty report for their month, and lines KDP paid differently from the royalty report. */
  unmatched: Unmatched[];
  differences: Reconciled['differences'];
  /** Earned but not paid yet, by sales month, source and currency. */
  unpaid: UnpaidRow[];
  /** When each payment was allocated to the authors (by payment number); payments not in it have not been. */
  allocated: Record<string, string>;
}

/** Everything the Payments view shows: each payment with its lines, what does not reconcile, and what is still unpaid. */
export function paymentsReport(db: Db, today = new Date()): PaymentsReport {
  const todayIso = today.toISOString().slice(0, 10);
  const r = reconcile(db, today);
  return { payments: listPayments(db).map((p) => ({ ...p, scheduled: p.paidOn > todayIso })), unmatched: r.unmatched, differences: r.differences, unpaid: unpaidEarnings(db, today),
    allocated: Object.fromEntries((db.prepare('SELECT payment_number AS n, allocated_at AS at FROM payment_allocated').all() as unknown as { n: string; at: string }[]).map((r) => [r.n, r.at])) };
}
