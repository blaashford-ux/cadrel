import type { Db } from '../schema.js';
import { exportUserData } from '../userdata.js';
import { listOwnBooks } from './own.js';
import { splitPenNames } from '../authors.js';
import { moneyLines, round2, type EarningSource, type EarningState, type FxRate, type MoneyLine } from './earnings.js';
import { hasPayments, listPayments, reconcile, type PaidPiece, type Unmatched } from './payments.js';

/**
 * Who is owed what. A book's royalties (eBook, print and Kindle Unlimited alike) are shared between people by percentage. There
 * is one split per book; saving a changed one says from which month it applies, so months already settled keep the split they
 * were calculated under. A book with no split belongs wholly to the author KDP reports it under.
 */

export interface Person { id: number; name: string; penNames: string[] }
export interface SplitShare { personId: number; name: string; pct: number }
export interface SplitVersion { fromMonth: string; shares: SplitShare[] }

/** The month a first split applies from: every month. */
export const ALL_MONTHS = '0000-00';

export function listPeople(db: Db): Person[] {
  return (db.prepare('SELECT id, name, pen_names AS pen FROM person ORDER BY name COLLATE NOCASE').all() as unknown as { id: number; name: string; pen: string }[]).map((r) => ({ id: r.id, name: r.name, penNames: JSON.parse(r.pen) as string[] }));
}

export function savePerson(db: Db, root: string, p: { id?: number; name: string; penNames?: string[] }): Person {
  const name = p.name.trim().slice(0, 120);
  if (!name) throw new Error('a person needs a name');
  const pens = JSON.stringify([...new Set((p.penNames ?? []).map((x) => x.trim()).filter(Boolean))]);
  const clash = db.scalar<number>('SELECT id FROM person WHERE name = ? COLLATE NOCASE AND id IS NOT ?', name, p.id ?? null);
  if (clash) throw new Error(`there is already a person called ${name}`);
  let id = p.id;
  if (id) db.prepare('UPDATE person SET name = ?, pen_names = ? WHERE id = ?').run(name, pens, id);
  else id = Number(db.prepare('INSERT INTO person (name, pen_names) VALUES (?,?)').run(name, pens).lastInsertRowid);
  exportUserData(db, root);
  return listPeople(db).find((x) => x.id === id)!;
}

export function deletePerson(db: Db, root: string, id: number): void {
  if (db.scalar('SELECT 1 FROM book_split WHERE person_id = ?', id)) throw new Error('this person is in a book split: take them out of it first');
  db.prepare('DELETE FROM person WHERE id = ?').run(id);
  exportUserData(db, root);
}

export interface DetectedAuthor { name: string; asins: string[]; /** The person this name already belongs to (by name or pen name), if any. */ personId: number | null }

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The person a name belongs to: someone called that, or who writes under it. */
export function personForName(people: Person[], name: string): Person | null {
  return people.find((p) => same(p.name, name)) ?? people.find((p) => p.penNames.some((n) => same(n, name))) ?? null;
}

/**
 * Every author name on the user's books: the names KDP reports them under (a collaboration lists several) and the authors credited on
 * their captured pages. These are the pen names of everyone sharing a book, found without anyone entering them.
 */
export function detectedAuthors(db: Db): DetectedAuthor[] {
  const people = listPeople(db);
  const byName = new Map<string, DetectedAuthor>();
  for (const b of listOwnBooks(db)) {
    for (const name of [...b.penNames, ...b.authorNames].flatMap((n) => splitPenNames(n))) {
      const k = name.toLowerCase();
      const d = byName.get(k) ?? { name, asins: [], personId: personForName(people, name)?.id ?? null };
      if (!d.asins.includes(b.asin)) d.asins.push(b.asin);
      byName.set(k, d);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Every version of a book's split, oldest first. */
export function splitHistory(db: Db, asin: string): SplitVersion[] {
  const rows = db.prepare('SELECT s.from_month AS fromMonth, s.person_id AS personId, p.name, s.pct FROM book_split s JOIN person p ON p.id = s.person_id WHERE s.asin = ? ORDER BY s.from_month, p.name').all(asin) as unknown as (SplitShare & { fromMonth: string })[];
  const out: SplitVersion[] = [];
  for (const r of rows) {
    let v = out[out.length - 1];
    if (!v || v.fromMonth !== r.fromMonth) { v = { fromMonth: r.fromMonth, shares: [] }; out.push(v); }
    v.shares.push({ personId: r.personId, name: r.name, pct: r.pct });
  }
  return out;
}

/** The split in force for a month, or null when the book has none. */
export function splitFor(history: SplitVersion[], month: string): SplitShare[] | null {
  let found: SplitVersion | null = null;
  for (const v of history) if (v.fromMonth <= month) found = v;
  return found && found.shares.length ? found.shares : null;
}

/**
 * Save a book's split from a month on. A share names a person by id, or by name (an author name found in the reports, or typed): the
 * person is found by that name or pen name, or created. An empty list removes every version (the book goes back to its author).
 */
export function setSplit(db: Db, root: string, asin: string, shares: { personId?: number; name?: string; pct: number }[], fromMonth = ALL_MONTHS): void {
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error('bad ASIN');
  if (fromMonth !== ALL_MONTHS && !/^\d{4}-(0[1-9]|1[0-2])$/.test(fromMonth)) throw new Error('bad month');
  if (shares.length) {
    for (const s of shares) {
      if (!(s.pct > 0 && s.pct <= 100)) throw new Error('each share must be above 0 and at most 100');
      if (!s.personId && !s.name?.trim()) throw new Error('choose who each share is for');
      if (s.personId && !db.scalar('SELECT 1 FROM person WHERE id = ?', s.personId)) throw new Error('unknown person');
    }
    if (Math.abs(shares.reduce((a, s) => a + s.pct, 0) - 100) > 0.001) throw new Error('the shares must add up to 100%');
  }
  const resolved = shares.map((s) => {
    if (s.personId) return { personId: s.personId, pct: s.pct };
    const name = s.name!.trim();
    const known = personForName(listPeople(db), name);
    return { personId: (known ?? savePerson(db, root, { name })).id, pct: s.pct };
  });
  if (new Set(resolved.map((s) => s.personId)).size !== resolved.length) throw new Error('a person can be in a split only once');
  db.transaction(() => {
    if (!resolved.length) { db.prepare('DELETE FROM book_split WHERE asin = ?').run(asin); return; }
    db.prepare('DELETE FROM book_split WHERE asin = ? AND from_month = ?').run(asin, fromMonth);
    const ins = db.prepare('INSERT INTO book_split (asin, from_month, person_id, pct) VALUES (?,?,?,?)');
    for (const s of resolved) ins.run(asin, fromMonth, s.personId, s.pct);
  })();
  exportUserData(db, root);
}

// ---------------------------------------------------------------- periods

export type PeriodKind = 'month' | 'quarter' | 'year' | 'custom';

/** The first and last month of a month ('2026-09'), quarter ('2026-Q3'), year ('2026') or a custom 'from..to' range. */
export function periodMonths(kind: PeriodKind, value: string): { from: string; to: string } {
  if (kind === 'month' && /^\d{4}-\d{2}$/.test(value)) return { from: value, to: value };
  if (kind === 'quarter') {
    const m = /^(\d{4})-Q([1-4])$/.exec(value);
    if (m) { const s = (+m[2]! - 1) * 3 + 1; return { from: `${m[1]}-${String(s).padStart(2, '0')}`, to: `${m[1]}-${String(s + 2).padStart(2, '0')}` }; }
  }
  if (kind === 'year' && /^\d{4}$/.test(value)) return { from: `${value}-01`, to: `${value}-12` };
  if (kind === 'custom') {
    const m = /^(\d{4}-\d{2})\.\.(\d{4}-\d{2})$/.exec(value);
    if (m && m[1]! <= m[2]!) return { from: m[1]!, to: m[2]! };
  }
  throw new Error('bad period');
}

export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${String(m).padStart(2, '0')}`); if (++m > 12) { m = 1; y++; } }
  return out;
}

// ---------------------------------------------------------------- statement

/** `paid`: what KDP paid in the period (by payment date). `earned`: what the books earned in the period (by sales month). */
export type StatementBasis = 'paid' | 'earned';
/** `paid` is in a KDP payment; `awaiting` is not paid yet (an estimate, not owed); `unreconciled` is earned but no payment report has been imported to check it. */
export type LineStatus = 'paid' | 'awaiting' | 'unreconciled';

export interface StatementLine {
  /** The sales month (not the payment month). */
  month: string;
  asin: string;
  title: string;
  source: EarningSource;
  state: EarningState;
  status: LineStatus;
  paymentNumber: string | null;
  paidOn: string | null;
  /** The payment is dated after today: KDP has scheduled it. */
  scheduled: boolean;
  /** The payment line was not in USD, so its USD value is worked out rather than reported. */
  derived: boolean;
  currency: string;
  /** The book's royalty for the line and this person's share of it: in KDP's currency (amount is the share of what is owed, after tax when paid) and in USD. */
  gross: number;
  pct: number;
  amount: number;
  grossUsd: number;
  /** The book's tax withheld and net for the line (USD, from the payment), and this person's share of each. */
  taxUsd: number;
  netUsd: number;
  shareGrossUsd: number;
  shareTaxUsd: number;
  /** What this person is owed (paid lines: their share of the net) or would be (awaiting and unreconciled lines), in USD. */
  usd: number;
  fx: MoneyLine['fx'];
}

export interface PayeeStatement {
  name: string;
  personId: number | null;
  lines: StatementLine[];
  /** Owed per currency (paid lines are in USD), without lines still awaiting payment. */
  byCurrency: { currency: string; amount: number }[];
  /** Owed: paid lines, plus unreconciled ones while no payment report has been imported. */
  totalUsd: number;
  /** The part of totalUsd that rests on an estimated KENP rate (KDP has not finalized that month). */
  estimatedUsd: number;
  /** Their share, in USD, of what is in totalUsd before tax, and of the tax withheld. */
  accruedUsd: number;
  taxUsd: number;
  /** Estimates for months KDP has not paid yet: not owed yet. */
  awaitingUsd: number;
}

export interface StatementPayment { number: string; paidOn: string; accrued: number; tax: number; net: number; status: string | null; scheduled: boolean; payoutAmount: number | null; payoutCurrency: string | null; fxRate: number | null }

export interface Statement {
  from: string;
  to: string;
  basis: StatementBasis;
  /** False while no payment report has been imported: amounts are then KDP royalties by sales month, not checked against payments. */
  reconciled: boolean;
  generatedAt: string;
  payees: PayeeStatement[];
  /** Current-month KENP, left out of what is owed until the month is over. */
  pending: { asin: string; title: string; month: string; currency: string; amount: number; usd: number }[];
  /** The payments the statement draws on (basis paid: those dated in the period). */
  payments: StatementPayment[];
  /** Payment lines with no royalty report for their month (nobody can be credited), and lines KDP paid differently from the royalty report. */
  unmatched: Unmatched[];
  differences: { paymentNumber: string; month: string; source: string; currency: string; reported: number; paid: number }[];
  fx: FxRate[];
  months: string[];
}

/** Split `total` (cents) by percentages so the parts add up exactly: floor each, then give the leftover cents to the biggest remainders. */
export function allocate(total: number, pcts: number[]): number[] {
  const c = Math.round(total * 100);
  const raw = pcts.map((p) => (c * p) / 100);
  const parts = raw.map(Math.floor);
  let left = c - parts.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, rem: r - Math.floor(r) })).sort((a, b) => b.rem - a.rem || pcts[b.i]! - pcts[a.i]! || a.i - b.i);
  for (const o of order) { if (left === 0) break; parts[o.i]! += Math.sign(left); left -= Math.sign(left); }
  return parts.map((p) => p / 100);
}

interface Item {
  asin: string; month: string; source: EarningSource; state: EarningState; status: LineStatus; currency: string; gross: number; grossUsd: number; taxUsd: number;
  fx: MoneyLine['fx']; paymentNumber: string | null; paidOn: string | null; scheduled: boolean; derived: boolean;
}

const lastDay = (m: string) => `${m}-31`;

/** `only` limits a `paid` statement to one payment (by number), whatever its date. */
export function royaltyStatement(db: Db, range: { from: string; to: string }, today = new Date(), basis: StatementBasis = 'earned', only?: string): Statement {
  const reconciled = hasPayments(db);
  const items: Item[] = [];
  const pending: Statement['pending'] = [];
  const titles = new Map<string, string>();
  const author = new Map<string, string>();
  const rec = reconciled ? reconcile(db, today) : null;
  const money = moneyLines(db, basis === 'earned' || !reconciled ? range : {}, today);
  const nameOf = (a: string) => {
    if (!titles.has(a)) {
      titles.set(a, db.scalar<string>('SELECT COALESCE((SELECT title FROM snapshot WHERE asin = ? ORDER BY captured_at DESC LIMIT 1), (SELECT title FROM own_book WHERE asin = ?))', a, a) ?? a);
      author.set(a, db.scalar<string>('SELECT author FROM own_book WHERE asin = ?', a)?.trim() || 'Unassigned');
    }
    return titles.get(a)!;
  };
  const piece = (p: PaidPiece, state: EarningState): Item => ({ asin: p.asin, month: p.month, source: p.source, state, status: 'paid', currency: 'USD', gross: p.accrued, grossUsd: p.accrued, taxUsd: p.tax, fx: 'usd', paymentNumber: p.paymentNumber, paidOn: p.paidOn, scheduled: p.scheduled, derived: p.derived });

  if (!reconciled) {
    // no payment report yet: royalties by sales month, as KDP reports them, none of it checked against what was paid
    if (basis === 'earned') {
      for (const l of money.lines) {
        if (l.state === 'pending') { pending.push({ asin: l.asin, title: nameOf(l.asin), month: l.month, currency: l.currency, amount: l.amount, usd: l.usd }); continue; }
        if (l.amount === 0) continue;
        items.push({ asin: l.asin, month: l.month, source: l.source, state: l.state, status: 'unreconciled', currency: l.currency, gross: l.amount, grossUsd: l.usd, taxUsd: 0, fx: l.fx, paymentNumber: null, paidOn: null, scheduled: false, derived: false });
      }
    }
  } else if (basis === 'paid') {
    const lo = `${range.from}-01`; const hi = lastDay(range.to);
    for (const p of rec!.pieces.filter((x) => (only ? x.paymentNumber === only : x.paidOn >= lo && x.paidOn <= hi))) items.push(piece(p, 'final'));
  } else {
    const paidNative = new Map<string, number>();
    const byEarning = new Map<string, PaidPiece[]>();
    for (const p of rec!.pieces) {
      const k = `${p.asin}|${p.month}|${p.source}|${p.currency}`;
      paidNative.set(k, (paidNative.get(k) ?? 0) + p.native);
      byEarning.set(k, [...(byEarning.get(k) ?? []), p]);
    }
    for (const l of money.lines) {
      if (l.state === 'pending') { pending.push({ asin: l.asin, title: nameOf(l.asin), month: l.month, currency: l.currency, amount: l.amount, usd: l.usd }); continue; }
      if (l.amount === 0) continue;
      const k = `${l.asin}|${l.month}|${l.source}|${l.currency}`;
      for (const p of byEarning.get(k) ?? []) items.push(piece(p, l.state));
      const left = round2(l.amount - (paidNative.get(k) ?? 0));
      if (left > 0.004) items.push({ asin: l.asin, month: l.month, source: l.source, state: l.state, status: 'awaiting', currency: l.currency, gross: left, grossUsd: round2((l.usd / l.amount) * left), taxUsd: 0, fx: l.fx, paymentNumber: null, paidOn: null, scheduled: false, derived: false });
    }
  }

  const history = new Map<string, SplitVersion[]>();
  const people0 = listPeople(db);
  const people = new Map<string, PayeeStatement>();
  const payee = (name: string, personId: number | null) => {
    const k = personId ? `p${personId}` : `n${name}`;
    let p = people.get(k);
    if (!p) { p = { name, personId, lines: [], byCurrency: [], totalUsd: 0, estimatedUsd: 0, accruedUsd: 0, taxUsd: 0, awaitingUsd: 0 }; people.set(k, p); }
    return p;
  };
  for (const it of items) {
    const title = nameOf(it.asin);
    if (!history.has(it.asin)) history.set(it.asin, splitHistory(db, it.asin));
    // no split: the author KDP reports, who is a known person when that name is theirs or one of their pen names
    const reported = author.get(it.asin)!;
    const names = splitPenNames(reported);
    const owner = names.length === 1 ? personForName(people0, names[0]!) : null;
    const shares = splitFor(history.get(it.asin)!, it.month) ?? [{ personId: owner?.id ?? 0, name: owner?.name ?? (names.length === 1 ? names[0]! : reported), pct: 100 }];
    const pcts = shares.map((s) => s.pct);
    const netUsd = round2(it.grossUsd - it.taxUsd);
    const gUsd = allocate(it.grossUsd, pcts);
    const tUsd = allocate(it.taxUsd, pcts);
    // a paid line is owed after tax in USD; the others are shared in the currency KDP reported them in
    const native = it.status === 'paid' ? gUsd.map((g, i) => round2(g - tUsd[i]!)) : allocate(it.gross, pcts);
    shares.forEach((s, i) => {
      const p = payee(s.name, s.personId || null);
      p.lines.push({
        month: it.month, asin: it.asin, title, source: it.source, state: it.state, status: it.status, paymentNumber: it.paymentNumber, paidOn: it.paidOn, scheduled: it.scheduled, derived: it.derived,
        currency: it.currency, gross: it.gross, pct: s.pct, amount: native[i]!, grossUsd: it.grossUsd, taxUsd: it.taxUsd, netUsd, shareGrossUsd: gUsd[i]!, shareTaxUsd: tUsd[i]!, usd: round2(gUsd[i]! - tUsd[i]!), fx: it.fx,
      });
    });
  }
  const payees = [...people.values()].map((p) => {
    const owed = p.lines.filter((l) => l.status !== 'awaiting');
    const cur = new Map<string, number>();
    for (const l of owed) cur.set(l.currency, round2((cur.get(l.currency) ?? 0) + l.amount));
    return {
      ...p,
      lines: p.lines.sort((a, b) => a.month.localeCompare(b.month) || a.title.localeCompare(b.title) || a.source.localeCompare(b.source) || (a.paidOn ?? '').localeCompare(b.paidOn ?? '')),
      byCurrency: [...cur].map(([currency, amount]) => ({ currency, amount })).sort((a, b) => a.currency.localeCompare(b.currency)),
      totalUsd: round2(owed.reduce((a, l) => a + l.usd, 0)),
      estimatedUsd: round2(owed.filter((l) => l.state === 'estimated').reduce((a, l) => a + l.usd, 0)),
      accruedUsd: round2(owed.reduce((a, l) => a + l.shareGrossUsd, 0)),
      taxUsd: round2(owed.reduce((a, l) => a + l.shareTaxUsd, 0)),
      awaitingUsd: round2(p.lines.filter((l) => l.status === 'awaiting').reduce((a, l) => a + l.usd, 0)),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const todayIso = today.toISOString().slice(0, 10);
  const lo = `${range.from}-01`; const hi = lastDay(range.to);
  const inScope = (paidOn: string, number: string) => (basis === 'paid' ? (only ? number === only : paidOn >= lo && paidOn <= hi) : items.some((i) => i.paymentNumber === number));
  const payments = reconciled ? listPayments(db).filter((x) => inScope(x.paidOn, x.number)).map((x) => ({ number: x.number, paidOn: x.paidOn, accrued: x.accrued, tax: x.tax, net: x.net, status: x.status, scheduled: x.paidOn > todayIso, payoutAmount: x.payoutAmount, payoutCurrency: x.payoutCurrency, fxRate: x.fxRate })) : [];
  const numbers = new Set(payments.map((x) => x.number));
  return {
    from: range.from, to: range.to, basis, reconciled, generatedAt: today.toISOString(), payees, pending, payments,
    unmatched: (rec?.unmatched ?? []).filter((u) => numbers.has(u.paymentNumber)),
    differences: (rec?.differences ?? []).filter((d) => numbers.has(d.paymentNumber)),
    fx: basis === 'paid' && reconciled ? [] : money.fx, months: monthsBetween(range.from, range.to),
  };
}

// ---------------------------------------------------------------- export

const csvCell = (v: string | number) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const SOURCE_LABEL: Record<EarningSource, string> = { ebook: 'eBook', print: 'Print', kenp: 'Kindle+' };
const STATUS_LABEL = (l: StatementLine) => (l.status === 'paid' ? `Paid${l.derived ? ' (USD worked out)' : ''}${l.scheduled ? ' (scheduled)' : ''}` : l.status === 'awaiting' ? 'Awaiting payment (estimate)' : l.state === 'estimated' ? 'Not checked against a payment (estimated)' : 'Not checked against a payment');

/** The statement as CSV: one row per payee, sales month, book, source and payment, then totals. `only` limits it to one payee. */
export function statementCsv(s: Statement, only?: string): string {
  const rows: (string | number)[][] = [['Author', 'Month', 'Book', 'ASIN', 'Source', 'Status', 'Payment', 'Paid on', 'Currency', 'Book royalty', 'Share %', 'Share before tax USD', 'Tax withheld USD', 'Amount owed USD', 'Amount owed (own currency)']];
  for (const p of s.payees.filter((x) => !only || x.name === only)) {
    for (const l of p.lines) rows.push([p.name, l.month, l.title, l.asin, SOURCE_LABEL[l.source], STATUS_LABEL(l), l.paymentNumber ?? '', l.paidOn ?? '', l.currency, l.gross.toFixed(2), l.pct, l.shareGrossUsd.toFixed(2), l.shareTaxUsd.toFixed(2), l.usd.toFixed(2), l.amount.toFixed(2)]);
    rows.push([p.name, 'Total owed (USD)', '', '', '', p.estimatedUsd ? `Includes ${p.estimatedUsd.toFixed(2)} estimated` : '', '', '', 'USD', '', '', p.accruedUsd.toFixed(2), p.taxUsd.toFixed(2), p.totalUsd.toFixed(2), '']);
    if (p.awaitingUsd) rows.push([p.name, 'Awaiting payment, estimate (USD, not owed yet)', '', '', '', '', '', '', 'USD', '', '', '', '', p.awaitingUsd.toFixed(2), '']);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const esc = (v: string | number) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n: number, c: string) => `${c === 'USD' ? '$' : ''}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${c === 'USD' ? '' : ' ' + c}`;

/** A printable statement for one author (what the desktop app turns into a PDF). */
export function statementHtml(s: Statement, payeeName: string): string {
  const p = s.payees.find((x) => x.name === payeeName);
  if (!p) throw new Error(`no statement for ${payeeName}`);
  const months = [...new Set(p.lines.map((l) => l.month))];
  const body = months.map((m) => {
    const ls = p.lines.filter((l) => l.month === m);
    const owed = ls.filter((l) => l.status !== 'awaiting');
    return `<h3>Sales of ${esc(m)}</h3><table><thead><tr><th>Book</th><th>Source</th><th>Status</th><th class="n">Book royalty</th><th class="n">Share</th><th class="n">Before tax</th><th class="n">Tax</th><th class="n">${s.basis === 'paid' ? 'You are paid' : 'You are owed'}</th></tr></thead><tbody>${ls
      .map((l) => `<tr${l.status === 'awaiting' ? ' class="aw"' : ''}><td>${esc(l.title)}</td><td>${SOURCE_LABEL[l.source]}</td><td>${l.status === 'paid' ? `Paid ${esc(l.paidOn ?? '')}${l.scheduled ? ' (scheduled)' : ''}` : l.status === 'awaiting' ? 'Awaiting payment' : 'Not checked'}${l.state === 'estimated' ? ' <i>(est.)</i>' : ''}</td><td class="n">${money(l.gross, l.currency)}</td><td class="n">${l.pct}%</td><td class="n">${money(l.shareGrossUsd, 'USD')}</td><td class="n">${l.status === 'paid' ? money(l.shareTaxUsd, 'USD') : ''}</td><td class="n">${l.status === 'awaiting' ? '(' + money(l.usd, 'USD') + ')' : money(l.usd, 'USD')}</td></tr>`)
      .join('')}<tr class="t"><td colspan="7">${esc(m)} total (USD)</td><td class="n">${money(round2(owed.reduce((a, l) => a + l.usd, 0)), 'USD')}</td></tr></tbody></table>`;
  }).join('');
  const nonUsd = [...new Set(p.lines.filter((l) => l.status !== 'paid' && l.currency !== 'USD').map((l) => l.currency))];
  const rate = s.fx.filter((f) => f.source !== 'usd' && nonUsd.includes(f.currency));
  const paidNumbers = [...new Set(p.lines.map((l) => l.paymentNumber).filter((x): x is string => !!x))];
  const span = s.from === s.to ? esc(s.from) : `${esc(s.from)} to ${esc(s.to)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Royalty statement ${esc(p.name)} ${esc(s.from)} to ${esc(s.to)}</title><style>
body{font:12px/1.4 -apple-system,Segoe UI,Arial,sans-serif;color:#111;margin:32px}h1{font-size:20px;margin:0 0 2px}h3{margin:18px 0 4px;font-size:13px}.m{color:#555}
table{border-collapse:collapse;width:100%}th,td{padding:4px 6px;border-bottom:1px solid #ddd;text-align:left}.n{text-align:right}.t td{font-weight:600;border-top:1px solid #999}.aw td{color:#777;font-style:italic}
.total{margin-top:22px;font-size:15px;font-weight:600}.note{margin-top:12px;color:#555;font-size:11px}</style></head><body>
<h1>Royalty statement</h1><div class="m">${esc(p.name)} · ${s.basis === 'paid' ? `paid by Amazon ${span}` : `sales ${span}`} · prepared ${esc(s.generatedAt.slice(0, 10))}</div>
${body || '<p>No royalties in this period.</p>'}
<div class="total">${s.basis === 'paid' ? 'Total paid' : 'Total owed'}: ${esc(money(p.totalUsd, 'USD'))}${p.taxUsd ? ` <span class="m" style="font-weight:400">(${esc(money(p.accruedUsd, 'USD'))} before ${esc(money(p.taxUsd, 'USD'))} tax withheld by Amazon)</span>` : ''}</div>
${p.awaitingUsd ? `<div class="note">Not owed yet: about ${esc(money(p.awaitingUsd, 'USD'))} for sales Amazon has not paid (shown in brackets above, estimated).</div>` : ''}
${p.estimatedUsd ? `<div class="note">${esc(money(p.estimatedUsd, 'USD'))} of this rests on Kindle+ pages read priced at an estimated rate; KDP finalizes a month's rate around the 15th of the next month.</div>` : ''}
${!s.reconciled ? '<div class="note">These are royalties as KDP reports them by sales month; they have not been checked against a KDP payment report.</div>' : ''}
${paidNumbers.length ? `<div class="note">Amazon payment${paidNumbers.length > 1 ? 's' : ''}: ${paidNumbers.map(esc).join(', ')}. Amounts are in USD after the tax Amazon withheld.</div>` : ''}
${rate.length ? `<div class="note">USD rates used for unpaid months: ${rate.map((f) => `${esc(f.month)} ${esc(f.currency)} ${f.toUsd}${f.source === 'default' ? ' (default)' : ''}`).join('; ')}.</div>` : ''}
<div class="note">Your share of each book is its royalties from KDP (eBook, print and Kindle+) multiplied by your percentage. No expenses are deducted.</div>
</body></html>`;
}
