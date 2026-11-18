/**
 * Continuity checks (docs/M4-PLAN.md): one book's manuscript, at an exact version, read against the series' canon as it stood. The reading is done by
 * the person's own assistant; what is kept here is only what can be checked.
 *
 *   - A **check** is pinned to the version of the file and to the canon stamp, so a later edit never makes an old finding point at the wrong text.
 *     It is open while findings are raised, delivered when the finder is done, and closed by a person once nothing is left open.
 *   - A **finding** must quote a passage of the pinned version and cite at least one fact that is canon in this series, say how bad it is and how sure
 *     the finder is. That the quote is really in the text is for the caller that holds the text (as for editorial queries); that the facts are real is
 *     checked here.
 *   - A person decides each finding: dismiss it (with a reason, and it is not raised again against the same text), or accept the manuscript as right,
 *     which makes a canon proposal. A finding is fixed when a later version no longer has the passage.
 * Errors are `WorkError`s, so they cross the wire like the rest of the work records.
 */
import { locateAnchor, type TextAnchor } from './anchor';
import { checkChange, cleanAnchor, canonStamp, getProposal, type CanonProposal } from './canon';
import { newRecordId } from './ids';
import type { Ctx } from './catalogue';
import type { Db } from './vault';
import { WorkError } from './work';

export const CHECK_STATES = ['open', 'delivered', 'closed'] as const;
export type CheckState = (typeof CHECK_STATES)[number];
export const FINDING_KINDS = ['contradiction', 'timeline', 'name', 'rule', 'thread', 'other'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];
export const SEVERITIES = ['low', 'medium', 'high'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const CONFIDENCES = ['low', 'medium', 'high'] as const;
export type Confidence = (typeof CONFIDENCES)[number];
export const FINDING_STATES = ['open', 'fixed', 'accepted_as_canon', 'dismissed'] as const;
export type FindingState = (typeof FINDING_STATES)[number];

export const FINDING_BODY_MAX = 2000;
export const FINDING_BATCH_MAX = 100;
export const FINDING_CHECK_MAX = 1000;
const FACTS_PER_FINDING_MAX = 10;
const REASON_MAX = 1000;

export interface ContinuityCheck {
  id: string;
  projectId: string;
  seriesId: string;
  fileId: string;
  /** The file's path in the vault now (null if it is no longer there). */
  filePath: string | null;
  fileVersion: number;
  canonStamp: string;
  state: CheckState;
  runBy: string;
  createdAt: string;
  deliveredAt: string | null;
  closedAt: string | null;
  closedBy: string | null;
  updatedAt: string;
}
export interface ContinuityFinding {
  id: string;
  checkId: string;
  seq: number;
  kind: FindingKind;
  severity: Severity;
  confidence: Confidence;
  body: string;
  /** The passage, in the version the check covers. */
  anchor: TextAnchor;
  /** The canon facts it conflicts with. */
  factIds: string[];
  state: FindingState;
  response: string | null;
  proposalId: string | null;
  fixedInVersion: number | null;
  raisedBy: string;
  raisedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
}

const fail = (code: ConstructorParameters<typeof WorkError>[0], m: string): never => {
  throw new WorkError(code, m);
};
const audit = (c: Ctx, action: string, target: string, detail: unknown) => ({
  sql: 'INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)',
  params: [c.now, c.actor, action, target, JSON.stringify(detail)]
});
const text = (v: unknown, what: string, max: number, required: boolean): string => {
  const s = typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : '';
  if (required && !s) return fail('invalid', `${what} cannot be empty.`);
  return s.length > max ? fail('invalid', `${what} is too long (${max} characters at most).`) : s;
};

// ---- checks -------------------------------------------------------------------------------------------------------------------

const CCOLS =
  'id, project_id AS projectId, series_id AS seriesId, file_id AS fileId, (SELECT path FROM vault_file f WHERE f.id = file_id) AS filePath, file_version AS fileVersion, canon_stamp AS canonStamp, state, run_by AS runBy, created_at AS createdAt, delivered_at AS deliveredAt, closed_at AS closedAt, closed_by AS closedBy, updated_at AS updatedAt';

export async function getCheck(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<ContinuityCheck | null> {
  return db.first<ContinuityCheck>(`SELECT ${CCOLS} FROM continuity_check WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
}

export interface CheckFilter {
  projectId?: string;
  projectIds?: string[];
  seriesId?: string;
  fileId?: string;
  /** One state, 'live' (not closed), or 'any' (the default). */
  state?: CheckState | 'live' | 'any';
}
export async function listChecks(db: Db, c: Pick<Ctx, 'studioId'>, f: CheckFilter = {}): Promise<ContinuityCheck[]> {
  const where = ['studio_id = ?'];
  const params: unknown[] = [c.studioId];
  if (f.projectId) (where.push('project_id = ?'), params.push(f.projectId));
  if (f.projectIds) {
    if (!f.projectIds.length) return [];
    where.push(`project_id IN (${f.projectIds.map(() => '?').join(',')})`);
    params.push(...f.projectIds);
  }
  if (f.seriesId) (where.push('series_id = ?'), params.push(f.seriesId));
  if (f.fileId) (where.push('file_id = ?'), params.push(f.fileId));
  const state = f.state ?? 'any';
  if (state === 'live') where.push("state <> 'closed'");
  else if (state !== 'any') (where.push('state = ?'), params.push(state));
  return db.all<ContinuityCheck>(`SELECT ${CCOLS} FROM continuity_check WHERE ${where.join(' AND ')} ORDER BY created_at, rowid`, params);
}

export interface NewCheck {
  /** The book. */
  projectId: string;
  /** The series whose canon it is read against (the caller has checked it is the book's series). */
  seriesId: string;
  fileId: string;
  /** Defaults to the file's newest version. */
  fileVersion?: number;
}
/** Starts a check of a version of a manuscript against the series' canon as it is now. One check at a time is live for a file in a series. */
export async function startCheck(db: Db, c: Ctx, i: NewCheck): Promise<ContinuityCheck> {
  if (typeof i?.projectId !== 'string' || !i.projectId) fail('invalid', 'A book is needed.');
  if (typeof i.seriesId !== 'string' || !i.seriesId) fail('invalid', 'A series is needed.');
  if (typeof i.fileId !== 'string' || !i.fileId) fail('invalid', 'A manuscript file is needed.');
  const file = await db.first<{ current: number }>('SELECT current_version AS current FROM vault_file WHERE id = ? AND studio_id = ?', [i.fileId, c.studioId]);
  if (!file) return fail('not-found', 'That file is not there.');
  const fileVersion = i.fileVersion ?? file.current;
  if (!Number.isInteger(fileVersion) || fileVersion < 1 || fileVersion > file.current) return fail('not-found', 'That version of the file is not there.');
  const live = await db.first('SELECT 1 AS x FROM continuity_check WHERE studio_id = ? AND file_id = ? AND series_id = ? AND state <> ?', [c.studioId, i.fileId, i.seriesId, 'closed']);
  if (live) return fail('conflict', 'A continuity check of this manuscript is already under way. Finish or close it first.');
  const stamp = await canonStamp(db, c, i.seriesId);
  const id = newRecordId();
  await db.batch([
    {
      sql: `INSERT INTO continuity_check (id, studio_id, project_id, series_id, file_id, file_version, canon_stamp, state, run_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      params: [id, c.studioId, i.projectId, i.seriesId, i.fileId, fileVersion, stamp, c.actor, c.now, c.now]
    },
    audit(c, 'continuity.start', id, { projectId: i.projectId, seriesId: i.seriesId, fileId: i.fileId, fileVersion })
  ]);
  return (await getCheck(db, c, id))!;
}

/** The finder is done raising: the check goes to the people who decide. */
export async function deliverCheck(db: Db, c: Ctx, checkId: string): Promise<ContinuityCheck> {
  const k = await getCheck(db, c, checkId);
  if (!k) return fail('not-found', 'That check is not there.');
  if (k.state !== 'open') return fail('conflict', 'That check has already been delivered.');
  await db.batch([
    { sql: "UPDATE continuity_check SET state = 'delivered', delivered_at = ?, updated_at = ? WHERE id = ? AND studio_id = ? AND state = 'open'", params: [c.now, c.now, checkId, c.studioId] },
    audit(c, 'continuity.deliver', checkId, {})
  ]);
  return (await getCheck(db, c, checkId))!;
}

/** Closes a delivered check once no finding is left open. */
export async function closeCheck(db: Db, c: Ctx, checkId: string): Promise<ContinuityCheck> {
  const k = await getCheck(db, c, checkId);
  if (!k) return fail('not-found', 'That check is not there.');
  if (k.state === 'closed') return fail('conflict', 'That check is already closed.');
  if (k.state === 'open') return fail('conflict', 'That check has not been delivered yet.');
  const open = (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM continuity_finding WHERE check_id = ? AND state = 'open'", [checkId]))!.n;
  if (open > 0) return fail('blocked', `${open} finding${open === 1 ? ' is' : 's are'} still open. Fix, accept or dismiss ${open === 1 ? 'it' : 'each'} first.`);
  await db.batch([
    { sql: "UPDATE continuity_check SET state = 'closed', closed_at = ?, closed_by = ?, updated_at = ? WHERE id = ? AND studio_id = ? AND state = 'delivered'", params: [c.now, c.actor, c.now, checkId, c.studioId] },
    audit(c, 'continuity.close', checkId, {})
  ]);
  return (await getCheck(db, c, checkId))!;
}

// ---- findings -----------------------------------------------------------------------------------------------------------------

interface Row extends Omit<ContinuityFinding, 'anchor' | 'factIds'> {
  quote: string;
  prefix: string;
  suffix: string;
  start: number;
  factIds: string;
}
const FCOLS =
  'id, check_id AS checkId, seq, kind, severity, confidence, body, anchor_quote AS quote, anchor_prefix AS prefix, anchor_suffix AS suffix, anchor_start AS start, fact_ids AS factIds, state, response, proposal_id AS proposalId, fixed_in_version AS fixedInVersion, raised_by AS raisedBy, raised_at AS raisedAt, decided_by AS decidedBy, decided_at AS decidedAt';
const toFinding = ({ quote, prefix, suffix, start, factIds, ...r }: Row): ContinuityFinding => {
  let ids: string[] = [];
  try {
    const v = JSON.parse(factIds) as unknown;
    if (Array.isArray(v)) ids = v.filter((x): x is string => typeof x === 'string');
  } catch {
    /* unreadable: no facts cited */
  }
  return { ...r, anchor: { quote, prefix, suffix, start }, factIds: ids };
};

export async function getFinding(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<ContinuityFinding | null> {
  const r = await db.first<Row>(`SELECT ${FCOLS} FROM continuity_finding WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
  return r ? toFinding(r) : null;
}

export interface FindingFilter {
  checkId?: string;
  checkIds?: string[];
  /** One state, 'live' (open), or 'any' (the default). */
  state?: FindingState | 'live' | 'any';
}
export async function listFindings(db: Db, c: Pick<Ctx, 'studioId'>, f: FindingFilter = {}): Promise<ContinuityFinding[]> {
  const where = ['studio_id = ?'];
  const params: unknown[] = [c.studioId];
  if (f.checkId) (where.push('check_id = ?'), params.push(f.checkId));
  if (f.checkIds) {
    if (!f.checkIds.length) return [];
    where.push(`check_id IN (${f.checkIds.map(() => '?').join(',')})`);
    params.push(...f.checkIds);
  }
  const state = f.state ?? 'any';
  if (state === 'live') where.push("state = 'open'");
  else if (state !== 'any') (where.push('state = ?'), params.push(state));
  return (await db.all<Row>(`SELECT ${FCOLS} FROM continuity_finding WHERE ${where.join(' AND ')} ORDER BY check_id, seq`, params)).map(toFinding);
}

export type FindingCounts = Record<FindingState, number>;
/** How many findings of each state each check has (a check with none is absent from the answer). */
export async function findingCounts(db: Db, c: Pick<Ctx, 'studioId'>, checkIds: string[]): Promise<Record<string, FindingCounts>> {
  const out: Record<string, FindingCounts> = {};
  if (!checkIds.length) return out;
  const rows = await db.all<{ checkId: string; state: FindingState; n: number }>(
    `SELECT check_id AS checkId, state, COUNT(*) AS n FROM continuity_finding WHERE studio_id = ? AND check_id IN (${checkIds.map(() => '?').join(',')}) GROUP BY check_id, state`,
    [c.studioId, ...checkIds]
  );
  for (const r of rows) (out[r.checkId] ??= { open: 0, fixed: 0, accepted_as_canon: 0, dismissed: 0 })[r.state] = r.n;
  return out;
}

export interface NewFinding {
  kind: FindingKind;
  severity: Severity;
  confidence: Confidence;
  body: string;
  anchor: TextAnchor;
  factIds: string[];
}

const sameFacts = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/**
 * Raises findings in a check that is open, all or none. Each must quote a passage and cite facts that are canon in the check's series. A finding a
 * person already dismissed for this manuscript (the same passage and the same facts) is left out and reported, not raised again.
 */
export async function raiseFindings(db: Db, c: Ctx, checkId: string, items: NewFinding[]): Promise<{ raised: ContinuityFinding[]; skipped: { index: number; why: string }[] }> {
  const k = await getCheck(db, c, checkId);
  if (!k) return fail('not-found', 'That check is not there.');
  if (k.state !== 'open') return fail('conflict', 'Findings are raised while the check is open.');
  if (!Array.isArray(items) || !items.length) return fail('invalid', 'There is nothing to raise.');
  if (items.length > FINDING_BATCH_MAX) return fail('invalid', `At most ${FINDING_BATCH_MAX} can be raised at once.`);

  const checked = await Promise.all(
    items.map(async (i, n) => {
      const at = items.length > 1 ? ` (finding ${n + 1})` : '';
      if (!FINDING_KINDS.includes(i?.kind)) return fail('invalid', `A finding is a contradiction, timeline, name, rule, thread or other${at}.`);
      if (!SEVERITIES.includes(i.severity)) return fail('invalid', `Say how serious it is: low, medium or high${at}.`);
      if (!CONFIDENCES.includes(i.confidence)) return fail('invalid', `Say how sure you are: low, medium or high${at}.`);
      const body = text(i.body, `What the conflict is${at}`, FINDING_BODY_MAX, true);
      const anchor = cleanAnchor(i.anchor, `finding ${n + 1}`);
      const ids = Array.isArray(i.factIds) ? [...new Set(i.factIds.filter((x): x is string => typeof x === 'string' && !!x))] : [];
      if (!ids.length) return fail('invalid', `A finding names the canon fact it conflicts with${at}.`);
      if (ids.length > FACTS_PER_FINDING_MAX) return fail('invalid', `At most ${FACTS_PER_FINDING_MAX} facts per finding${at}.`);
      const found = await db.all<{ id: string }>(
        `SELECT id FROM canon_fact WHERE studio_id = ? AND project_id = ? AND status = 'canon' AND id IN (${ids.map(() => '?').join(',')})`,
        [c.studioId, k.seriesId, ...ids]
      );
      if (found.length !== ids.length) return fail('invalid', `A cited fact is not canon in this series${at}. Look the facts up first.`);
      return { kind: i.kind, severity: i.severity, confidence: i.confidence, body, anchor, ids, at: n };
    })
  );

  // what a person already dismissed for this manuscript is not raised again
  const dismissed = (
    await db.all<Row>(
      `SELECT ${FCOLS.split(', ').map((x) => 'f.' + x).join(', ')} FROM continuity_finding f JOIN continuity_check k ON k.id = f.check_id WHERE f.studio_id = ? AND k.file_id = ? AND k.series_id = ? AND f.state = 'dismissed'`,
      [c.studioId, k.fileId, k.seriesId]
    )
  ).map(toFinding);
  const skipped: { index: number; why: string }[] = [];
  const fresh = checked.filter((i) => {
    const again = dismissed.some((d) => d.anchor.quote === i.anchor.quote && sameFacts(d.factIds, i.ids));
    if (again) skipped.push({ index: i.at, why: 'A person dismissed this finding for this manuscript.' });
    return !again;
  });

  const have = (await db.first<{ n: number; top: number | null }>('SELECT COUNT(*) AS n, MAX(seq) AS top FROM continuity_finding WHERE check_id = ?', [checkId]))!;
  if (have.n + fresh.length > FINDING_CHECK_MAX) return fail('invalid', `A check holds at most ${FINDING_CHECK_MAX} findings.`);
  const ids: string[] = [];
  const stmts = fresh.map((i, n) => {
    const id = newRecordId();
    ids.push(id);
    return {
      sql: `INSERT INTO continuity_finding (id, studio_id, check_id, seq, kind, severity, confidence, body, anchor_quote, anchor_prefix, anchor_suffix, anchor_start, fact_ids, state, raised_by, raised_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      params: [id, c.studioId, checkId, (have.top ?? 0) + n + 1, i.kind, i.severity, i.confidence, i.body, i.anchor.quote, i.anchor.prefix, i.anchor.suffix, i.anchor.start, JSON.stringify(i.ids), c.actor, c.now]
    };
  });
  if (stmts.length) await db.batch([...stmts, audit(c, 'continuity.raise', checkId, { count: stmts.length })]);
  return { raised: await listFindings(db, c, { checkId, state: 'any' }).then((all) => all.filter((f) => ids.includes(f.id))), skipped };
}

export type FindingDecision =
  | { outcome: 'dismiss'; reason: string }
  /** The manuscript is right: make a canon proposal from this passage (a change in the form `proposeChange` takes), which the series' approvers decide. */
  | { outcome: 'accept_as_canon'; change: unknown; note?: string };

/** A person decides an open finding of a delivered check. */
export async function decideFinding(db: Db, c: Ctx, findingId: string, d: FindingDecision): Promise<{ finding: ContinuityFinding; proposal: CanonProposal | null }> {
  const f = await getFinding(db, c, findingId);
  if (!f) return fail('not-found', 'That finding is not there.');
  const k = (await getCheck(db, c, f.checkId))!;
  if (k.state !== 'delivered') return fail('conflict', k.state === 'open' ? 'The check has not been delivered yet.' : 'That check is closed.');
  if (f.state !== 'open') return fail('conflict', `That finding has already been decided (${f.state.replace(/_/g, ' ')}).`);
  if (d?.outcome === 'dismiss') {
    const reason = text(d.reason, 'The reason', REASON_MAX, true);
    await db.batch([
      { sql: "UPDATE continuity_finding SET state = 'dismissed', response = ?, decided_by = ?, decided_at = ? WHERE id = ? AND studio_id = ? AND state = 'open'", params: [reason, c.actor, c.now, findingId, c.studioId] },
      audit(c, 'continuity.dismiss', findingId, { checkId: f.checkId })
    ]);
  } else if (d?.outcome === 'accept_as_canon') {
    const change = await checkChange(db, c, k.seriesId, d.change);
    const proposalId = newRecordId();
    const note = text(d.note ?? '', 'The note', REASON_MAX, false);
    await db.batch([
      {
        sql: "INSERT INTO canon_proposal (id, studio_id, project_id, change, payload, state, finding_id, proposed_by, proposed_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)",
        params: [proposalId, c.studioId, k.seriesId, change.change, JSON.stringify(change), findingId, c.actor, c.now]
      },
      { sql: "UPDATE continuity_finding SET state = 'accepted_as_canon', response = ?, proposal_id = ?, decided_by = ?, decided_at = ? WHERE id = ? AND studio_id = ? AND state = 'open'", params: [note || null, proposalId, c.actor, c.now, findingId, c.studioId] },
      audit(c, 'continuity.accept', findingId, { checkId: f.checkId, proposalId })
    ]);
  } else {
    return fail('invalid', 'A finding is dismissed, or accepted as canon.');
  }
  const done = (await getFinding(db, c, findingId))!;
  return { finding: done, proposal: done.proposalId ? await getProposal(db, c, done.proposalId) : null };
}

/**
 * Checks a later version of the manuscript against the open findings of a check: a finding whose passage can no longer be found there is fixed. The
 * caller supplies the text of that version (the records hold none). Returns what was fixed and what is still there.
 */
export async function verifyFindings(db: Db, c: Ctx, checkId: string, v: { version: number; text: string }): Promise<{ fixed: ContinuityFinding[]; remaining: ContinuityFinding[] }> {
  const k = await getCheck(db, c, checkId);
  if (!k) return fail('not-found', 'That check is not there.');
  if (k.state === 'closed') return fail('conflict', 'That check is closed.');
  const file = await db.first<{ current: number }>('SELECT current_version AS current FROM vault_file WHERE id = ? AND studio_id = ?', [k.fileId, c.studioId]);
  if (!file) return fail('not-found', 'That file is not there.');
  if (!Number.isInteger(v?.version) || v.version <= k.fileVersion || v.version > file.current) return fail('invalid', 'Give a later version of the same file.');
  if (typeof v.text !== 'string') return fail('invalid', 'The text of that version is needed.');
  const open = await listFindings(db, c, { checkId, state: 'live' });
  const gone = open.filter((f) => !locateAnchor(v.text, f.anchor));
  if (gone.length) {
    await db.batch([
      ...gone.map((f) => ({
        sql: "UPDATE continuity_finding SET state = 'fixed', fixed_in_version = ?, decided_by = ?, decided_at = ? WHERE id = ? AND studio_id = ? AND state = 'open'",
        params: [v.version, c.actor, c.now, f.id, c.studioId]
      })),
      audit(c, 'continuity.verify', checkId, { version: v.version, fixed: gone.length })
    ]);
  }
  const goneIds = new Set(gone.map((f) => f.id));
  const all = await listFindings(db, c, { checkId });
  return { fixed: all.filter((f) => goneIds.has(f.id)), remaining: all.filter((f) => f.state === 'open') };
}
