import type { Db } from '../schema.js';
import { exportUserData } from '../userdata.js';
import { round2 } from './earnings.js';
import { listPayments, type PaymentRow } from './payments.js';
import { royaltyStatement, type StatementLine } from './splits.js';

/**
 * Paying the collaborators from what Amazon actually paid. Each payment can be calculated (what every author is owed from it, from
 * the split of each line's sales month, after tax), allocated (that result is frozen, so a later change of split does not rewrite it),
 * and rolled up by quarter with what has already been paid out to each author, so the user knows what to pay for the quarter.
 */

export interface PayeeShare {
  name: string;
  personId: number | null;
  /** The author's share of the payment before tax, the tax withheld on it, and what is owed (net), in USD. */
  accrued: number;
  tax: number;
  owed: number;
  lines: StatementLine[];
}

export interface PaymentOwed {
  /** The ASIN the shares are limited to, or null for the whole payment. `payment` is always the whole payment as Amazon paid it. */
  book: string | null;
  payment: PaymentRow & { scheduled: boolean };
  payees: PayeeShare[];
  totalAccrued: number;
  totalTax: number;
  totalOwed: number;
  /** Net of payment lines for months with no royalty report: nobody can be credited with it. */
  unmatchedNet: number;
  /** The frozen allocation, or null while the payment has not been allocated. `changed` says the split (or the royalty report) now gives different amounts. */
  allocation: { at: string; payees: PayeeShare[]; unmatchedNet: number; changed: boolean } | null;
}

const sum = (xs: number[]) => round2(xs.reduce((a, b) => a + b, 0));

/** What every author is owed from each payment, worked out now from the splits. One pass over all payments. */
export function livePaymentShares(db: Db, today = new Date(), book?: string): Map<string, { payment: PaymentRow & { scheduled: boolean }; payees: PayeeShare[]; unmatchedNet: number }> {
  const todayIso = today.toISOString().slice(0, 10);
  const st = royaltyStatement(db, { from: '0000-01', to: '9999-12' }, today, 'paid', undefined, book);
  const out = new Map<string, { payment: PaymentRow & { scheduled: boolean }; payees: PayeeShare[]; unmatchedNet: number }>();
  for (const p of listPayments(db)) out.set(p.number, { payment: { ...p, scheduled: p.paidOn > todayIso }, payees: [], unmatchedNet: book ? 0 : sum(st.unmatched.filter((u) => u.paymentNumber === p.number).map((u) => u.net)) });
  for (const payee of st.payees) {
    const by = new Map<string, StatementLine[]>();
    for (const l of payee.lines) if (l.paymentNumber) by.set(l.paymentNumber, [...(by.get(l.paymentNumber) ?? []), l]);
    for (const [n, lines] of by) {
      out.get(n)?.payees.push({ name: payee.name, personId: payee.personId, accrued: sum(lines.map((l) => l.shareGrossUsd)), tax: sum(lines.map((l) => l.shareTaxUsd)), owed: sum(lines.map((l) => l.usd)), lines });
    }
  }
  for (const v of out.values()) v.payees.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

interface StoredShare { payment_number: string; payee: string; person_id: number | null; accrued: number; tax: number; owed: number; detail: string; allocated_at: string }

type Allocation = NonNullable<PaymentOwed['allocation']>;

function storedAllocation(db: Db, number: string): Allocation | null {
  const meta = db.prepare('SELECT allocated_at AS at, unmatched_net AS unmatched FROM payment_allocated WHERE payment_number = ?').get(number) as { at: string; unmatched: number } | undefined;
  if (!meta) return null;
  const rows = db.prepare('SELECT * FROM payment_allocation WHERE payment_number = ? ORDER BY payee COLLATE NOCASE').all(number) as unknown as StoredShare[];
  return { at: meta.at, unmatchedNet: meta.unmatched, changed: false, payees: rows.map((r) => ({ name: r.payee, personId: r.person_id, accrued: r.accrued, tax: r.tax, owed: r.owed, lines: JSON.parse(r.detail) as StatementLine[] })) };
}

/** What each author's frozen share of a payment was for one book alone, from the lines frozen with it. */
function forBook(shares: PayeeShare[], book: string): PayeeShare[] {
  const out: PayeeShare[] = [];
  for (const s of shares) {
    const lines = s.lines.filter((l) => l.asin === book);
    if (!lines.length) continue;
    out.push({ name: s.name, personId: s.personId, accrued: sum(lines.map((l) => l.shareGrossUsd)), tax: sum(lines.map((l) => l.shareTaxUsd)), owed: sum(lines.map((l) => l.usd)), lines });
  }
  return out;
}

const differs = (a: PayeeShare[], b: PayeeShare[]) => {
  const m = new Map(a.map((p) => [p.name, p.owed]));
  const n = new Map(b.map((p) => [p.name, p.owed]));
  for (const k of new Set([...m.keys(), ...n.keys()])) if (Math.abs((m.get(k) ?? 0) - (n.get(k) ?? 0)) > 0.005) return true;
  return false;
};

/** The calculator for one payment: what each author is owed from it, and whether it has been allocated. */
export function paymentOwed(db: Db, number: string, today = new Date(), book?: string): PaymentOwed {
  const live = livePaymentShares(db, today, book).get(number);
  if (!live) throw new Error(`no payment ${number}`);
  const frozen = storedAllocation(db, number);
  const stored = frozen && book ? { ...frozen, unmatchedNet: 0, payees: forBook(frozen.payees, book) } : frozen;
  return {
    book: book ?? null,
    payment: live.payment, payees: live.payees,
    totalAccrued: sum(live.payees.map((p) => p.accrued)), totalTax: sum(live.payees.map((p) => p.tax)), totalOwed: sum(live.payees.map((p) => p.owed)),
    unmatchedNet: live.unmatchedNet,
    allocation: stored && { ...stored, changed: differs(stored.payees, live.payees) },
  };
}

/** Freeze what each author is owed from a payment. Allocating again replaces the earlier allocation (use it after fixing a split). */
export function allocatePayment(db: Db, root: string, number: string, today = new Date(), now = new Date().toISOString()): PaymentOwed {
  const live = livePaymentShares(db, today).get(number);
  if (!live) throw new Error(`no payment ${number}`);
  db.transaction(() => {
    db.prepare('DELETE FROM payment_allocation WHERE payment_number = ?').run(number);
    db.prepare('DELETE FROM payment_allocated WHERE payment_number = ?').run(number);
    const ins = db.prepare('INSERT INTO payment_allocation (payment_number, payee, person_id, accrued, tax, owed, detail, allocated_at) VALUES (?,?,?,?,?,?,?,?)');
    for (const p of live.payees) ins.run(number, p.name, p.personId, p.accrued, p.tax, p.owed, JSON.stringify(p.lines), now);
    db.prepare('INSERT INTO payment_allocated (payment_number, allocated_at, unmatched_net) VALUES (?,?,?)').run(number, now, live.unmatchedNet);
  })();
  exportUserData(db, root);
  return paymentOwed(db, number, today);
}

export function unallocatePayment(db: Db, root: string, number: string): void {
  db.prepare('DELETE FROM payment_allocation WHERE payment_number = ?').run(number);
  db.prepare('DELETE FROM payment_allocated WHERE payment_number = ?').run(number);
  exportUserData(db, root);
}

// ---------------------------------------------------------------- payouts to authors

export interface Payout { id: number; payee: string; personId: number | null; paidOn: string; usd: number; /** The first month of the period it settles ('2026-10' for the fourth quarter). */ period: string; note: string | null }

export function listPayouts(db: Db): Payout[] {
  return db.prepare('SELECT id, payee, person_id AS personId, paid_on AS paidOn, usd, period, note FROM payout ORDER BY paid_on DESC, id DESC').all() as unknown as Payout[];
}

export function recordPayout(db: Db, root: string, p: { payee: string; paidOn: string; usd: number; period: string; note?: string }, now = new Date().toISOString()): Payout {
  const payee = p.payee.trim();
  if (!payee) throw new Error('say who was paid');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.paidOn) || Number.isNaN(Date.parse(p.paidOn))) throw new Error('bad date');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(p.period)) throw new Error('bad period');
  if (!(p.usd > 0 && p.usd < 1e7)) throw new Error('the amount must be above zero');
  const person = db.scalar<number>('SELECT id FROM person WHERE name = ? COLLATE NOCASE', payee) ?? null;
  const id = Number(db.prepare('INSERT INTO payout (payee, person_id, paid_on, usd, period, note, created_at) VALUES (?,?,?,?,?,?,?)').run(payee, person, p.paidOn, round2(p.usd), p.period, p.note?.trim().slice(0, 500) || null, now).lastInsertRowid);
  exportUserData(db, root);
  return listPayouts(db).find((x) => x.id === id)!;
}

export function deletePayout(db: Db, root: string, id: number): void {
  db.prepare('DELETE FROM payout WHERE id = ?').run(id);
  exportUserData(db, root);
}

// ---------------------------------------------------------------- the quarterly roll-up

export interface RollupPayment { number: string; paidOn: string; accrued: number; tax: number; net: number; scheduled: boolean; allocated: boolean; changed: boolean; unmatchedNet: number }
export interface RollupPayee {
  name: string;
  personId: number | null;
  /** Owed from the payments dated in the period, before tax, the tax withheld, and the net owed. */
  accrued: number;
  tax: number;
  owed: number;
  /** Still unpaid from earlier periods: what earlier payments owed less what was paid out for those periods. */
  carriedIn: number;
  /** Paid out for this period. */
  paidOut: number;
  /** What to pay now: carried in + owed - paid out. */
  due: number;
  payments: { number: string; paidOn: string; accrued: number; tax: number; owed: number; allocated: boolean; changed: boolean }[];
  payouts: Payout[];
}
export interface Rollup {
  /** The ASIN this roll-up is limited to, or null. For one book it shows what the book's payments owe each author; carried-in, paid-out and due are all zero, because payouts are made to an author for everything they wrote, not per book. */
  book: string | null;
  from: string;
  to: string;
  payees: RollupPayee[];
  payments: RollupPayment[];
  totals: { accrued: number; tax: number; owed: number; carriedIn: number; paidOut: number; due: number };
  /** Payments in the period not allocated yet (their amounts are worked out now and can change with the splits), and allocated ones whose split has changed since. */
  unallocated: string[];
  changed: string[];
  unmatchedNet: number;
  /** Payments dated after today: Amazon has scheduled them but they have not been received, so they are not counted yet. */
  scheduled: RollupPayment[];
}

/**
 * What to pay each author for a period (a quarter, a month, a year): what Amazon paid in it, split by the splits of the sales
 * months, plus anything still unpaid from earlier periods, less what has been paid out for the period. Allocated payments use their
 * frozen amounts; the others are worked out now.
 */
export function payoutRollup(db: Db, range: { from: string; to: string }, today = new Date(), book?: string): Rollup {
  const lo = `${range.from}-01`; const hi = `${range.to}-31`;
  const live = livePaymentShares(db, today, book);
  const payees = new Map<string, RollupPayee>();
  const payee = (name: string, personId: number | null) => {
    const k = name.toLowerCase();
    let p = payees.get(k);
    if (!p) { p = { name, personId, accrued: 0, tax: 0, owed: 0, carriedIn: 0, paidOut: 0, due: 0, payments: [], payouts: [] }; payees.set(k, p); }
    return p;
  };
  const payments: RollupPayment[] = [];
  const scheduled: RollupPayment[] = [];
  const unallocated: string[] = []; const changed: string[] = [];
  const carriedGross = new Map<string, number>();
  for (const [number, v] of live) {
    const frozen = storedAllocation(db, number);
    const stored = frozen && book ? { ...frozen, payees: forBook(frozen.payees, book) } : frozen;
    if (book && !v.payees.length && !stored?.payees.length) continue; // a payment this book is not in
    const isChanged = !!stored && differs(stored.payees, v.payees);
    const shares = stored ? stored.payees : v.payees;
    const when = v.payment.paidOn;
    if (when > hi) continue;
    if (v.payment.scheduled) {
      if (when >= lo) scheduled.push({ number, paidOn: when, accrued: v.payment.accrued, tax: v.payment.tax, net: v.payment.net, scheduled: true, allocated: !!stored, changed: isChanged, unmatchedNet: v.unmatchedNet });
      continue;
    }
    if (when < lo) {
      for (const s of shares) carriedGross.set(s.name.toLowerCase(), (carriedGross.get(s.name.toLowerCase()) ?? 0) + s.owed);
      for (const s of shares) payee(s.name, s.personId);
      continue;
    }
    // the payment as Amazon paid it, or for one book what that book's lines make of it
    const row = book ? { accrued: sum(shares.map((s) => s.accrued)), tax: sum(shares.map((s) => s.tax)), net: sum(shares.map((s) => s.owed)) } : { accrued: v.payment.accrued, tax: v.payment.tax, net: v.payment.net };
    payments.push({ number, paidOn: when, ...row, scheduled: v.payment.scheduled, allocated: !!stored, changed: isChanged, unmatchedNet: v.unmatchedNet });
    if (!stored) unallocated.push(number);
    if (isChanged) changed.push(number);
    for (const s of shares) {
      const p = payee(s.name, s.personId);
      p.accrued = round2(p.accrued + s.accrued); p.tax = round2(p.tax + s.tax); p.owed = round2(p.owed + s.owed);
      p.payments.push({ number, paidOn: when, accrued: s.accrued, tax: s.tax, owed: s.owed, allocated: !!stored, changed: isChanged });
    }
  }
  const priorPaid = new Map<string, number>();
  // payouts are made to an author for everything they wrote, so they are not part of a one-book roll-up
  for (const o of book ? [] : listPayouts(db)) {
    const p = payee(o.payee, o.personId);
    if (o.period < range.from) priorPaid.set(o.payee.toLowerCase(), (priorPaid.get(o.payee.toLowerCase()) ?? 0) + o.usd);
    else if (o.period === range.from) { p.paidOut = round2(p.paidOut + o.usd); p.payouts.push(o); }
  }
  for (const p of payees.values()) {
    const k = p.name.toLowerCase();
    p.carriedIn = book ? 0 : round2((carriedGross.get(k) ?? 0) - (priorPaid.get(k) ?? 0));
    p.due = book ? 0 : round2(p.carriedIn + p.owed - p.paidOut);
    p.payments.sort((a, b) => a.paidOn.localeCompare(b.paidOn));
  }
  const list = [...payees.values()].filter((p) => p.owed || p.carriedIn || p.paidOut || p.payouts.length).sort((a, b) => a.name.localeCompare(b.name));
  payments.sort((a, b) => a.paidOn.localeCompare(b.paidOn));
  return {
    book: book ?? null, from: range.from, to: range.to, payees: list, payments,
    totals: { accrued: sum(list.map((p) => p.accrued)), tax: sum(list.map((p) => p.tax)), owed: sum(list.map((p) => p.owed)), carriedIn: sum(list.map((p) => p.carriedIn)), paidOut: sum(list.map((p) => p.paidOut)), due: sum(list.map((p) => p.due)) },
    unallocated, changed, unmatchedNet: sum(payments.map((p) => p.unmatchedNet)), scheduled,
  };
}

/** Allocate every payment dated in the period that is not allocated yet. Returns the numbers allocated. */
export function allocateRollup(db: Db, root: string, range: { from: string; to: string }, today = new Date()): string[] {
  const r = payoutRollup(db, range, today);
  for (const n of r.unallocated) allocatePayment(db, root, n, today);
  return r.unallocated;
}

// ---------------------------------------------------------------- export

const csvCell = (v: string | number) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const esc = (v: string | number) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The roll-up as CSV: one row per author with what to pay, then each payment that makes it up. `only` limits it to one author. */
export function rollupCsv(r: Rollup, only?: string): string {
  if (r.book) return bookRollupCsv(r, only);
  const rows: (string | number)[][] = [['Author', 'Carried in USD', 'Owed from payments in the period USD', 'Before tax USD', 'Tax withheld USD', 'Paid out for the period USD', 'Due now USD']];
  const ps = r.payees.filter((p) => !only || p.name === only);
  for (const p of ps) rows.push([p.name, p.carriedIn.toFixed(2), p.owed.toFixed(2), p.accrued.toFixed(2), p.tax.toFixed(2), p.paidOut.toFixed(2), p.due.toFixed(2)]);
  if (!only) rows.push(['Total', r.totals.carriedIn.toFixed(2), r.totals.owed.toFixed(2), r.totals.accrued.toFixed(2), r.totals.tax.toFixed(2), r.totals.paidOut.toFixed(2), r.totals.due.toFixed(2)]);
  rows.push([]);
  rows.push(['Author', 'Payment', 'Paid on', 'Before tax USD', 'Tax withheld USD', 'Owed USD', 'Allocation']);
  for (const p of ps) for (const x of p.payments) rows.push([p.name, x.number, x.paidOn, x.accrued.toFixed(2), x.tax.toFixed(2), x.owed.toFixed(2), x.allocated ? (x.changed ? 'Allocated (split changed since)' : 'Allocated') : 'Not allocated (worked out now)']);
  if (ps.some((p) => p.payouts.length)) {
    rows.push([]);
    rows.push(['Author', 'Paid out on', 'Amount USD', 'Note']);
    for (const p of ps) for (const o of p.payouts) rows.push([p.name, o.paidOn, o.usd.toFixed(2), o.note ?? '']);
  }
  return rows.map((x) => x.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** One book's roll-up as CSV: what its payments in the period owe each author, then each payment. No due or paid-out columns (see `Rollup.book`). */
function bookRollupCsv(r: Rollup, only?: string): string {
  const rows: (string | number)[][] = [[`Book ${r.book}`, r.from === r.to ? r.from : `${r.from} to ${r.to}`], [], ['Author', 'Before tax USD', 'Tax withheld USD', 'Owed from this book USD']];
  const ps = r.payees.filter((p) => !only || p.name === only);
  for (const p of ps) rows.push([p.name, p.accrued.toFixed(2), p.tax.toFixed(2), p.owed.toFixed(2)]);
  if (!only) rows.push(['Total', r.totals.accrued.toFixed(2), r.totals.tax.toFixed(2), r.totals.owed.toFixed(2)]);
  rows.push([]);
  rows.push(['Author', 'Payment', 'Paid on', 'Before tax USD', 'Tax withheld USD', 'Owed USD', 'Allocation']);
  for (const p of ps) for (const x of p.payments) rows.push([p.name, x.number, x.paidOn, x.accrued.toFixed(2), x.tax.toFixed(2), x.owed.toFixed(2), x.allocated ? (x.changed ? 'Allocated (split changed since)' : 'Allocated') : 'Not allocated (worked out now)']);
  return rows.map((x) => x.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** A printable payout statement for one author. */
export function rollupHtml(r: Rollup, name: string, generatedAt = new Date().toISOString()): string {
  const p = r.payees.find((x) => x.name === name);
  if (!p) throw new Error(`no payout for ${name}`);
  if (r.book) return bookRollupHtml(r, p, generatedAt);
  const span = r.from === r.to ? esc(r.from) : `${esc(r.from)} to ${esc(r.to)}`;
  const rows = p.payments.map((x) => `<tr><td>${esc(x.number)}</td><td>${esc(x.paidOn)}</td><td class="n">${usd(x.accrued)}</td><td class="n">${usd(x.tax)}</td><td class="n">${usd(x.owed)}</td></tr>`).join('');
  const pay = p.payouts.map((o) => `<tr><td>${esc(o.paidOn)}</td><td>${esc(o.note ?? '')}</td><td class="n">${usd(o.usd)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Payout statement ${esc(p.name)} ${span}</title><style>
body{font:12px/1.4 -apple-system,Segoe UI,Arial,sans-serif;color:#111;margin:32px}h1{font-size:20px;margin:0 0 2px}h3{margin:18px 0 4px;font-size:13px}.m{color:#555}
table{border-collapse:collapse;width:100%}th,td{padding:4px 6px;border-bottom:1px solid #ddd;text-align:left}.n{text-align:right}.t td,.t th{font-weight:600;border-top:1px solid #999}
.total{margin-top:22px;font-size:15px;font-weight:600}.note{margin-top:12px;color:#555;font-size:11px}</style></head><body>
<h1>Payout statement</h1><div class="m">${esc(p.name)} · payments received from Amazon ${span} · prepared ${esc(generatedAt.slice(0, 10))}</div>
<h3>Amazon payments in the period</h3>
${rows ? `<table><thead><tr><th>Payment</th><th>Paid on</th><th class="n">Your share before tax</th><th class="n">Tax withheld</th><th class="n">Owed (after tax)</th></tr></thead><tbody>${rows}<tr class="t"><td colspan="2">Total</td><td class="n">${usd(p.accrued)}</td><td class="n">${usd(p.tax)}</td><td class="n">${usd(p.owed)}</td></tr></tbody></table>` : '<p>Amazon paid nothing for your books in this period.</p>'}
<h3>What is due</h3>
<table><tbody>
<tr><td>Unpaid from earlier periods</td><td class="n">${usd(p.carriedIn)}</td></tr>
<tr><td>Owed from payments in this period</td><td class="n">${usd(p.owed)}</td></tr>
<tr><td>Paid to you for this period</td><td class="n">${p.paidOut ? '(' + usd(p.paidOut) + ')' : usd(0)}</td></tr>
<tr class="t"><th>Due now</th><th class="n">${usd(p.due)}</th></tr></tbody></table>
${pay ? `<h3>Paid to you for this period</h3><table><thead><tr><th>Date</th><th>Note</th><th class="n">Amount</th></tr></thead><tbody>${pay}</tbody></table>` : ''}
<div class="note">Amounts are USD, as Amazon paid them, after the tax Amazon withheld. Your share of each payment is its royalties (eBook, print and Kindle+) multiplied by your percentage for the month they were earned in. No expenses are deducted.</div>
${p.payments.some((x) => !x.allocated) ? '<div class="note">Some of these payments have not been allocated yet; their amounts are worked out from the current splits.</div>' : ''}
</body></html>`;
}

/** The printable page for one author's share of one book's payments in a period. */
function bookRollupHtml(r: Rollup, p: RollupPayee, generatedAt: string): string {
  const span = r.from === r.to ? esc(r.from) : `${esc(r.from)} to ${esc(r.to)}`;
  const rows = p.payments.map((x) => `<tr><td>${esc(x.number)}</td><td>${esc(x.paidOn)}</td><td class="n">${usd(x.accrued)}</td><td class="n">${usd(x.tax)}</td><td class="n">${usd(x.owed)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Book statement ${esc(p.name)} ${esc(r.book ?? '')} ${span}</title><style>
body{font:12px/1.4 -apple-system,Segoe UI,Arial,sans-serif;color:#111;margin:32px}h1{font-size:20px;margin:0 0 2px}h3{margin:18px 0 4px;font-size:13px}.m{color:#555}
table{border-collapse:collapse;width:100%}th,td{padding:4px 6px;border-bottom:1px solid #ddd;text-align:left}.n{text-align:right}.t td,.t th{font-weight:600;border-top:1px solid #999}.note{margin-top:12px;color:#555;font-size:11px}</style></head><body>
<h1>Book statement</h1><div class="m">${esc(p.name)} · book ${esc(r.book ?? '')} · payments received from Amazon ${span} · prepared ${esc(generatedAt.slice(0, 10))}</div>
<h3>Amazon payments that include this book</h3>
${rows ? `<table><thead><tr><th>Payment</th><th>Paid on</th><th class="n">Your share before tax</th><th class="n">Tax withheld</th><th class="n">Owed (after tax)</th></tr></thead><tbody>${rows}<tr class="t"><td colspan="2">Total</td><td class="n">${usd(p.accrued)}</td><td class="n">${usd(p.tax)}</td><td class="n">${usd(p.owed)}</td></tr></tbody></table>` : '<p>Amazon paid nothing for this book in this period.</p>'}
<div class="note">Amounts are USD, as Amazon paid them, after the tax Amazon withheld. This covers this book only; what is due to an author is worked out across all their books on the payout statement.</div>
${p.payments.some((x) => !x.allocated) ? '<div class="note">Some of these payments have not been allocated yet; their amounts are worked out from the current splits.</div>' : ''}
</body></html>`;
}

// ---------------------------------------------------------------- one book's payments

export interface BookPayments {
  asin: string;
  /** A KDP payment report has been imported. Without one there are no payments to list and nothing is paid. */
  reconciled: boolean;
  /** Newest first. `net` and the payee figures are this book's part of the payment; `paymentNet` is the whole payment as Amazon paid it. */
  payments: { number: string; paidOn: string; scheduled: boolean; allocated: boolean; changed: boolean; paymentNet: number; accrued: number; tax: number; net: number; payees: { name: string; accrued: number; tax: number; owed: number }[] }[];
  totals: { accrued: number; tax: number; net: number };
  /** Earned by this book (by authors' shares, an estimate for Kindle+ where KDP has not finalised the rate) and not yet in any payment. */
  awaitingUsd: number;
}

/** Every payment this book is in, with its part of each, and what it has earned that no payment covers yet. */
export function bookPayments(db: Db, asin: string, today = new Date()): BookPayments {
  const live = livePaymentShares(db, today, asin);
  const payments: BookPayments['payments'] = [];
  for (const [number, v] of live) {
    const frozen = storedAllocation(db, number);
    const stored = frozen && { ...frozen, payees: forBook(frozen.payees, asin) };
    if (!v.payees.length && !stored?.payees.length) continue;
    const shares = stored ? stored.payees : v.payees;
    payments.push({
      number, paidOn: v.payment.paidOn, scheduled: v.payment.scheduled, allocated: !!stored, changed: !!stored && differs(stored.payees, v.payees), paymentNet: v.payment.net,
      accrued: sum(shares.map((s) => s.accrued)), tax: sum(shares.map((s) => s.tax)), net: sum(shares.map((s) => s.owed)),
      payees: shares.map((s) => ({ name: s.name, accrued: s.accrued, tax: s.tax, owed: s.owed }))
    });
  }
  payments.sort((a, b) => b.paidOn.localeCompare(a.paidOn));
  const earned = royaltyStatement(db, { from: '0000-01', to: '9999-12' }, today, 'earned', undefined, asin);
  return {
    asin, reconciled: live.size > 0, payments,
    totals: { accrued: sum(payments.map((p) => p.accrued)), tax: sum(payments.map((p) => p.tax)), net: sum(payments.map((p) => p.net)) },
    awaitingUsd: sum(earned.payees.map((p) => p.awaitingUsd))
  };
}
