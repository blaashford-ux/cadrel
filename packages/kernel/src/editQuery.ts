/**
 * Queries, comments and suggestions raised inside an editorial pass (see editPass.ts), each anchored to a passage of the exact file version the
 * pass covers. Records and rules over the kernel's async `Db`: nothing here decides who may do what (the service checks first); it decides what
 * is valid and when.
 *
 *   - Items are raised by the editor while the pass is in progress, and numbered within the pass (1, 2, 3...).
 *   - The author answers a *query* once the pass is delivered; a pass cannot be marked responded while a query is still unanswered.
 *   - open -> answered (the author's response) -> resolved (the editor is satisfied). Open comments and suggestions can be resolved directly.
 *   - An item is never deleted: an open one is withdrawn.
 * Errors are `WorkError`s, so they cross the wire like the rest of the work records.
 */
import { ANCHOR_CONTEXT, ANCHOR_QUOTE_MAX, type TextAnchor } from './anchor';
import { newRecordId } from './ids';
import { normalizeCategory } from './notes';
import type { Ctx } from './catalogue';
import type { Db } from './vault';
import { WorkError } from './work';
import { getPass } from './editPass';

export const QUERY_KINDS = ['query', 'comment', 'suggestion'] as const;
export type QueryKind = (typeof QUERY_KINDS)[number];
export const QUERY_STATES = ['open', 'answered', 'resolved', 'withdrawn'] as const;
export type QueryState = (typeof QUERY_STATES)[number];

export const QUERY_BODY_MAX = 4000;
/** Most items raised at once, and most in one pass. */
export const QUERY_BATCH_MAX = 200;
export const QUERY_PASS_MAX = 2000;

export interface QueryRecord {
  id: string;
  passId: string;
  /** The number within its pass. */
  seq: number;
  kind: QueryKind;
  category: string | null;
  /** The passage, in the version the pass covers. Null for a point that belongs to the whole pass. */
  anchor: TextAnchor | null;
  body: string;
  /** Suggestions: the text that should replace the quote. */
  replacement: string | null;
  state: QueryState;
  response: string | null;
  respondedBy: string | null;
  respondedAt: string | null;
  raisedBy: string;
  raisedAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
}
interface Row extends Omit<QueryRecord, 'anchor'> {
  quote: string | null;
  prefix: string;
  suffix: string;
  start: number | null;
}
const COLS =
  'id, pass_id AS passId, seq, kind, category, anchor_quote AS quote, anchor_prefix AS prefix, anchor_suffix AS suffix, anchor_start AS start, body, replacement, state, response, responded_by AS respondedBy, responded_at AS respondedAt, raised_by AS raisedBy, raised_at AS raisedAt, resolved_by AS resolvedBy, resolved_at AS resolvedAt';
const toRecord = ({ quote, prefix, suffix, start, ...r }: Row): QueryRecord => ({ ...r, anchor: quote === null || start === null ? null : { quote, prefix, suffix, start } });

const fail = (code: ConstructorParameters<typeof WorkError>[0], m: string): never => {
  throw new WorkError(code, m);
};
const audit = (c: Ctx, action: string, target: string, detail: unknown) => ({
  sql: 'INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)',
  params: [c.now, c.actor, action, target, JSON.stringify(detail)]
});
const clean = (v: unknown, what: string, max: number, required: boolean): string => {
  const s = typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : '';
  if (required && !s) return fail('invalid', `${what} cannot be empty.`);
  return s.length > max ? fail('invalid', `${what} is too long (${max} characters at most).`) : s;
};

export async function getQuery(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<QueryRecord | null> {
  const r = await db.first<Row>(`SELECT ${COLS} FROM edit_query WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
  return r ? toRecord(r) : null;
}

export interface QueryFilter {
  passId?: string;
  passIds?: string[];
  kind?: QueryKind;
  /** One state, 'live' (open or answered), or 'any' (the default). */
  state?: QueryState | 'live' | 'any';
}
export async function listQueries(db: Db, c: Pick<Ctx, 'studioId'>, f: QueryFilter = {}): Promise<QueryRecord[]> {
  const where = ['studio_id = ?'];
  const params: unknown[] = [c.studioId];
  if (f.passId) (where.push('pass_id = ?'), params.push(f.passId));
  if (f.passIds) {
    if (!f.passIds.length) return [];
    where.push(`pass_id IN (${f.passIds.map(() => '?').join(',')})`);
    params.push(...f.passIds);
  }
  if (f.kind) (where.push('kind = ?'), params.push(f.kind));
  const state = f.state ?? 'any';
  if (state === 'live') where.push("state IN ('open', 'answered')");
  else if (state !== 'any') (where.push('state = ?'), params.push(state));
  return (await db.all<Row>(`SELECT ${COLS} FROM edit_query WHERE ${where.join(' AND ')} ORDER BY pass_id, seq`, params)).map(toRecord);
}

export type QueryCounts = Record<QueryState, number>;
/** How many items of each state each pass has (a pass with none is absent from the answer). */
export async function queryCounts(db: Db, c: Pick<Ctx, 'studioId'>, passIds: string[]): Promise<Record<string, QueryCounts>> {
  const out: Record<string, QueryCounts> = {};
  if (!passIds.length) return out;
  const rows = await db.all<{ passId: string; state: QueryState; n: number }>(
    `SELECT pass_id AS passId, state, COUNT(*) AS n FROM edit_query WHERE studio_id = ? AND pass_id IN (${passIds.map(() => '?').join(',')}) GROUP BY pass_id, state`,
    [c.studioId, ...passIds]
  );
  for (const r of rows) (out[r.passId] ??= { open: 0, answered: 0, resolved: 0, withdrawn: 0 })[r.state] = r.n;
  return out;
}

export interface NewQuery {
  kind: QueryKind;
  body?: string;
  anchor?: TextAnchor | null;
  /** Suggestions: what replaces the quote. */
  replacement?: string;
  category?: string;
}

/** Raises one or more items in a pass, all or none. The pass must be in progress. */
export async function raiseQueries(db: Db, c: Ctx, passId: string, items: NewQuery[]): Promise<QueryRecord[]> {
  const pass = await getPass(db, c, passId);
  if (!pass) return fail('not-found', 'That pass is not there.');
  if (pass.state !== 'in_progress') fail('conflict', 'Queries are raised while the pass is in progress.');
  if (!Array.isArray(items) || !items.length) fail('invalid', 'There is nothing to raise.');
  if (items.length > QUERY_BATCH_MAX) fail('invalid', `At most ${QUERY_BATCH_MAX} can be raised at once.`);

  const checked = items.map((i, n) => {
    const at = items.length > 1 ? ` (item ${n + 1})` : '';
    if (!QUERY_KINDS.includes(i?.kind)) return fail('invalid', `An item is a query, a comment or a suggestion${at}.`);
    const body = clean(i.body ?? '', 'The text', QUERY_BODY_MAX, i.kind !== 'suggestion');
    let anchor: TextAnchor | null = null;
    if (i.anchor) {
      const a = i.anchor;
      if (typeof a.quote !== 'string' || !a.quote.trim()) return fail('invalid', `The quoted passage cannot be empty${at}.`);
      if (a.quote.length > ANCHOR_QUOTE_MAX) return fail('invalid', `The quoted passage is too long (${ANCHOR_QUOTE_MAX} characters at most)${at}.`);
      if (!Number.isInteger(a.start) || a.start < 0) return fail('invalid', `Where the passage starts is a whole number from 0${at}.`);
      const prefix = typeof a.prefix === 'string' ? a.prefix.slice(-ANCHOR_CONTEXT * 5) : '';
      const suffix = typeof a.suffix === 'string' ? a.suffix.slice(0, ANCHOR_CONTEXT * 5) : '';
      anchor = { quote: a.quote, prefix, suffix, start: a.start };
    }
    let replacement: string | null = null;
    if (i.kind === 'suggestion') {
      if (!anchor) fail('invalid', `A suggestion needs the passage it changes${at}.`);
      if (typeof i.replacement !== 'string') fail('invalid', `A suggestion needs its replacement text${at}.`);
      replacement = clean(i.replacement, 'The replacement', ANCHOR_QUOTE_MAX, false);
    } else if (i.replacement !== undefined) fail('invalid', `Only a suggestion has replacement text${at}.`);
    return { kind: i.kind, body, anchor, replacement, category: normalizeCategory(i.category) ?? null };
  });

  const top = await db.first<{ seq: number | null; n: number }>('SELECT MAX(seq) AS seq, COUNT(*) AS n FROM edit_query WHERE pass_id = ?', [passId]);
  if ((top?.n ?? 0) + checked.length > QUERY_PASS_MAX) fail('invalid', `A pass holds at most ${QUERY_PASS_MAX} items.`);
  const base = top?.seq ?? 0;
  const ids = checked.map(() => newRecordId());
  try {
    await db.batch([
      ...checked.map((q, n) => ({
        sql: `INSERT INTO edit_query (id, studio_id, pass_id, seq, kind, category, anchor_quote, anchor_prefix, anchor_suffix, anchor_start, body, replacement, state, raised_by, raised_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        params: [ids[n], c.studioId, passId, base + n + 1, q.kind, q.category, q.anchor?.quote ?? null, q.anchor?.prefix ?? '', q.anchor?.suffix ?? '', q.anchor?.start ?? null, q.body, q.replacement, c.actor, c.now]
      })),
      audit(c, 'query.raise', passId, { count: checked.length, from: base + 1 })
    ]);
  } catch (e) {
    if (/UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(String((e as Error)?.message ?? e))) fail('conflict', 'Someone else added to this pass at the same moment. Try again.');
    throw e;
  }
  return Promise.all(ids.map(async (id) => (await getQuery(db, c, id))!));
}

async function load(db: Db, c: Ctx, id: string) {
  const q = await getQuery(db, c, id);
  if (!q) return fail('not-found', 'That item is not there.');
  const pass = (await getPass(db, c, q.passId))!;
  return { q, pass };
}

/** The author's answer as it would be kept, or a `WorkError` saying what is wrong with it. Pure, so an app can check it before it queues it. */
export const checkAnswer = (response: unknown): string => clean(response, 'The answer', QUERY_BODY_MAX, true);

/** The author's answer. The pass must have been delivered and not yet responded to; an answer can be rewritten until then. */
export async function answerQuery(db: Db, c: Ctx, id: string, response: string): Promise<QueryRecord> {
  const { q, pass } = await load(db, c, id);
  if (pass.state !== 'delivered') fail('conflict', 'Answers are written after the editor has delivered the pass and before it is marked responded.');
  if (q.state !== 'open' && q.state !== 'answered') fail('conflict', `An item that is ${q.state} cannot be answered.`);
  const text = checkAnswer(response);
  await db.batch([
    { sql: "UPDATE edit_query SET response = ?, responded_by = ?, responded_at = ?, state = 'answered' WHERE id = ? AND studio_id = ?", params: [text, c.actor, c.now, id, c.studioId] },
    audit(c, 'query.answer', id, { passId: q.passId, seq: q.seq })
  ]);
  return (await getQuery(db, c, id))!;
}

/** The editor is satisfied. Open or answered, in a pass that has been delivered and is not yet closed. */
export async function resolveQuery(db: Db, c: Ctx, id: string): Promise<QueryRecord> {
  const { q, pass } = await load(db, c, id);
  if (pass.state !== 'delivered' && pass.state !== 'responded') fail('conflict', 'Items are resolved once the pass has been delivered, until it is closed.');
  if (q.state !== 'open' && q.state !== 'answered') fail('conflict', `An item that is ${q.state} cannot be resolved.`);
  await db.batch([
    { sql: "UPDATE edit_query SET state = 'resolved', resolved_by = ?, resolved_at = ? WHERE id = ? AND studio_id = ?", params: [c.actor, c.now, id, c.studioId] },
    audit(c, 'query.resolve', id, { passId: q.passId, seq: q.seq })
  ]);
  return (await getQuery(db, c, id))!;
}

/** Takes back an item nobody has answered. */
export async function withdrawQuery(db: Db, c: Ctx, id: string): Promise<QueryRecord> {
  const { q, pass } = await load(db, c, id);
  if (pass.state !== 'in_progress' && pass.state !== 'delivered') fail('conflict', 'Items can be withdrawn while the pass is in progress or delivered.');
  if (q.state !== 'open') fail('conflict', `Only an open item can be withdrawn; this one is ${q.state}.`);
  await db.batch([
    { sql: "UPDATE edit_query SET state = 'withdrawn' WHERE id = ? AND studio_id = ?", params: [id, c.studioId] },
    audit(c, 'query.withdraw', id, { passId: q.passId, seq: q.seq })
  ]);
  return (await getQuery(db, c, id))!;
}

/** Cadrel Write's notes (comments and suggestions with an anchor) as items to raise. Notes with no usable anchor are counted, not guessed at. */
export function queriesFromNotes(
  notes: { kind: string; body?: string; replacement?: string; category?: string; anchor?: Partial<TextAnchor> | null }[]
): { items: NewQuery[]; skipped: number } {
  const items: NewQuery[] = [];
  let skipped = 0;
  for (const n of notes) {
    const a = n.anchor;
    if ((n.kind !== 'comment' && n.kind !== 'suggestion') || !a || typeof a.quote !== 'string' || !a.quote.trim() || !Number.isInteger(a.start)) {
      skipped++;
      continue;
    }
    items.push({ kind: n.kind, body: n.body ?? '', replacement: n.kind === 'suggestion' ? (n.replacement ?? '') : undefined, category: n.category, anchor: { quote: a.quote, prefix: a.prefix ?? '', suffix: a.suffix ?? '', start: a.start as number } });
  }
  return { items, skipped };
}
