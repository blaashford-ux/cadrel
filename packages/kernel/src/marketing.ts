/**
 * Market in the Studio (docs/M6-PLAN.md): compact, dated figures published from a computer that has the library; the comps a marketing brief was
 * written against, with the figures it saw pinned as of their capture dates; saved reports; the history of changes to a book's cover, blurb, keywords
 * and price, with what the figures did before and after; and the post-launch review. No captured page text is here, and nothing says a change *caused*
 * anything: a window shows the points on each side and the other changes in it.
 */
import type { Ctx } from './catalogue';
import { addDays, cleanDay, daysBetween, getPlan, type PlanTargets } from './launch';
import { newRecordId } from './ids';
import type { Db } from './vault';
import { WorkError, recordDecision } from './work';

const fail = (code: ConstructorParameters<typeof WorkError>[0], m: string): never => {
  throw new WorkError(code, m);
};
const audit = (c: Ctx, action: string, target: string, detail: unknown) => ({
  sql: 'INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)',
  params: [c.now, c.actor, action, target, JSON.stringify(detail)]
});
const clean = (v: unknown, what: string, max: number, required = true): string => {
  const s = typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : '';
  if (required && !s) return fail('invalid', `${what} cannot be empty.`);
  return s.length > max ? fail('invalid', `${what} is too long (${max} characters at most).`) : s;
};
export const ASIN = /^[A-Z0-9]{10}$/;
const asinOf = (v: unknown): string => {
  const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return ASIN.test(s) ? s : fail('invalid', 'An ASIN is ten letters and digits.');
};

// ---- figures ----------------------------------------------------------------------------------------------------------------------

export interface MarketFigure {
  id: string;
  asin: string;
  /** When the page was captured: an ISO time. */
  capturedAt: string;
  title: string;
  price: number | null;
  currency: string;
  /** Best seller rank in the store (lower is better), or null. */
  rank: number | null;
  ratings: number | null;
  ratingAvg: number | null;
  categories: { name: string; rank: number | null }[];
  publishedBy: string;
  publishedAt: string;
}
export interface NewFigure {
  asin: string;
  capturedAt: string;
  title?: string;
  price?: number | null;
  currency?: string;
  rank?: number | null;
  ratings?: number | null;
  ratingAvg?: number | null;
  categories?: { name: string; rank: number | null }[];
}
interface FigureRow extends Omit<MarketFigure, 'categories'> {
  categories: string;
}
const FCOLS = 'id, asin, captured_at AS capturedAt, title, price, currency, rank, ratings, rating_avg AS ratingAvg, categories, published_by AS publishedBy, published_at AS publishedAt';
const toFigure = (r: FigureRow): MarketFigure => ({ ...r, categories: JSON.parse(r.categories) as MarketFigure['categories'] });
const MAX_FIGURES = 2000;
const num = (v: unknown, what: string, min: number, max: number, int = false): number | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) return fail('invalid', `${what} is out of range.`);
  return v;
};
function cleanFigure(f: NewFigure, i: number): Required<Omit<NewFigure, 'categories'>> & { categories: { name: string; rank: number | null }[] } {
  const at = typeof f?.capturedAt === 'string' ? f.capturedAt : '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at) || Number.isNaN(Date.parse(at))) fail('invalid', `Figure ${i + 1} needs the time it was captured.`);
  const cats = Array.isArray(f.categories) ? f.categories.slice(0, 10).map((x) => ({ name: clean(x?.name, 'A category name', 200), rank: num(x?.rank, 'A category rank', 1, 1e9, true) })) : [];
  return {
    asin: asinOf(f.asin),
    capturedAt: new Date(at).toISOString(),
    title: clean(f.title ?? '', 'The title', 300, false),
    price: num(f.price, 'The price', 0, 100_000),
    currency: clean(f.currency ?? 'USD', 'The currency', 3).toUpperCase(),
    rank: num(f.rank, 'The rank', 1, 1e9, true),
    ratings: num(f.ratings, 'The ratings count', 0, 1e9, true),
    ratingAvg: num(f.ratingAvg, 'The average rating', 0, 5),
    categories: cats
  };
}
/** Publishes figures from this computer's library. Idempotent: one row per ASIN per capture time; a repeat is skipped, never changed. */
export async function publishFigures(db: Db, c: Ctx, figures: NewFigure[]): Promise<{ added: number; skipped: number }> {
  if (!Array.isArray(figures)) return fail('invalid', 'Figures are a list.');
  if (figures.length > MAX_FIGURES) return fail('invalid', `Publish at most ${MAX_FIGURES} figures at a time.`);
  const clean1 = figures.map(cleanFigure);
  const stmts = clean1.map((f) => ({
    sql: 'INSERT OR IGNORE INTO market_figure (id, studio_id, asin, captured_at, title, price, currency, rank, ratings, rating_avg, categories, published_by, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    params: [newRecordId(), c.studioId, f.asin, f.capturedAt, f.title, f.price, f.currency, f.rank, f.ratings, f.ratingAvg, JSON.stringify(f.categories), c.actor, c.now]
  }));
  if (!stmts.length) return { added: 0, skipped: 0 };
  const results = await db.batch([...stmts]);
  const added = results.reduce((n, r) => n + r.changes, 0);
  await db.run('INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)', [c.now, c.actor, 'market.publish', 'figures', JSON.stringify({ added, skipped: stmts.length - added })]);
  return { added, skipped: stmts.length - added };
}
export async function listFigures(db: Db, c: Pick<Ctx, 'studioId'>, f: { asin: string; from?: string; to?: string; limit?: number }): Promise<MarketFigure[]> {
  const where = ['studio_id = ?', 'asin = ?'];
  const params: unknown[] = [c.studioId, asinOf(f.asin)];
  if (f.from) (where.push('captured_at >= ?'), params.push(f.from));
  if (f.to) (where.push('captured_at <= ?'), params.push(f.to));
  params.push(Math.min(Math.max(f.limit ?? 500, 1), 5000));
  return (await db.all<FigureRow>(`SELECT ${FCOLS} FROM market_figure WHERE ${where.join(' AND ')} ORDER BY captured_at LIMIT ?`, params)).map(toFigure);
}
/** The newest figure of an ASIN captured on or before `onOrBefore` (an ISO time; now by default). */
export async function latestFigure(db: Db, c: Pick<Ctx, 'studioId'>, asin: string, onOrBefore?: string): Promise<MarketFigure | null> {
  const r = await db.first<FigureRow>(`SELECT ${FCOLS} FROM market_figure WHERE studio_id = ? AND asin = ? ${onOrBefore ? 'AND captured_at <= ?' : ''} ORDER BY captured_at DESC LIMIT 1`, onOrBefore ? [c.studioId, asinOf(asin), onOrBefore] : [c.studioId, asinOf(asin)]);
  return r ? toFigure(r) : null;
}

// ---- comps and marketing briefs ---------------------------------------------------------------------------------------------------

export interface CompSet {
  id: string;
  projectId: string;
  name: string;
  asins: string[];
  note: string;
  createdAt: string;
  createdBy: string;
}
interface CompRow extends Omit<CompSet, 'asins'> {
  asins: string;
}
const CCOLS = 'id, project_id AS projectId, name, asins, note, created_at AS createdAt, created_by AS createdBy';
export async function createCompSet(db: Db, c: Ctx, i: { projectId: string; name: string; asins: string[]; note?: string }): Promise<CompSet> {
  if (typeof i?.projectId !== 'string' || !i.projectId) fail('invalid', 'A book or series is needed.');
  if (!Array.isArray(i.asins) || i.asins.length === 0 || i.asins.length > 50) fail('invalid', 'A comp set has from one to 50 books.');
  const asins = [...new Set(i.asins.map(asinOf))];
  const id = newRecordId();
  await db.batch([
    { sql: 'INSERT INTO comp_set (id, studio_id, project_id, name, asins, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', params: [id, c.studioId, i.projectId, clean(i.name, 'The name', 100), JSON.stringify(asins), clean(i.note ?? '', 'The note', 1000, false), c.now, c.actor] },
    audit(c, 'market.compset', id, { projectId: i.projectId, count: asins.length })
  ]);
  return (await getCompSet(db, c, id))!;
}
export async function getCompSet(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<CompSet | null> {
  const r = await db.first<CompRow>(`SELECT ${CCOLS} FROM comp_set WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
  return r ? { ...r, asins: JSON.parse(r.asins) as string[] } : null;
}
export async function listCompSets(db: Db, c: Pick<Ctx, 'studioId'>, f: { projectIds?: string[] } = {}): Promise<CompSet[]> {
  if (f.projectIds && !f.projectIds.length) return [];
  const where = ['studio_id = ?'];
  const params: unknown[] = [c.studioId];
  if (f.projectIds) (where.push(`project_id IN (${f.projectIds.map(() => '?').join(',')})`), params.push(...f.projectIds));
  return (await db.all<CompRow>(`SELECT ${CCOLS} FROM comp_set WHERE ${where.join(' AND ')} ORDER BY lower(name)`, params)).map((r) => ({ ...r, asins: JSON.parse(r.asins) as string[] }));
}

export const COMP_ROLES = ['comp', 'competitor', 'self'] as const;
export type CompRole = (typeof COMP_ROLES)[number];
export interface BriefComp {
  briefId: string;
  briefVersion: number;
  asin: string;
  role: CompRole;
  note: string;
  /** The figures the brief saw, as of their capture time; null when none had been published. */
  figure: MarketFigure | null;
  /** Days between the capture and the day asked about, or null when there is no figure. */
  ageDays: number | null;
}
/**
 * Names the comps of a marketing brief at one of its versions and pins, for each, the newest figure published *now*. A later publication does not change
 * what the brief saw. Setting them again for the same version replaces them (the version is still being written).
 */
export async function pinBriefComps(db: Db, c: Ctx, briefId: string, briefVersion: number, comps: { asin: string; role?: CompRole; note?: string }[]): Promise<void> {
  const b = await db.first<{ kind: string; current: number }>('SELECT b.kind AS kind, (SELECT MAX(n) FROM brief_version WHERE brief_id = b.id) AS current FROM brief b WHERE b.id = ? AND b.studio_id = ?', [briefId, c.studioId]);
  if (!b) return fail('not-found', 'That brief is not there.');
  if (b.kind !== 'launch' && b.kind !== 'campaign') return fail('invalid', 'Comps belong to a marketing or campaign brief.');
  if (!Number.isInteger(briefVersion) || briefVersion < 1 || briefVersion > b.current) return fail('not-found', 'That version of the brief is not there.');
  if (!Array.isArray(comps) || comps.length > 50) return fail('invalid', 'A brief names at most 50 comps.');
  const seen = new Set<string>();
  const rows = [];
  for (const x of comps) {
    const asin = asinOf(x.asin);
    if (seen.has(asin)) continue;
    seen.add(asin);
    const role = x.role ?? 'comp';
    if (!(COMP_ROLES as readonly string[]).includes(role)) return fail('invalid', `A comp is one of: ${COMP_ROLES.join(', ')}.`);
    rows.push({ asin, role, note: clean(x.note ?? '', 'The note', 500, false), figure: await latestFigure(db, c, asin, c.now) });
  }
  await db.batch([
    { sql: 'DELETE FROM brief_comp WHERE brief_id = ? AND brief_version = ?', params: [briefId, briefVersion] },
    ...rows.map((r) => ({ sql: 'INSERT INTO brief_comp (brief_id, brief_version, asin, role, figure_id, note) VALUES (?, ?, ?, ?, ?, ?)', params: [briefId, briefVersion, r.asin, r.role, r.figure?.id ?? null, r.note] })),
    audit(c, 'market.brief_comps', briefId, { version: briefVersion, count: rows.length })
  ]);
}
export async function briefComps(db: Db, c: Pick<Ctx, 'studioId'>, briefId: string, briefVersion: number, today: string): Promise<BriefComp[]> {
  const rows = await db.all<{ briefId: string; briefVersion: number; asin: string; role: CompRole; note: string; figureId: string | null }>(
    'SELECT brief_id AS briefId, brief_version AS briefVersion, asin, role, note, figure_id AS figureId FROM brief_comp WHERE brief_id = ? AND brief_version = ? ORDER BY rowid',
    [briefId, briefVersion]
  );
  const out: BriefComp[] = [];
  for (const r of rows) {
    const f = r.figureId ? await db.first<FigureRow>(`SELECT ${FCOLS} FROM market_figure WHERE id = ? AND studio_id = ?`, [r.figureId, c.studioId]) : null;
    const figure = f ? toFigure(f) : null;
    out.push({ briefId: r.briefId, briefVersion: r.briefVersion, asin: r.asin, role: r.role, note: r.note, figure, ageDays: figure ? daysBetween(figure.capturedAt.slice(0, 10), today) : null });
  }
  return out;
}

// ---- reports ----------------------------------------------------------------------------------------------------------------------

export const REPORT_KINDS = ['category', 'keyword', 'cover_blurb'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export interface MarketReport {
  id: string;
  projectId: string;
  kind: ReportKind;
  title: string;
  asOf: string;
  payload: unknown;
  createdAt: string;
  createdBy: string;
}
interface ReportRow extends Omit<MarketReport, 'payload'> {
  payload: string;
}
const RCOLS = 'id, project_id AS projectId, kind, title, as_of AS asOf, payload, created_at AS createdAt, created_by AS createdBy';
const MAX_PAYLOAD = 200_000;
/** A saved report is never edited; a later one is a new row. `asOf` says what the figures in it are as of. */
export async function saveReport(db: Db, c: Ctx, i: { projectId: string; kind: ReportKind; title: string; asOf: string; payload: unknown }): Promise<MarketReport> {
  if (typeof i?.projectId !== 'string' || !i.projectId) fail('invalid', 'A book or series is needed.');
  if (!(REPORT_KINDS as readonly string[]).includes(i.kind)) fail('invalid', `A report is one of: ${REPORT_KINDS.join(', ')}.`);
  const asOf = cleanDay(i.asOf, 'The date the figures are as of');
  const body = JSON.stringify(i.payload ?? null);
  if (body.length > MAX_PAYLOAD) fail('invalid', 'The report is too large.');
  const id = newRecordId();
  await db.batch([
    { sql: 'INSERT INTO market_report (id, studio_id, project_id, kind, title, as_of, payload, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', params: [id, c.studioId, i.projectId, i.kind, clean(i.title, 'The title', 200), asOf, body, c.now, c.actor] },
    audit(c, 'market.report', id, { projectId: i.projectId, kind: i.kind })
  ]);
  return (await getReport(db, c, id))!;
}
export async function getReport(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<MarketReport | null> {
  const r = await db.first<ReportRow>(`SELECT ${RCOLS} FROM market_report WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
  return r ? { ...r, payload: JSON.parse(r.payload) } : null;
}
export async function listReports(db: Db, c: Pick<Ctx, 'studioId'>, f: { projectIds?: string[]; kind?: ReportKind } = {}): Promise<Omit<MarketReport, 'payload'>[]> {
  if (f.projectIds && !f.projectIds.length) return [];
  const where = ['studio_id = ?'];
  const params: unknown[] = [c.studioId];
  if (f.projectIds) (where.push(`project_id IN (${f.projectIds.map(() => '?').join(',')})`), params.push(...f.projectIds));
  if (f.kind) (where.push('kind = ?'), params.push(f.kind));
  return db.all(`SELECT id, project_id AS projectId, kind, title, as_of AS asOf, created_at AS createdAt, created_by AS createdBy FROM market_report WHERE ${where.join(' AND ')} ORDER BY as_of DESC, created_at DESC`, params);
}

// ---- decisions and what the figures did around them --------------------------------------------------------------------------------

export const DECISION_KINDS = ['cover', 'blurb', 'keywords', 'price', 'category', 'other'] as const;
export type MarketDecisionKind = (typeof DECISION_KINDS)[number];
export interface MarketDecision {
  id: string;
  editionId: string;
  asin: string | null;
  kind: MarketDecisionKind;
  fromValue: string;
  toValue: string;
  reason: string;
  assetId: string | null;
  briefId: string | null;
  decisionId: string | null;
  decidedBy: string;
  decidedAt: string;
}
const DCOLS = 'id, edition_id AS editionId, asin, kind, from_value AS fromValue, to_value AS toValue, reason, asset_id AS assetId, brief_id AS briefId, decision_id AS decisionId, decided_by AS decidedBy, decided_at AS decidedAt';
export async function recordMarketDecision(
  db: Db,
  c: Ctx,
  i: { editionId: string; asin?: string | null; kind: MarketDecisionKind; from?: string; to?: string; reason: string; assetId?: string | null; briefId?: string | null; projectId?: string | null; decidedAt?: string }
): Promise<MarketDecision> {
  if (typeof i?.editionId !== 'string' || !i.editionId) fail('invalid', 'An edition is needed.');
  if (!(DECISION_KINDS as readonly string[]).includes(i.kind)) fail('invalid', `A change is one of: ${DECISION_KINDS.join(', ')}.`);
  const reason = clean(i.reason, 'The reason', 2000);
  const asin = i.asin ? asinOf(i.asin) : null;
  const when = i.decidedAt ? new Date(i.decidedAt).toISOString() : c.now;
  if (Number.isNaN(Date.parse(when))) fail('invalid', 'The time of the change is not a time.');
  const from = clean(i.from ?? '', 'The old value', 1000, false);
  const to = clean(i.to ?? '', 'The new value', 1000, false);
  const ledger = await recordDecision(db, c, { projectId: i.projectId ?? null, title: `Changed the ${i.kind}`, context: from ? `From: ${from}` : '', outcome: `${to || `a new ${i.kind}`}. ${reason}` });
  const id = newRecordId();
  await db.batch([
    { sql: 'INSERT INTO market_decision (id, studio_id, edition_id, asin, kind, from_value, to_value, reason, asset_id, brief_id, decision_id, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', params: [id, c.studioId, i.editionId, asin, i.kind, from, to, reason, i.assetId ?? null, i.briefId ?? null, ledger.id, c.actor, when] },
    audit(c, 'market.decision', id, { editionId: i.editionId, kind: i.kind })
  ]);
  return (await getMarketDecision(db, c, id))!;
}
export async function getMarketDecision(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<MarketDecision | null> {
  return db.first<MarketDecision>(`SELECT ${DCOLS} FROM market_decision WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
}
export async function listMarketDecisions(db: Db, c: Pick<Ctx, 'studioId'>, f: { editionId?: string; editionIds?: string[] } = {}): Promise<MarketDecision[]> {
  const where = ['studio_id = ?'];
  const params: unknown[] = [c.studioId];
  if (f.editionId) (where.push('edition_id = ?'), params.push(f.editionId));
  if (f.editionIds) {
    if (!f.editionIds.length) return [];
    where.push(`edition_id IN (${f.editionIds.map(() => '?').join(',')})`);
    params.push(...f.editionIds);
  }
  return db.all<MarketDecision>(`SELECT ${DCOLS} FROM market_decision WHERE ${where.join(' AND ')} ORDER BY decided_at DESC`, params);
}

export interface WindowSide {
  points: { capturedAt: string; rank: number | null; price: number | null; ratings: number | null }[];
  /** The middle value of each measure over the points that have it, or null with none. */
  median: { rank: number | null; price: number | null; ratings: number | null };
}
export interface DecisionWindow {
  decision: MarketDecision;
  days: number;
  before: WindowSide;
  after: WindowSide;
  /** Other changes to the same book inside the same window: what else could have moved the figures. */
  alsoChanged: MarketDecision[];
  /** Plain statements about how far to trust the comparison. */
  caveats: string[];
}
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const side = (figs: MarketFigure[]): WindowSide => ({
  points: figs.map((f) => ({ capturedAt: f.capturedAt, rank: f.rank, price: f.price, ratings: f.ratings })),
  median: { rank: median(figs.flatMap((f) => (f.rank === null ? [] : [f.rank]))), price: median(figs.flatMap((f) => (f.price === null ? [] : [f.price]))), ratings: median(figs.flatMap((f) => (f.ratings === null ? [] : [f.ratings]))) }
});
/** The figures in the `days` before and after a change, with the point count on each side and the other changes in the window. Never says it caused anything. */
export async function decisionWindow(db: Db, c: Pick<Ctx, 'studioId'>, decisionId: string, days = 30): Promise<DecisionWindow> {
  const d = await getMarketDecision(db, c, decisionId);
  if (!d) return fail('not-found', 'That change is not there.');
  if (!Number.isInteger(days) || days < 1 || days > 365) return fail('invalid', 'A window is from 1 to 365 days.');
  const at = d.decidedAt.slice(0, 10);
  const figs = d.asin ? await listFigures(db, c, { asin: d.asin, from: `${addDays(at, -days)}T00:00:00.000Z`, to: `${addDays(at, days)}T23:59:59.999Z`, limit: 5000 }) : [];
  const before = figs.filter((f) => f.capturedAt < d.decidedAt);
  const after = figs.filter((f) => f.capturedAt >= d.decidedAt);
  const others = (await listMarketDecisions(db, c, { editionId: d.editionId })).filter((o) => o.id !== d.id && Math.abs(daysBetween(o.decidedAt.slice(0, 10), at)) <= days);
  const caveats: string[] = [];
  if (!d.asin) caveats.push('This change names no ASIN, so there are no figures to compare.');
  else if (!before.length || !after.length) caveats.push(`There ${before.length === 1 ? 'is 1 figure' : `are ${before.length} figures`} before and ${after.length} after: not enough to compare.`);
  else if (Math.min(before.length, after.length) < 3) caveats.push(`Only ${Math.min(before.length, after.length)} figure${Math.min(before.length, after.length) === 1 ? '' : 's'} on the thinner side: a comparison of so few points says little.`);
  if (others.length) caveats.push(`${others.length} other change${others.length === 1 ? '' : 's'} to this book (${others.map((o) => o.kind).join(', ')}) fell in the same window, so the figures cannot be put down to this one.`);
  caveats.push('Figures are from captures, not sales; other things (a promotion, the season, the category) also move a rank.');
  return { decision: d, days, before: side(before), after: side(after), alsoChanged: others, caveats };
}

// ---- the post-launch review ---------------------------------------------------------------------------------------------------------

export interface ReviewPoint {
  /** Days after release this point is for. */
  day: number;
  /** The day it is for (release date plus `day`). */
  due: string;
  /** The first figure captured on or within `REVIEW_SLACK_DAYS` after that day, or null. */
  figure: MarketFigure | null;
  /** Why there is no figure, when there is none. */
  missing: string | null;
}
export const REVIEW_DAYS = [7, 30, 90] as const;
export const REVIEW_SLACK_DAYS = 5;
export interface LaunchReview {
  id: string;
  planId: string;
  state: 'open' | 'done';
  /** Measured at the review days, copied when it was filled: figures with their capture times. */
  measured: ReviewPoint[];
  /** What the plan expected, kept apart from what was measured. */
  planned: PlanTargets & { releaseDate?: string };
  worked: string;
  didNot: string;
  next: string;
  openedAt: string;
  openedBy: string;
  doneAt: string | null;
  doneBy: string | null;
}
interface ReviewRow extends Omit<LaunchReview, 'measured' | 'planned'> {
  measured: string;
  planned: string;
}
const LCOLS = 'id, plan_id AS planId, state, measured, planned, worked, did_not AS didNot, next, opened_at AS openedAt, opened_by AS openedBy, done_at AS doneAt, done_by AS doneBy';
const toReview = (r: ReviewRow): LaunchReview => ({ ...r, measured: JSON.parse(r.measured) as ReviewPoint[], planned: JSON.parse(r.planned) as LaunchReview['planned'] });
export async function getReview(db: Db, c: Pick<Ctx, 'studioId'>, planId: string): Promise<LaunchReview | null> {
  const r = await db.first<ReviewRow>(`SELECT ${LCOLS} FROM launch_review WHERE plan_id = ? AND studio_id = ?`, [planId, c.studioId]);
  return r ? toReview(r) : null;
}
/** The figure for each review day, from the published figures of the edition's ASIN, as of `today`. A day not yet reached has no figure and says so. */
export async function reviewPoints(db: Db, c: Pick<Ctx, 'studioId'>, asin: string | null, releaseDate: string, today: string): Promise<ReviewPoint[]> {
  const out: ReviewPoint[] = [];
  for (const day of REVIEW_DAYS) {
    const due = addDays(releaseDate, day);
    if (due > today) {
      out.push({ day, due, figure: null, missing: `Day ${day} is ${due}, not reached yet.` });
      continue;
    }
    if (!asin) {
      out.push({ day, due, figure: null, missing: 'The edition has no ASIN, so no figures were captured for it.' });
      continue;
    }
    const f = (await listFigures(db, c, { asin, from: `${due}T00:00:00.000Z`, to: `${addDays(due, REVIEW_SLACK_DAYS)}T23:59:59.999Z`, limit: 1 }))[0] ?? null;
    out.push({ day, due, figure: f, missing: f ? null : `No capture between ${due} and ${addDays(due, REVIEW_SLACK_DAYS)}.` });
  }
  return out;
}
/** Opens the review of a plan (once) with the figures there are today. `refreshReview` fills it again as later days arrive. */
export async function openReview(db: Db, c: Ctx, planId: string, asin: string | null, today: string): Promise<LaunchReview> {
  const plan = await getPlan(db, c, planId);
  if (!plan) return fail('not-found', 'That plan is not there.');
  if (plan.state !== 'live' && plan.state !== 'reviewed') return fail('conflict', 'A plan is reviewed after it has gone live.');
  if (await getReview(db, c, planId)) return fail('exists', 'That plan already has a review.');
  const points = await reviewPoints(db, c, asin, plan.releaseDate, today);
  await db.batch([
    { sql: "INSERT INTO launch_review (id, studio_id, plan_id, state, measured, planned, opened_at, opened_by) VALUES (?, ?, ?, 'open', ?, ?, ?, ?)", params: [newRecordId(), c.studioId, planId, JSON.stringify(points), JSON.stringify({ ...plan.targets, releaseDate: plan.releaseDate }), c.now, c.actor] },
    audit(c, 'launch.review_open', planId, {})
  ]);
  return (await getReview(db, c, planId))!;
}
export async function refreshReview(db: Db, c: Ctx, planId: string, asin: string | null, today: string): Promise<LaunchReview> {
  const r = await getReview(db, c, planId);
  const plan = await getPlan(db, c, planId);
  if (!r || !plan) return fail('not-found', 'That review is not there.');
  if (r.state === 'done') return fail('conflict', 'That review is done.');
  const points = await reviewPoints(db, c, asin, plan.releaseDate, today);
  await db.batch([{ sql: 'UPDATE launch_review SET measured = ? WHERE id = ? AND studio_id = ?', params: [JSON.stringify(points), r.id, c.studioId] }, audit(c, 'launch.review_refresh', planId, {})]);
  return (await getReview(db, c, planId))!;
}
export async function writeReview(db: Db, c: Ctx, planId: string, i: { worked?: string; didNot?: string; next?: string }): Promise<LaunchReview> {
  const r = await getReview(db, c, planId);
  if (!r) return fail('not-found', 'That review is not there.');
  if (r.state === 'done') return fail('conflict', 'That review is done.');
  await db.batch([
    { sql: 'UPDATE launch_review SET worked = ?, did_not = ?, next = ? WHERE id = ? AND studio_id = ?', params: [clean(i.worked ?? r.worked, 'What worked', 5000, false), clean(i.didNot ?? r.didNot, 'What did not', 5000, false), clean(i.next ?? r.next, 'What next', 5000, false), r.id, c.studioId] },
    audit(c, 'launch.review_write', planId, {})
  ]);
  return (await getReview(db, c, planId))!;
}
/** Closes the review and marks the plan reviewed. */
export async function finishReview(db: Db, c: Ctx, planId: string): Promise<LaunchReview> {
  const r = await getReview(db, c, planId);
  if (!r) return fail('not-found', 'That review is not there.');
  if (r.state === 'done') return r;
  if (!r.worked && !r.didNot) return fail('invalid', 'Say what worked or what did not before closing the review.');
  await db.batch([
    { sql: "UPDATE launch_review SET state = 'done', done_at = ?, done_by = ? WHERE id = ? AND studio_id = ?", params: [c.now, c.actor, r.id, c.studioId] },
    { sql: "UPDATE release_plan SET state = 'reviewed', updated_at = ? WHERE id = ? AND studio_id = ?", params: [c.now, planId, c.studioId] },
    audit(c, 'launch.review_done', planId, {})
  ]);
  return (await getReview(db, c, planId))!;
}
