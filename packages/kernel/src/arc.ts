/**
 * ARC rounds (docs/M6-PLAN.md): who was invited, who has the file, who has posted a review, against a target. Cadrel tracks; it does not send.
 *
 *   - **No star rating is stored per reader and nothing asks for a favourable review.** A reader has or has not posted. Retailers prohibit conditioning
 *     an advance copy on a good review, and a tracker that stores ratings invites it.
 *   - **Reader details are personal data.** Counts are for everyone who may read the plan; names and emails are read only with launch.manage, and each read
 *     is logged (`logReaderRead`). A reader can be **erased**: details removed, the count kept, the erasure logged.
 *   - Reviews the studio reports are labelled *reported*; the ratings count in published Market figures is *measured*, as of its capture date.
 */
import type { Ctx } from './catalogue';
import { newRecordId } from './ids';
import { latestFigure, type MarketFigure } from './marketing';
import type { Db } from './vault';
import { WorkError } from './work';

const fail = (code: ConstructorParameters<typeof WorkError>[0], m: string): never => {
  throw new WorkError(code, m);
};
const audit = (c: Ctx, action: string, target: string, detail: unknown) => ({
  sql: 'INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)',
  params: [c.now, c.actor, action, target, JSON.stringify(detail)]
});
const clean = (v: unknown, what: string, max: number, required = true): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) return fail('invalid', `${what} cannot be empty.`);
  return s.length > max ? fail('invalid', `${what} is too long (${max} characters at most).`) : s;
};

export const READER_STATES = ['invited', 'sent', 'received', 'reviewed', 'declined', 'bounced'] as const;
export type ReaderState = (typeof READER_STATES)[number];
/** The states in which the reader has the file. */
export const HAS_FILE: readonly ReaderState[] = ['sent', 'received', 'reviewed'];

export interface ArcCampaign {
  id: string;
  planId: string;
  name: string;
  targetReaders: number;
  reviewTarget: number;
  sendBy: string | null;
  reviewBy: string | null;
  fileId: string | null;
  fileVersion: number | null;
  state: 'open' | 'closed';
  reportedReviews: number;
  createdAt: string;
  createdBy: string;
}
const CCOLS = 'id, plan_id AS planId, name, target_readers AS targetReaders, review_target AS reviewTarget, send_by AS sendBy, review_by AS reviewBy, file_id AS fileId, file_version AS fileVersion, state, reported_reviews AS reportedReviews, created_at AS createdAt, created_by AS createdBy';
export async function getCampaign(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<ArcCampaign | null> {
  return db.first<ArcCampaign>(`SELECT ${CCOLS} FROM arc_campaign WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
}
export async function listCampaigns(db: Db, c: Pick<Ctx, 'studioId'>, f: { planId?: string; planIds?: string[] } = {}): Promise<ArcCampaign[]> {
  const where = ['studio_id = ?'];
  const params: unknown[] = [c.studioId];
  if (f.planId) (where.push('plan_id = ?'), params.push(f.planId));
  if (f.planIds) {
    if (!f.planIds.length) return [];
    where.push(`plan_id IN (${f.planIds.map(() => '?').join(',')})`);
    params.push(...f.planIds);
  }
  return db.all<ArcCampaign>(`SELECT ${CCOLS} FROM arc_campaign WHERE ${where.join(' AND ')} ORDER BY created_at`, params);
}
const count = (v: unknown, what: string): number => {
  const n = v === undefined || v === null ? 0 : v;
  if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > 100_000) return fail('invalid', `${what} is a whole number from 0.`);
  return n as number;
};
export async function createCampaign(db: Db, c: Ctx, i: { planId: string; name: string; targetReaders?: number; reviewTarget?: number; sendBy?: string | null; reviewBy?: string | null; fileId?: string | null; fileVersion?: number | null }): Promise<ArcCampaign> {
  const plan = await db.first<{ id: string }>('SELECT id FROM release_plan WHERE id = ? AND studio_id = ?', [i?.planId, c.studioId]);
  if (!plan) return fail('not-found', 'That plan is not there.');
  if (i.fileId) {
    const f = await db.first<{ n: number }>('SELECT n FROM file_version WHERE file_id = ? AND n = ?', [i.fileId, i.fileVersion ?? -1]);
    if (!f) return fail('not-found', 'That version of the file is not there.');
  }
  const id = newRecordId();
  await db.batch([
    { sql: "INSERT INTO arc_campaign (id, studio_id, plan_id, name, target_readers, review_target, send_by, review_by, file_id, file_version, state, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)", params: [id, c.studioId, i.planId, clean(i.name, 'The name', 100), count(i.targetReaders, 'The reader target'), count(i.reviewTarget, 'The review target'), i.sendBy ?? null, i.reviewBy ?? null, i.fileId ?? null, i.fileId ? i.fileVersion! : null, c.now, c.actor] },
    audit(c, 'arc.campaign_create', id, { planId: i.planId })
  ]);
  return (await getCampaign(db, c, id))!;
}
/** The review count the studio reports (there is no retailer API), changed by a person. */
export async function reportReviews(db: Db, c: Ctx, campaignId: string, n: number): Promise<ArcCampaign> {
  if (!(await getCampaign(db, c, campaignId))) return fail('not-found', 'That campaign is not there.');
  await db.batch([{ sql: 'UPDATE arc_campaign SET reported_reviews = ? WHERE id = ? AND studio_id = ?', params: [count(n, 'The number of reviews'), campaignId, c.studioId] }, audit(c, 'arc.reviews_reported', campaignId, { n })]);
  return (await getCampaign(db, c, campaignId))!;
}
export async function closeCampaign(db: Db, c: Ctx, campaignId: string): Promise<ArcCampaign> {
  if (!(await getCampaign(db, c, campaignId))) return fail('not-found', 'That campaign is not there.');
  await db.batch([{ sql: "UPDATE arc_campaign SET state = 'closed' WHERE id = ? AND studio_id = ?", params: [campaignId, c.studioId] }, audit(c, 'arc.campaign_close', campaignId, {})]);
  return (await getCampaign(db, c, campaignId))!;
}

export interface ArcReader {
  id: string;
  campaignId: string;
  name: string | null;
  email: string | null;
  source: string;
  state: ReaderState;
  sentAt: string | null;
  reviewedAt: string | null;
  reviewUrl: string | null;
  note: string;
  erasedAt: string | null;
  createdAt: string;
}
const RCOLS = 'id, campaign_id AS campaignId, name, email, source, state, sent_at AS sentAt, reviewed_at AS reviewedAt, review_url AS reviewUrl, note, erased_at AS erasedAt, created_at AS createdAt';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
async function reader(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<ArcReader | null> {
  return db.first<ArcReader>(`SELECT ${RCOLS} FROM arc_reader WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
}
export async function addReader(db: Db, c: Ctx, campaignId: string, i: { name: string; email?: string | null; source?: string; note?: string }): Promise<ArcReader> {
  if (!(await getCampaign(db, c, campaignId))) return fail('not-found', 'That campaign is not there.');
  const name = clean(i?.name, 'The reader’s name', 200);
  const email = i.email ? clean(i.email, 'The email', 254).toLowerCase() : null;
  if (email && !EMAIL.test(email)) fail('invalid', 'That does not look like an email address.');
  if (email) {
    const dup = await db.first<{ id: string }>('SELECT id FROM arc_reader WHERE studio_id = ? AND campaign_id = ? AND lower(email) = ? AND erased_at IS NULL', [c.studioId, campaignId, email]);
    if (dup) return fail('exists', 'That reader is already in this campaign.');
  }
  const id = newRecordId();
  await db.batch([
    { sql: "INSERT INTO arc_reader (id, studio_id, campaign_id, name, email, source, state, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, 'invited', ?, ?, ?)", params: [id, c.studioId, campaignId, name, email, clean(i.source ?? '', 'The source', 100, false), clean(i.note ?? '', 'The note', 500, false), c.now, c.actor] },
    audit(c, 'arc.reader_add', id, { campaignId })
  ]);
  return (await reader(db, c, id))!;
}
/** Moves a reader to a state. The time is stamped when they are sent the file or review it. A review URL, when given, is kept; no rating is. */
export async function setReaderState(db: Db, c: Ctx, readerId: string, state: ReaderState, o: { reviewUrl?: string | null; at?: string } = {}): Promise<ArcReader> {
  const r = await reader(db, c, readerId);
  if (!r) return fail('not-found', 'That reader is not there.');
  if (r.erasedAt) return fail('conflict', 'That reader was erased.');
  if (!(READER_STATES as readonly string[]).includes(state)) return fail('invalid', `A reader is one of: ${READER_STATES.join(', ')}.`);
  const at = o.at ?? c.now;
  await db.batch([
    { sql: 'UPDATE arc_reader SET state = ?, sent_at = CASE WHEN ? IN (\'sent\', \'received\', \'reviewed\') AND sent_at IS NULL THEN ? ELSE sent_at END, reviewed_at = CASE WHEN ? = \'reviewed\' THEN ? ELSE reviewed_at END, review_url = COALESCE(?, review_url) WHERE id = ? AND studio_id = ?', params: [state, state, at, state, at, o.reviewUrl ? clean(o.reviewUrl, 'The link', 500) : null, readerId, c.studioId] },
    audit(c, 'arc.reader_state', readerId, { state })
  ]);
  return (await reader(db, c, readerId))!;
}
/** Removes a reader's details (name, email, link, note) and keeps the count. */
export async function eraseReader(db: Db, c: Ctx, readerId: string): Promise<void> {
  const r = await reader(db, c, readerId);
  if (!r) return fail('not-found', 'That reader is not there.');
  if (r.erasedAt) return;
  await db.batch([{ sql: "UPDATE arc_reader SET name = NULL, email = NULL, review_url = NULL, note = '', source = '', erased_at = ? WHERE id = ? AND studio_id = ?", params: [c.now, readerId, c.studioId] }, audit(c, 'arc.reader_erase', readerId, { campaignId: r.campaignId })]);
}
/** Reader details, for managers. Every call is logged (who looked, at which campaign). */
export async function readersOf(db: Db, c: Ctx, campaignId: string): Promise<ArcReader[]> {
  if (!(await getCampaign(db, c, campaignId))) return fail('not-found', 'That campaign is not there.');
  await db.run('INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)', [c.now, c.actor, 'arc.readers_read', campaignId, '{}']);
  return db.all<ArcReader>(`SELECT ${RCOLS} FROM arc_reader WHERE campaign_id = ? AND studio_id = ? ORDER BY created_at, rowid`, [campaignId, c.studioId]);
}
export interface ArcCounts {
  total: number;
  /** By state, erased readers included: erasure keeps the count. */
  byState: Record<ReaderState, number>;
  /** Readers who have the file, who have reviewed (they posted), and the targets. */
  withFile: number;
  reviewed: number;
  targetReaders: number;
  reviewTarget: number;
}
/** Counts only: no names, no emails. What everyone who may read the plan sees. */
export async function countsOf(db: Db, c: Pick<Ctx, 'studioId'>, campaignId: string): Promise<ArcCounts> {
  const camp = await getCampaign(db, c, campaignId);
  if (!camp) return fail('not-found', 'That campaign is not there.');
  const rows = await db.all<{ state: ReaderState; n: number }>('SELECT state, COUNT(*) AS n FROM arc_reader WHERE campaign_id = ? AND studio_id = ? GROUP BY state', [campaignId, c.studioId]);
  const byState = Object.fromEntries(READER_STATES.map((s) => [s, rows.find((r) => r.state === s)?.n ?? 0])) as Record<ReaderState, number>;
  return { total: Object.values(byState).reduce((a, b) => a + b, 0), byState, withFile: HAS_FILE.reduce((n, s) => n + byState[s], 0), reviewed: byState.reviewed, targetReaders: camp.targetReaders, reviewTarget: camp.reviewTarget };
}
/** Readers who have the file across every campaign of a plan: what the plan's ARC item is judged by. */
export async function arcSent(db: Db, c: Pick<Ctx, 'studioId'>, planId: string): Promise<number> {
  const r = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM arc_reader r JOIN arc_campaign k ON k.id = r.campaign_id WHERE k.plan_id = ? AND r.studio_id = ? AND r.state IN ('sent', 'received', 'reviewed')`, [planId, c.studioId]);
  return r?.n ?? 0;
}
export interface ReviewCrossCheck {
  /** What the studio says has been posted (entered by a person), and what readers marked reviewed here. */
  reported: number;
  readersReviewed: number;
  /** The ratings count in the newest published figure of the book, with when it was captured: measured. */
  measured: { ratings: number | null; capturedAt: string } | null;
}
export async function reviewCrossCheck(db: Db, c: Pick<Ctx, 'studioId'>, campaignId: string, asin: string | null, onOrBefore?: string): Promise<ReviewCrossCheck> {
  const camp = await getCampaign(db, c, campaignId);
  if (!camp) return fail('not-found', 'That campaign is not there.');
  const counts = await countsOf(db, c, campaignId);
  const fig: MarketFigure | null = asin ? await latestFigure(db, c, asin, onOrBefore) : null;
  return { reported: camp.reportedReviews, readersReviewed: counts.reviewed, measured: fig ? { ratings: fig.ratings, capturedAt: fig.capturedAt } : null };
}
