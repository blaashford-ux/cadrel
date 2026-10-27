/**
 * The business records: contributions, credits, rights and revenue shares. Four concepts, four tables, four sets of functions, and no
 * function or column that joins them: credit is not ownership, and contribution is not share (docs/ARCHITECTURE.md, a standing requirement).
 * Each is about a subject, an IP, series, book or edition of the catalogue. Records over the kernel's `Db`: every change is one batch with
 * its audit row, and nothing here decides who may see or change them (the service checks `business.read` / `business.manage` first, and
 * logs reads). Money is whole minor units and shares are basis points; neither is ever a float.
 */
import { newRecordId } from './ids';
import type { Ctx } from './catalogue';
import type { Db } from './vault';

export type BusinessCode = 'invalid' | 'not-found' | 'conflict';
export class BusinessError extends Error {
  constructor(readonly code: BusinessCode, message: string) {
    super(message);
  }
}
const fail = (code: BusinessCode, m: string): never => {
  throw new BusinessError(code, m);
};
const audit = (c: Ctx, action: string, target: string, detail: unknown) => ({
  sql: 'INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)',
  params: [c.now, c.actor, action, target, JSON.stringify(detail)]
});

// ---- subjects and validation -------------------------------------------------------------------------------------------------

export const SUBJECT_KINDS = ['ip', 'series', 'book', 'edition'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];
export interface Subject { kind: SubjectKind; id: string }
const TABLE: Record<SubjectKind, string> = { ip: 'ip', series: 'series', book: 'book', edition: 'edition' };

async function checkSubject(db: Db, c: Pick<Ctx, 'studioId'>, s: Subject): Promise<Subject> {
  if (!s || !Object.hasOwn(TABLE, s.kind) || typeof s.id !== 'string' || !s.id) return fail('invalid', `A subject is an ${SUBJECT_KINDS.join(', ')} of the catalogue.`);
  if (!(await db.first(`SELECT 1 AS x FROM ${TABLE[s.kind]} WHERE id = ? AND studio_id = ?`, [s.id, c.studioId]))) return fail('not-found', `That ${s.kind} is not in the catalogue.`);
  return { kind: s.kind, id: s.id };
}
function oneOf<T extends string>(list: readonly T[], v: unknown, what: string): T {
  return (list as readonly string[]).includes(v as string) ? (v as T) : fail('invalid', `${what} is one of: ${list.join(', ')}.`);
}
const text = (v: unknown, what: string, max: number, required = false): string => {
  const s = typeof v === 'string' ? v.trim().replace(/[ \t]+/g, ' ') : '';
  if (required && !s) return fail('invalid', `${what} cannot be empty.`);
  return s.length > max ? fail('invalid', `${what} is too long (${max} characters at most).`) : s;
};
/** A calendar date, written 2026-11-30, or null. */
export function businessDate(v: unknown, what: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  const real = (d: string) => {
    try {
      return new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
    } catch {
      return false; // month 13
    }
  };
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !real(v)) return fail('invalid', `${what} is written 2026-11-30.`);
  return v;
}
function period(from: string | null, to: string | null, what: string): void {
  if (from && to && to < from) fail('invalid', `${what} cannot end before it starts.`);
}
async function personExists(db: Db, c: Pick<Ctx, 'studioId'>, id: unknown): Promise<string> {
  if (typeof id !== 'string' || !(await db.first('SELECT 1 AS x FROM person WHERE id = ? AND studio_id = ?', [id, c.studioId]))) return fail('not-found', 'That person is not here.');
  return id;
}

// ---- contribution: who did what on what --------------------------------------------------------------------------------------

export const CONTRIBUTION_ROLES = ['author', 'co-author', 'editor', 'developmental editor', 'copy editor', 'proofreader', 'cover artist', 'illustrator', 'designer', 'formatter', 'narrator', 'translator', 'marketer', 'other'] as const;
export interface Contribution { id: string; subject: Subject; personId: string; role: string; description: string; startedOn: string | null; doneOn: string | null; archivedAt: string | null; createdAt: string; updatedAt: string }
interface ContributionRow { id: string; kind: SubjectKind; sid: string; personId: string; role: string; description: string; startedOn: string | null; doneOn: string | null; archivedAt: string | null; createdAt: string; updatedAt: string }
const toContribution = (r: ContributionRow): Contribution => ({ id: r.id, subject: { kind: r.kind, id: r.sid }, personId: r.personId, role: r.role, description: r.description, startedOn: r.startedOn, doneOn: r.doneOn, archivedAt: r.archivedAt, createdAt: r.createdAt, updatedAt: r.updatedAt });
const CONTRIB_COLS = 'id, subject_kind AS kind, subject_id AS sid, person_id AS personId, role, description, started_on AS startedOn, done_on AS doneOn, archived_at AS archivedAt, created_at AS createdAt, updated_at AS updatedAt';

export async function addContribution(db: Db, c: Ctx, i: { subject: Subject; personId: string; role: string; description?: string; startedOn?: string | null; doneOn?: string | null }): Promise<Contribution> {
  const subject = await checkSubject(db, c, i?.subject as Subject);
  const personId = await personExists(db, c, i?.personId);
  const role = oneOf(CONTRIBUTION_ROLES, i?.role, 'A role');
  const startedOn = businessDate(i.startedOn, 'A start date');
  const doneOn = businessDate(i.doneOn, 'A finish date');
  period(startedOn, doneOn, 'A contribution');
  const id = newRecordId();
  await db.batch([
    { sql: 'INSERT INTO contribution (id, studio_id, subject_kind, subject_id, person_id, role, description, started_on, done_on, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', params: [id, c.studioId, subject.kind, subject.id, personId, role, text(i.description, 'The description', 500), startedOn, doneOn, c.now, c.actor, c.now, c.actor] },
    audit(c, 'contribution.add', id, { subject, personId, role })
  ]);
  return (await getContribution(db, c, id))!;
}
export async function getContribution(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<Contribution | null> {
  const r = await db.first<ContributionRow>(`SELECT ${CONTRIB_COLS} FROM contribution WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
  return r ? toContribution(r) : null;
}
export async function updateContribution(db: Db, c: Ctx, id: string, patch: { role?: string; description?: string; startedOn?: string | null; doneOn?: string | null }): Promise<Contribution> {
  const cur = (await getContribution(db, c, id)) ?? fail('not-found', 'That contribution is not there.');
  const next = { role: patch.role === undefined ? cur.role : oneOf(CONTRIBUTION_ROLES, patch.role, 'A role'), description: patch.description === undefined ? cur.description : text(patch.description, 'The description', 500), startedOn: patch.startedOn === undefined ? cur.startedOn : businessDate(patch.startedOn, 'A start date'), doneOn: patch.doneOn === undefined ? cur.doneOn : businessDate(patch.doneOn, 'A finish date') };
  period(next.startedOn, next.doneOn, 'A contribution');
  await db.batch([{ sql: 'UPDATE contribution SET role = ?, description = ?, started_on = ?, done_on = ?, updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ?', params: [next.role, next.description, next.startedOn, next.doneOn, c.now, c.actor, id, c.studioId] }, audit(c, 'contribution.update', id, patch)]);
  return (await getContribution(db, c, id))!;
}
export async function listContributions(db: Db, c: Pick<Ctx, 'studioId'>, f: { subject?: Subject; personId?: string; archived?: boolean } = {}): Promise<Contribution[]> {
  const where = ['studio_id = ?', f.archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL'];
  const params: unknown[] = [c.studioId];
  if (f.subject) (where.push('subject_kind = ? AND subject_id = ?'), params.push(f.subject.kind, f.subject.id));
  if (f.personId) (where.push('person_id = ?'), params.push(f.personId));
  return (await db.all<ContributionRow>(`SELECT ${CONTRIB_COLS} FROM contribution WHERE ${where.join(' AND ')} ORDER BY subject_kind, subject_id, created_at`, params)).map(toContribution);
}

// ---- credit: how someone is named, and where ---------------------------------------------------------------------------------

export const CREDIT_ROLES = ['author', 'co-author', 'editor', 'cover design', 'illustration', 'narration', 'translation', 'foreword', 'other'] as const;
export const CREDIT_PLACEMENTS = ['cover', 'title-page', 'copyright-page', 'acknowledgements', 'listing', 'back-matter'] as const;
export interface Credit { id: string; subject: Subject; personId: string | null; penNameId: string | null; /** What is shown: the override if there is one, else the pen name or the person's name. */ name: string; displayAs: string; role: string; placement: string; position: number; archivedAt: string | null }
interface CreditRow { id: string; kind: SubjectKind; sid: string; personId: string | null; penNameId: string | null; displayAs: string; role: string; placement: string; position: number; archivedAt: string | null; shown: string }
const CREDIT_SELECT = `SELECT c.id, c.subject_kind AS kind, c.subject_id AS sid, c.person_id AS personId, c.pen_name_id AS penNameId, c.display_as AS displayAs, c.role, c.placement, c.position, c.archived_at AS archivedAt,
  COALESCE((SELECT display_name FROM pen_name WHERE id = c.pen_name_id), (SELECT name FROM person WHERE id = c.person_id), '') AS shown FROM credit c`;
const toCredit = (r: CreditRow): Credit => ({ id: r.id, subject: { kind: r.kind, id: r.sid }, personId: r.personId, penNameId: r.penNameId, name: r.displayAs || r.shown, displayAs: r.displayAs, role: r.role, placement: r.placement, position: r.position, archivedAt: r.archivedAt });

export async function addCredit(db: Db, c: Ctx, i: { subject: Subject; personId?: string | null; penNameId?: string | null; role: string; placement: string; displayAs?: string; position?: number }): Promise<Credit> {
  const subject = await checkSubject(db, c, i?.subject as Subject);
  if (!!i.personId === !!i.penNameId) fail('invalid', 'A credit names either a person or a pen name.');
  if (i.penNameId && !(await db.first('SELECT 1 AS x FROM pen_name WHERE id = ? AND studio_id = ?', [i.penNameId, c.studioId]))) fail('not-found', 'That pen name is not here.');
  const personId = i.personId ? await personExists(db, c, i.personId) : null;
  const position = i.position ?? 0;
  if (!Number.isInteger(position) || position < 0 || position > 999) fail('invalid', 'A position is a whole number from 0 to 999.');
  const id = newRecordId();
  await db.batch([
    { sql: 'INSERT INTO credit (id, studio_id, subject_kind, subject_id, person_id, pen_name_id, role, placement, display_as, position, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', params: [id, c.studioId, subject.kind, subject.id, personId, i.penNameId ?? null, oneOf(CREDIT_ROLES, i.role, 'A credit role'), oneOf(CREDIT_PLACEMENTS, i.placement, 'A placement'), text(i.displayAs, 'The name as shown', 120), position, c.now, c.actor, c.now, c.actor] },
    audit(c, 'credit.add', id, { subject, personId, penNameId: i.penNameId ?? null, role: i.role, placement: i.placement })
  ]);
  return (await getCredit(db, c, id))!;
}
export async function getCredit(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<Credit | null> {
  const r = await db.first<CreditRow>(`${CREDIT_SELECT} WHERE c.id = ? AND c.studio_id = ?`, [id, c.studioId]);
  return r ? toCredit(r) : null;
}
export async function updateCredit(db: Db, c: Ctx, id: string, patch: { role?: string; placement?: string; displayAs?: string; position?: number }): Promise<Credit> {
  const cur = (await getCredit(db, c, id)) ?? fail('not-found', 'That credit is not there.');
  const next = { role: patch.role === undefined ? cur.role : oneOf(CREDIT_ROLES, patch.role, 'A credit role'), placement: patch.placement === undefined ? cur.placement : oneOf(CREDIT_PLACEMENTS, patch.placement, 'A placement'), displayAs: patch.displayAs === undefined ? cur.displayAs : text(patch.displayAs, 'The name as shown', 120), position: patch.position === undefined ? cur.position : patch.position };
  if (!Number.isInteger(next.position) || next.position < 0 || next.position > 999) fail('invalid', 'A position is a whole number from 0 to 999.');
  await db.batch([{ sql: 'UPDATE credit SET role = ?, placement = ?, display_as = ?, position = ?, updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ?', params: [next.role, next.placement, next.displayAs, next.position, c.now, c.actor, id, c.studioId] }, audit(c, 'credit.update', id, patch)]);
  return (await getCredit(db, c, id))!;
}
/** Credits on a subject, in the order they are shown: by placement, then position, then name. */
export async function listCredits(db: Db, c: Pick<Ctx, 'studioId'>, f: { subject?: Subject; archived?: boolean } = {}): Promise<Credit[]> {
  const where = ['c.studio_id = ?', f.archived ? 'c.archived_at IS NOT NULL' : 'c.archived_at IS NULL'];
  const params: unknown[] = [c.studioId];
  if (f.subject) (where.push('c.subject_kind = ? AND c.subject_id = ?'), params.push(f.subject.kind, f.subject.id));
  const list = (await db.all<CreditRow>(`${CREDIT_SELECT} WHERE ${where.join(' AND ')}`, params)).map(toCredit);
  const rank = (p: string) => CREDIT_PLACEMENTS.indexOf(p as never);
  return list.sort((a, b) => rank(a.placement) - rank(b.placement) || a.position - b.position || a.name.localeCompare(b.name));
}

// ---- rights: who owns or licenses what ---------------------------------------------------------------------------------------

export const RIGHTS_KINDS = ['owned', 'licensed-in', 'licensed-out', 'reverted'] as const;
export const RIGHTS_TYPES = ['all', 'print', 'ebook', 'audio', 'translation', 'film-tv', 'serial', 'other'] as const;
export interface Rights { id: string; subject: Subject; holderPersonId: string | null; holderName: string | null; kind: string; right: string; territory: string; language: string; startsOn: string | null; endsOn: string | null; exclusive: boolean; restrictions: string; archivedAt: string | null }
interface RightsRow { id: string; kind: string; sk: SubjectKind; sid: string; holderPersonId: string | null; holderName: string | null; right: string; territory: string; language: string; startsOn: string | null; endsOn: string | null; exclusive: number; restrictions: string; archivedAt: string | null }
const RIGHTS_COLS = 'id, subject_kind AS sk, subject_id AS sid, holder_person_id AS holderPersonId, holder_name AS holderName, kind, right_type AS right, territory, language, starts_on AS startsOn, ends_on AS endsOn, exclusive, restrictions, archived_at AS archivedAt';
const toRights = (r: RightsRow): Rights => ({ id: r.id, subject: { kind: r.sk, id: r.sid }, holderPersonId: r.holderPersonId, holderName: r.holderName, kind: r.kind, right: r.right, territory: r.territory, language: r.language, startsOn: r.startsOn, endsOn: r.endsOn, exclusive: !!r.exclusive, restrictions: r.restrictions, archivedAt: r.archivedAt });

export interface NewRights { subject: Subject; holderPersonId?: string | null; holderName?: string | null; kind: string; right: string; territory?: string; language?: string; startsOn?: string | null; endsOn?: string | null; exclusive?: boolean; restrictions?: string }
export async function addRights(db: Db, c: Ctx, i: NewRights): Promise<Rights> {
  const subject = await checkSubject(db, c, i?.subject as Subject);
  const holderName = i.holderName ? text(i.holderName, 'The holder', 120, true) : null;
  if (!!i.holderPersonId === !!holderName) fail('invalid', 'The holder is either a person here or a named outside party.');
  const holderPersonId = i.holderPersonId ? await personExists(db, c, i.holderPersonId) : null;
  const startsOn = businessDate(i.startsOn, 'A start date');
  const endsOn = businessDate(i.endsOn, 'An end date');
  period(startsOn, endsOn, 'A grant of rights');
  const id = newRecordId();
  await db.batch([
    { sql: 'INSERT INTO rights (id, studio_id, subject_kind, subject_id, holder_person_id, holder_name, kind, right_type, territory, language, starts_on, ends_on, exclusive, restrictions, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', params: [id, c.studioId, subject.kind, subject.id, holderPersonId, holderName, oneOf(RIGHTS_KINDS, i.kind, 'A kind of rights'), oneOf(RIGHTS_TYPES, i.right, 'A right'), text(i.territory ?? 'worldwide', 'The territory', 200, true), text(i.language, 'The language', 40), startsOn, endsOn, i.exclusive ? 1 : 0, text(i.restrictions, 'The restrictions', 2000), c.now, c.actor, c.now, c.actor] },
    audit(c, 'rights.add', id, { subject, kind: i.kind, right: i.right })
  ]);
  return (await getRights(db, c, id))!;
}
export async function getRights(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<Rights | null> {
  const r = await db.first<RightsRow>(`SELECT ${RIGHTS_COLS} FROM rights WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
  return r ? toRights(r) : null;
}
export async function updateRights(db: Db, c: Ctx, id: string, patch: { territory?: string; language?: string; startsOn?: string | null; endsOn?: string | null; exclusive?: boolean; restrictions?: string }): Promise<Rights> {
  const cur = (await getRights(db, c, id)) ?? fail('not-found', 'Those rights are not there.');
  const next = { territory: patch.territory === undefined ? cur.territory : text(patch.territory, 'The territory', 200, true), language: patch.language === undefined ? cur.language : text(patch.language, 'The language', 40), startsOn: patch.startsOn === undefined ? cur.startsOn : businessDate(patch.startsOn, 'A start date'), endsOn: patch.endsOn === undefined ? cur.endsOn : businessDate(patch.endsOn, 'An end date'), exclusive: patch.exclusive === undefined ? cur.exclusive : !!patch.exclusive, restrictions: patch.restrictions === undefined ? cur.restrictions : text(patch.restrictions, 'The restrictions', 2000) };
  period(next.startsOn, next.endsOn, 'A grant of rights');
  await db.batch([{ sql: 'UPDATE rights SET territory = ?, language = ?, starts_on = ?, ends_on = ?, exclusive = ?, restrictions = ?, updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ?', params: [next.territory, next.language, next.startsOn, next.endsOn, next.exclusive ? 1 : 0, next.restrictions, c.now, c.actor, id, c.studioId] }, audit(c, 'rights.update', id, patch)]);
  return (await getRights(db, c, id))!;
}
export async function listRights(db: Db, c: Pick<Ctx, 'studioId'>, f: { subject?: Subject; archived?: boolean } = {}): Promise<Rights[]> {
  const where = ['studio_id = ?', f.archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL'];
  const params: unknown[] = [c.studioId];
  if (f.subject) (where.push('subject_kind = ? AND subject_id = ?'), params.push(f.subject.kind, f.subject.id));
  return (await db.all<RightsRow>(`SELECT ${RIGHTS_COLS} FROM rights WHERE ${where.join(' AND ')} ORDER BY subject_kind, subject_id, right_type, starts_on`, params)).map(toRights);
}
/** The rights in force on a date (no start, or started; no end, or not yet ended). Pure. */
export const rightsInForce = (rows: Rights[], date: string): Rights[] => rows.filter((r) => !r.archivedAt && r.kind !== 'reverted' && (!r.startsOn || r.startsOn <= date) && (!r.endsOn || r.endsOn >= date));
/** Whether any exclusive grant of this right is out to someone else on the date (a second exclusive grant of it would clash). */
export const exclusiveGrantOut = (rows: Rights[], right: string, date: string): Rights | undefined => rightsInForce(rows, date).find((r) => r.kind === 'licensed-out' && r.exclusive && (r.right === right || r.right === 'all'));

// ---- revenue share: who is paid what share -----------------------------------------------------------------------------------

export const SHARE_BASES = ['net', 'gross', 'profit'] as const;
export interface RevenueShare { id: string; subject: Subject; personId: string; /** Basis points: 10000 is 100%. */ shareBp: number; basis: string; fromDate: string; toDate: string | null; advanceMinor: number; currency: string; notes: string; archivedAt: string | null }
interface ShareRow { id: string; sk: SubjectKind; sid: string; personId: string; shareBp: number; basis: string; fromDate: string; toDate: string | null; advanceMinor: number; currency: string; notes: string; archivedAt: string | null }
const SHARE_COLS = 'id, subject_kind AS sk, subject_id AS sid, person_id AS personId, share_bp AS shareBp, basis, from_date AS fromDate, to_date AS toDate, advance_minor AS advanceMinor, currency, notes, archived_at AS archivedAt';
const toShare = (r: ShareRow): RevenueShare => ({ id: r.id, subject: { kind: r.sk, id: r.sid }, personId: r.personId, shareBp: r.shareBp, basis: r.basis, fromDate: r.fromDate, toDate: r.toDate, advanceMinor: r.advanceMinor, currency: r.currency, notes: r.notes, archivedAt: r.archivedAt });

/** The total of live shares on one subject on a date, in basis points. */
export const shareTotalOn = (rows: Pick<RevenueShare, 'shareBp' | 'fromDate' | 'toDate' | 'archivedAt' | 'basis'>[], date: string, basis?: string): number =>
  rows.filter((r) => !r.archivedAt && r.fromDate <= date && (!r.toDate || r.toDate >= date) && (!basis || r.basis === basis)).reduce((a, r) => a + r.shareBp, 0);

/** The highest total, at any day of the period, that the live shares would reach with this one added (same basis only: shares of net and of profit are different pots). */
export function peakShare(others: RevenueShare[], add: { shareBp: number; fromDate: string; toDate: string | null; basis: string }): number {
  const days = [add.fromDate, ...others.map((o) => o.fromDate).filter((d) => d > add.fromDate && (!add.toDate || d <= add.toDate))];
  return Math.max(...days.map((d) => shareTotalOn(others, d, add.basis) + add.shareBp));
}

function cleanShare(i: { shareBp?: number; basis?: string; fromDate?: string; toDate?: string | null; advanceMinor?: number; currency?: string; notes?: string }, cur?: RevenueShare) {
  const shareBp = i.shareBp ?? cur?.shareBp;
  if (!Number.isInteger(shareBp) || shareBp! < 1 || shareBp! > 10000) fail('invalid', 'A share is a whole number of basis points from 1 to 10000 (10000 is 100%).');
  const fromDate = businessDate(i.fromDate ?? cur?.fromDate, 'A start date') ?? fail('invalid', 'A share needs a start date.');
  const toDate = i.toDate === undefined ? cur?.toDate ?? null : businessDate(i.toDate, 'An end date');
  period(fromDate, toDate, 'A share');
  const advanceMinor = i.advanceMinor ?? cur?.advanceMinor ?? 0;
  if (!Number.isInteger(advanceMinor) || advanceMinor < 0) fail('invalid', 'An advance is a whole number of cents, 0 or more.');
  const currency = (i.currency ?? cur?.currency ?? 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) fail('invalid', 'A currency is a three-letter code such as USD.');
  return { shareBp: shareBp!, basis: oneOf(SHARE_BASES, i.basis ?? cur?.basis ?? 'net', 'A basis'), fromDate, toDate, advanceMinor, currency, notes: i.notes === undefined ? cur?.notes ?? '' : text(i.notes, 'The notes', 1000) };
}

export async function addShare(db: Db, c: Ctx, i: { subject: Subject; personId: string; shareBp: number; basis?: string; fromDate: string; toDate?: string | null; advanceMinor?: number; currency?: string; notes?: string }): Promise<RevenueShare> {
  const subject = await checkSubject(db, c, i?.subject as Subject);
  const personId = await personExists(db, c, i?.personId);
  const v = cleanShare(i);
  const peak = peakShare(await listShares(db, c, { subject }), v);
  if (peak > 10000) fail('conflict', `The shares on this ${subject.kind} would add up to ${(peak / 100).toFixed(2)}%, which is more than 100%.`);
  const id = newRecordId();
  await db.batch([
    { sql: 'INSERT INTO revenue_share (id, studio_id, subject_kind, subject_id, person_id, share_bp, basis, from_date, to_date, advance_minor, currency, notes, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', params: [id, c.studioId, subject.kind, subject.id, personId, v.shareBp, v.basis, v.fromDate, v.toDate, v.advanceMinor, v.currency, v.notes, c.now, c.actor, c.now, c.actor] },
    audit(c, 'share.add', id, { subject, personId, shareBp: v.shareBp, fromDate: v.fromDate })
  ]);
  return (await getShare(db, c, id))!;
}
export async function getShare(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<RevenueShare | null> {
  const r = await db.first<ShareRow>(`SELECT ${SHARE_COLS} FROM revenue_share WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
  return r ? toShare(r) : null;
}
export async function updateShare(db: Db, c: Ctx, id: string, patch: { shareBp?: number; basis?: string; fromDate?: string; toDate?: string | null; advanceMinor?: number; currency?: string; notes?: string }): Promise<RevenueShare> {
  const cur = (await getShare(db, c, id)) ?? fail('not-found', 'That share is not there.');
  const v = cleanShare(patch, cur);
  const others = (await listShares(db, c, { subject: cur.subject })).filter((s) => s.id !== id);
  const peak = peakShare(others, v);
  if (peak > 10000) fail('conflict', `The shares on this ${cur.subject.kind} would add up to ${(peak / 100).toFixed(2)}%, which is more than 100%.`);
  await db.batch([{ sql: 'UPDATE revenue_share SET share_bp = ?, basis = ?, from_date = ?, to_date = ?, advance_minor = ?, currency = ?, notes = ?, updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ?', params: [v.shareBp, v.basis, v.fromDate, v.toDate, v.advanceMinor, v.currency, v.notes, c.now, c.actor, id, c.studioId] }, audit(c, 'share.update', id, patch)]);
  return (await getShare(db, c, id))!;
}
export async function listShares(db: Db, c: Pick<Ctx, 'studioId'>, f: { subject?: Subject; personId?: string; archived?: boolean } = {}): Promise<RevenueShare[]> {
  const where = ['studio_id = ?', f.archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL'];
  const params: unknown[] = [c.studioId];
  if (f.subject) (where.push('subject_kind = ? AND subject_id = ?'), params.push(f.subject.kind, f.subject.id));
  if (f.personId) (where.push('person_id = ?'), params.push(f.personId));
  return (await db.all<ShareRow>(`SELECT ${SHARE_COLS} FROM revenue_share WHERE ${where.join(' AND ')} ORDER BY subject_kind, subject_id, from_date, created_at`, params)).map(toShare);
}

// ---- archiving (all four) ----------------------------------------------------------------------------------------------------

const ARCHIVE_TABLE = { contribution: 'contribution', credit: 'credit', rights: 'rights', share: 'revenue_share' } as const;
/** Archives or restores a record. Nothing in the business records is ever deleted. Restoring a share is refused if it would take a subject over 100%. */
export async function setBusinessArchived(db: Db, c: Ctx, kind: keyof typeof ARCHIVE_TABLE, id: string, archived: boolean): Promise<void> {
  if (!Object.hasOwn(ARCHIVE_TABLE, kind)) fail('invalid', 'That is not a kind of business record.');
  const table = ARCHIVE_TABLE[kind];
  const exists = await db.first<{ archived_at: string | null }>(`SELECT archived_at FROM ${table} WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
  if (!exists) fail('not-found', 'That record is not there.');
  if (!archived && kind === 'share' && exists!.archived_at) {
    const s = (await getShare(db, c, id))!;
    const peak = peakShare(await listShares(db, c, { subject: s.subject }), s);
    if (peak > 10000) fail('conflict', 'Restoring this share would take the shares on that subject over 100%.');
  }
  await db.batch([{ sql: `UPDATE ${table} SET archived_at = ?, updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ?`, params: [archived ? c.now : null, c.now, c.actor, id, c.studioId] }, audit(c, `${kind}.${archived ? 'archive' : 'restore'}`, id, {})]);
}
