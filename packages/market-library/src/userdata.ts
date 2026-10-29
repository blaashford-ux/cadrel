import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './schema.js';

export interface Annotation {
  asin: string;
  kind: 'tag' | 'note';
  value: string;
  createdAt: string;
}

interface UserFile {
  version: 1;
  queue: { asin: string; state: string; updatedAt: string }[];
  annotations: Annotation[];
  ownBooks?: { asin: string; title: string | null; author: string | null; source: string; addedAt: string }[];
  money?: {
    people: { id: number; name: string; penNames: string[] }[];
    splits: { asin: string; fromMonth: string; personId: number; pct: number }[];
    fx: { month: string; currency: string; toUsd: number }[];
    kenpRates: { month: string; currency: string; rate: number }[];
  };
  payouts?: {
    allocations: { paymentNumber: string; payee: string; personId: number | null; accrued: number; tax: number; owed: number; detail: string; allocatedAt: string }[];
    allocated: { paymentNumber: string; allocatedAt: string; unmatchedNet: number }[];
    paid: { payee: string; personId: number | null; paidOn: string; usd: number; period: string; note: string | null; createdAt: string }[];
  };
  excluded?: { categoryKey: string; asin: string; title: string | null; excludedAt: string }[];
  renamed?: { categoryKey: string; name: string; renamedAt: string }[];
}

const file = (root: string) => path.join(root, 'user', 'user-data.json');

export function addAnnotation(db: Db, a: { asin: string; kind: 'tag' | 'note'; value: string }, now = new Date().toISOString()): boolean {
  const value = a.value.trim().slice(0, a.kind === 'tag' ? 60 : 4000);
  if (!value) throw new Error('empty value');
  if (!/^[A-Z0-9]{10}$/.test(a.asin)) throw new Error('bad ASIN');
  if (!db.scalar('SELECT 1 FROM book WHERE asin = ?', a.asin)) throw new Error(`no captured book with ASIN ${a.asin}`);
  const r = db.prepare('INSERT OR IGNORE INTO annotation (asin, kind, value, created_at) VALUES (?,?,?,?)').run(a.asin, a.kind, a.kind === 'tag' ? value.toLowerCase() : value, now);
  return Number(r.changes) > 0;
}

export function removeAnnotation(db: Db, a: { asin: string; kind: 'tag' | 'note'; value: string }): boolean {
  const r = db.prepare('DELETE FROM annotation WHERE asin = ? AND kind = ? AND value = ?').run(a.asin, a.kind, a.kind === 'tag' ? a.value.trim().toLowerCase() : a.value);
  return Number(r.changes) > 0;
}

export function listAnnotations(db: Db, f: { asin?: string; kind?: 'tag' | 'note'; value?: string } = {}): Annotation[] {
  const where: string[] = [];
  const args: string[] = [];
  if (f.asin) (where.push('asin = ?'), args.push(f.asin));
  if (f.kind) (where.push('kind = ?'), args.push(f.kind));
  if (f.value) (where.push('value = ?'), args.push(f.kind === 'tag' || !f.kind ? f.value.toLowerCase() : f.value));
  return db
    .prepare(`SELECT asin, kind, value, created_at AS createdAt FROM annotation ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at, id`)
    .all(...args) as unknown as Annotation[];
}

/** Write the user-authored tables next to the library so they survive losing or rebuilding the database. */
export function exportUserData(db: Db, root: string): void {
  const data: UserFile = {
    version: 1,
    queue: db.prepare('SELECT asin, state, updated_at AS updatedAt FROM queue_item ORDER BY asin').all() as unknown as UserFile['queue'],
    annotations: listAnnotations(db),
    ownBooks: db.prepare('SELECT asin, title, author, source, added_at AS addedAt FROM own_book ORDER BY asin').all() as unknown as NonNullable<UserFile['ownBooks']>,
    excluded: db.prepare('SELECT category_key AS categoryKey, asin, title, excluded_at AS excludedAt FROM category_exclusion ORDER BY category_key, asin').all() as unknown as NonNullable<UserFile['excluded']>,
    renamed: db.prepare('SELECT category_key AS categoryKey, name, renamed_at AS renamedAt FROM category_rename ORDER BY category_key').all() as unknown as NonNullable<UserFile['renamed']>,
    money: {
      people: (db.prepare('SELECT id, name, pen_names AS pen FROM person ORDER BY id').all() as unknown as { id: number; name: string; pen: string }[]).map((r) => ({ id: r.id, name: r.name, penNames: JSON.parse(r.pen) as string[] })),
      splits: db.prepare('SELECT asin, from_month AS fromMonth, person_id AS personId, pct FROM book_split ORDER BY asin, from_month, person_id').all() as unknown as NonNullable<UserFile['money']>['splits'],
      fx: db.prepare('SELECT month, currency, to_usd AS toUsd FROM fx_rate ORDER BY month, currency').all() as unknown as NonNullable<UserFile['money']>['fx'],
      kenpRates: db.prepare('SELECT month, currency, rate FROM kenp_rate ORDER BY month, currency').all() as unknown as NonNullable<UserFile['money']>['kenpRates'],
    },
  };
  data.payouts = {
    allocations: db.prepare('SELECT payment_number AS paymentNumber, payee, person_id AS personId, accrued, tax, owed, detail, allocated_at AS allocatedAt FROM payment_allocation ORDER BY payment_number, payee').all() as unknown as NonNullable<UserFile['payouts']>['allocations'],
    allocated: db.prepare('SELECT payment_number AS paymentNumber, allocated_at AS allocatedAt, unmatched_net AS unmatchedNet FROM payment_allocated ORDER BY payment_number').all() as unknown as NonNullable<UserFile['payouts']>['allocated'],
    paid: db.prepare('SELECT payee, person_id AS personId, paid_on AS paidOn, usd, period, note, created_at AS createdAt FROM payout ORDER BY id').all() as unknown as NonNullable<UserFile['payouts']>['paid'],
  };
  fs.mkdirSync(path.dirname(file(root)), { recursive: true });
  const tmp = file(root) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file(root));
}

/** Restore user data into an empty database (a lost or deleted scout.db). Returns true if anything was imported. */
export function importUserData(db: Db, root: string): boolean {
  if (!fs.existsSync(file(root))) return false;
  const hasOther = !!(db.scalar<number>('SELECT count(*) FROM queue_item') || db.scalar<number>('SELECT count(*) FROM annotation'));
  const hasOwn = !!db.scalar<number>('SELECT count(*) FROM own_book');
  const hasExcluded = !!db.scalar<number>('SELECT count(*) FROM category_exclusion');
  const hasRenamed = !!db.scalar<number>('SELECT count(*) FROM category_rename');
  const hasMoney = !!(db.scalar<number>('SELECT count(*) FROM person') || db.scalar<number>('SELECT count(*) FROM fx_rate') || db.scalar<number>('SELECT count(*) FROM kenp_rate'));
  const hasPayouts = !!(db.scalar<number>('SELECT count(*) FROM payment_allocated') || db.scalar<number>('SELECT count(*) FROM payout'));
  if (hasOther && hasOwn && hasExcluded && hasRenamed && hasMoney && hasPayouts) return false;
  let data: UserFile;
  try {
    data = JSON.parse(fs.readFileSync(file(root), 'utf8')) as UserFile;
  } catch {
    return false;
  }
  db.transaction(() => {
    if (!hasOwn) {
      for (const b of data.ownBooks ?? []) {
        if (/^[A-Z0-9]{10}$/.test(b.asin)) db.prepare('INSERT OR IGNORE INTO own_book (asin, title, author, source, added_at) VALUES (?,?,?,?,?)').run(b.asin, b.title ?? null, b.author ?? null, b.source === 'manual' ? 'manual' : 'report', b.addedAt);
      }
    }
    if (data.money && !hasMoney) {
      for (const p of data.money.people ?? []) db.prepare('INSERT OR IGNORE INTO person (id, name, pen_names) VALUES (?,?,?)').run(p.id, p.name, JSON.stringify(p.penNames ?? []));
      for (const x of data.money.splits ?? []) db.prepare('INSERT OR IGNORE INTO book_split (asin, from_month, person_id, pct) VALUES (?,?,?,?)').run(x.asin, x.fromMonth, x.personId, x.pct);
      for (const x of data.money.fx ?? []) db.prepare('INSERT OR IGNORE INTO fx_rate (month, currency, to_usd) VALUES (?,?,?)').run(x.month, x.currency, x.toUsd);
      for (const x of data.money.kenpRates ?? []) db.prepare('INSERT OR IGNORE INTO kenp_rate (month, currency, rate) VALUES (?,?,?)').run(x.month, x.currency, x.rate);
    }
    if (data.payouts && !hasPayouts) {
      for (const a of data.payouts.allocations ?? []) db.prepare('INSERT OR IGNORE INTO payment_allocation (payment_number, payee, person_id, accrued, tax, owed, detail, allocated_at) VALUES (?,?,?,?,?,?,?,?)').run(a.paymentNumber, a.payee, a.personId ?? null, a.accrued, a.tax, a.owed, a.detail, a.allocatedAt);
      for (const a of data.payouts.allocated ?? []) db.prepare('INSERT OR IGNORE INTO payment_allocated (payment_number, allocated_at, unmatched_net) VALUES (?,?,?)').run(a.paymentNumber, a.allocatedAt, a.unmatchedNet);
      for (const o of data.payouts.paid ?? []) db.prepare('INSERT INTO payout (payee, person_id, paid_on, usd, period, note, created_at) VALUES (?,?,?,?,?,?,?)').run(o.payee, o.personId ?? null, o.paidOn, o.usd, o.period, o.note ?? null, o.createdAt);
    }
    if (!hasExcluded) {
      for (const x of data.excluded ?? []) {
        if (/^[A-Z0-9]{10}$/.test(x.asin) && typeof x.categoryKey === 'string') db.prepare('INSERT OR IGNORE INTO category_exclusion (category_key, asin, title, excluded_at) VALUES (?,?,?,?)').run(x.categoryKey, x.asin, x.title ?? null, x.excludedAt);
      }
    }
    if (!hasRenamed) {
      for (const x of data.renamed ?? []) {
        if (typeof x.categoryKey === 'string' && typeof x.name === 'string' && x.name.trim()) db.prepare('INSERT OR IGNORE INTO category_rename (category_key, name, renamed_at) VALUES (?,?,?)').run(x.categoryKey, x.name.trim(), x.renamedAt);
      }
    }
    if (hasOther) return;
    for (const q of data.queue ?? []) {
      if (q.state === 'opened' || q.state === 'skipped') db.prepare('INSERT OR IGNORE INTO queue_item (asin, state, updated_at) VALUES (?,?,?)').run(q.asin, q.state, q.updatedAt);
    }
    for (const a of data.annotations ?? []) {
      db.prepare('INSERT OR IGNORE INTO annotation (asin, kind, value, created_at) VALUES (?,?,?,?)').run(a.asin, a.kind, a.value, a.createdAt);
    }
  })();
  return true;
}
