/**
 * Canon: the series' agreed facts, kept as records the studio governs (docs/M4-PLAN.md). Records and rules over the kernel's async `Db`: nothing
 * here decides who may do what (the service checks first); it decides what is valid and when.
 *
 *   - An **entry** is something the series has (a character, a place, a rule, an event, a term) with a summary that is revised by new numbered
 *     versions, never overwritten. Names are unique within a series and kind.
 *   - A **fact** is one agreed statement about an entry. It points back to the passage that established it (a quote in an exact version of a file) and to
 *     where in the series that was. A fact is never edited: a change supersedes it, and the old one stays, retired.
 *   - Nothing becomes canon except through a **proposal** that is approved. Approving applies the change in one batch with its audit row.
 * Errors are `WorkError`s, so they cross the wire like the rest of the work records.
 */
import { ANCHOR_CONTEXT, ANCHOR_QUOTE_MAX, type TextAnchor } from './anchor';
import { newRecordId } from './ids';
import type { Ctx } from './catalogue';
import type { Db } from './vault';
import { WorkError } from './work';

export const CANON_KINDS = ['character', 'place', 'rule', 'event', 'term'] as const;
export type CanonKind = (typeof CANON_KINDS)[number];
export const CANON_CHANGES = ['add_entry', 'edit_entry', 'retire_entry', 'add_fact', 'supersede_fact', 'retire_fact'] as const;
export type CanonChangeKind = (typeof CANON_CHANGES)[number];

export const CANON_NAME_MAX = 120;
export const CANON_SUMMARY_MAX = 8000;
export const CANON_FACT_MAX = 2000;
export const CANON_REASON_MAX = 1000;
const MAX_ALIASES = 20;

/** Where a fact was established: a passage in an exact version of a file. */
export interface FactSource {
  fileId: string;
  version: number;
  anchor: TextAnchor;
}

export type CanonChange =
  | { change: 'add_entry'; kind: CanonKind; name: string; aliases?: string[]; summary: string }
  | { change: 'edit_entry'; entryId: string; name?: string; aliases?: string[]; summary?: string; basedOn: number }
  | { change: 'retire_entry'; entryId: string; reason: string }
  | { change: 'add_fact'; entryId: string; text: string; source?: FactSource | null; bookProjectId?: string | null; chapter?: number | null }
  | { change: 'supersede_fact'; factId: string; text: string; source?: FactSource | null; bookProjectId?: string | null; chapter?: number | null }
  | { change: 'retire_fact'; factId: string; reason: string };

export interface CanonEntry {
  id: string;
  projectId: string;
  kind: CanonKind;
  name: string;
  aliases: string[];
  state: 'active' | 'retired';
  summary: string;
  /** The number of the newest version of the summary. */
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}
export interface CanonEntryVersion {
  n: number;
  summary: string;
  writtenAt: string;
  writtenBy: string;
}
export interface CanonFact {
  id: string;
  projectId: string;
  entryId: string;
  text: string;
  status: 'canon' | 'retired';
  source: FactSource | null;
  bookProjectId: string | null;
  chapter: number | null;
  supersedesId: string | null;
  proposalId: string | null;
  createdAt: string;
  createdBy: string;
  retiredAt: string | null;
  retiredBy: string | null;
  retiredReason: string | null;
}
export interface CanonProposal {
  id: string;
  projectId: string;
  change: CanonChangeKind;
  payload: CanonChange;
  state: 'open' | 'approved' | 'rejected' | 'withdrawn';
  reason: string | null;
  findingId: string | null;
  proposedBy: string;
  proposedAt: string;
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
const clean = (v: unknown, what: string, max: number, required: boolean): string => {
  const s = typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : '';
  if (required && !s) return fail('invalid', `${what} cannot be empty.`);
  return s.length > max ? fail('invalid', `${what} is too long (${max} characters at most).`) : s;
};
const isUnique = (e: unknown) => /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|SQLITE_CONSTRAINT_PRIMARYKEY/i.test(String((e as Error)?.message ?? e));

/** A quoted passage, checked for shape (that it is really in the text is for the caller that holds the text). */
export function cleanAnchor(a: unknown, what: string): TextAnchor {
  const x = a as Partial<TextAnchor> | null;
  if (!x || typeof x.quote !== 'string' || !x.quote.trim()) return fail('invalid', `The quoted passage cannot be empty${what ? ` (${what})` : ''}.`);
  if (x.quote.length > ANCHOR_QUOTE_MAX) return fail('invalid', `The quoted passage is too long (${ANCHOR_QUOTE_MAX} characters at most).`);
  if (!Number.isInteger(x.start) || (x.start as number) < 0) return fail('invalid', 'Where the passage starts is a whole number from 0.');
  return {
    quote: x.quote,
    prefix: typeof x.prefix === 'string' ? x.prefix.slice(-ANCHOR_CONTEXT * 5) : '',
    suffix: typeof x.suffix === 'string' ? x.suffix.slice(0, ANCHOR_CONTEXT * 5) : '',
    start: x.start as number
  };
}

const cleanAliases = (v: unknown): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return fail('invalid', 'Aliases are a list of names.');
  const out: string[] = [];
  for (const a of v) {
    const s = clean(a, 'An alias', CANON_NAME_MAX, true);
    if (!out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  if (out.length > MAX_ALIASES) fail('invalid', `At most ${MAX_ALIASES} aliases.`);
  return out;
};

// ---- reading ------------------------------------------------------------------------------------------------------------------

interface EntryRow extends Omit<CanonEntry, 'aliases' | 'summary' | 'version'> {
  aliases: string;
}
const ECOLS = 'id, project_id AS projectId, kind, name, aliases, state, created_at AS createdAt, created_by AS createdBy, updated_at AS updatedAt';
const parseAliases = (s: string): string[] => {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
async function withSummary(db: Db, row: EntryRow): Promise<CanonEntry> {
  const v = await db.first<{ n: number; summary: string }>('SELECT n, summary FROM canon_entry_version WHERE entry_id = ? ORDER BY n DESC LIMIT 1', [row.id]);
  return { ...row, aliases: parseAliases(row.aliases), summary: v?.summary ?? '', version: v?.n ?? 0 };
}

export async function getEntry(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<CanonEntry | null> {
  const r = await db.first<EntryRow>(`SELECT ${ECOLS} FROM canon_entry WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
  return r ? withSummary(db, r) : null;
}

export interface EntryFilter {
  projectId?: string;
  projectIds?: string[];
  kind?: CanonKind;
  /** 'active' (the default), 'retired' or 'any'. */
  state?: 'active' | 'retired' | 'any';
  /** Matches a name or an alias, case-insensitively, by part. */
  search?: string;
}
export async function listEntries(db: Db, c: Pick<Ctx, 'studioId'>, f: EntryFilter = {}): Promise<CanonEntry[]> {
  const where = ['studio_id = ?'];
  const params: unknown[] = [c.studioId];
  if (f.projectId) (where.push('project_id = ?'), params.push(f.projectId));
  if (f.projectIds) {
    if (!f.projectIds.length) return [];
    where.push(`project_id IN (${f.projectIds.map(() => '?').join(',')})`);
    params.push(...f.projectIds);
  }
  if (f.kind) (where.push('kind = ?'), params.push(f.kind));
  const state = f.state ?? 'active';
  if (state !== 'any') (where.push('state = ?'), params.push(state));
  const rows = await db.all<EntryRow>(`SELECT ${ECOLS} FROM canon_entry WHERE ${where.join(' AND ')} ORDER BY kind, lower(name)`, params);
  const q = f.search?.trim().toLowerCase();
  const shown = q ? rows.filter((r) => r.name.toLowerCase().includes(q) || parseAliases(r.aliases).some((a) => a.toLowerCase().includes(q))) : rows;
  return Promise.all(shown.map((r) => withSummary(db, r)));
}

export async function entryVersions(db: Db, c: Pick<Ctx, 'studioId'>, entryId: string): Promise<CanonEntryVersion[]> {
  if (!(await getEntry(db, c, entryId))) return fail('not-found', 'That entry is not there.');
  return db.all<CanonEntryVersion>('SELECT n, summary, written_at AS writtenAt, written_by AS writtenBy FROM canon_entry_version WHERE entry_id = ? ORDER BY n', [entryId]);
}

interface FactRow extends Omit<CanonFact, 'source'> {
  sFile: string | null;
  sVersion: number | null;
  sQuote: string | null;
  sPrefix: string;
  sSuffix: string;
  sStart: number | null;
}
const FCOLS =
  'id, project_id AS projectId, entry_id AS entryId, text, status, source_file_id AS sFile, source_version AS sVersion, source_quote AS sQuote, source_prefix AS sPrefix, source_suffix AS sSuffix, source_start AS sStart, book_project_id AS bookProjectId, chapter, supersedes_id AS supersedesId, proposal_id AS proposalId, created_at AS createdAt, created_by AS createdBy, retired_at AS retiredAt, retired_by AS retiredBy, retired_reason AS retiredReason';
const toFact = ({ sFile, sVersion, sQuote, sPrefix, sSuffix, sStart, ...r }: FactRow): CanonFact => ({
  ...r,
  source: sFile && sVersion !== null && sQuote !== null && sStart !== null ? { fileId: sFile, version: sVersion, anchor: { quote: sQuote, prefix: sPrefix, suffix: sSuffix, start: sStart } } : null
});

export async function getFact(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<CanonFact | null> {
  const r = await db.first<FactRow>(`SELECT ${FCOLS} FROM canon_fact WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
  return r ? toFact(r) : null;
}

export interface FactFilter {
  projectId?: string;
  entryId?: string;
  ids?: string[];
  /** 'canon' (the default), 'retired' or 'any'. */
  status?: 'canon' | 'retired' | 'any';
}
export async function listFacts(db: Db, c: Pick<Ctx, 'studioId'>, f: FactFilter = {}): Promise<CanonFact[]> {
  const where = ['studio_id = ?'];
  const params: unknown[] = [c.studioId];
  if (f.projectId) (where.push('project_id = ?'), params.push(f.projectId));
  if (f.entryId) (where.push('entry_id = ?'), params.push(f.entryId));
  if (f.ids) {
    if (!f.ids.length) return [];
    where.push(`id IN (${f.ids.map(() => '?').join(',')})`);
    params.push(...f.ids);
  }
  const status = f.status ?? 'canon';
  if (status !== 'any') (where.push('status = ?'), params.push(status));
  return (await db.all<FactRow>(`SELECT ${FCOLS} FROM canon_fact WHERE ${where.join(' AND ')} ORDER BY entry_id, created_at, rowid`, params)).map(toFact);
}

/** The time of the last change to a series' canon, or '' if it has none. A check is pinned to this, so it says which canon it was made against. */
export async function canonStamp(db: Db, c: Pick<Ctx, 'studioId'>, projectId: string): Promise<string> {
  const r = await db.first<{ at: string | null }>(
    `SELECT MAX(at) AS at FROM (
       SELECT MAX(created_at) AS at FROM canon_fact WHERE studio_id = ?1 AND project_id = ?2
       UNION ALL SELECT MAX(retired_at) FROM canon_fact WHERE studio_id = ?1 AND project_id = ?2
       UNION ALL SELECT MAX(updated_at) FROM canon_entry WHERE studio_id = ?1 AND project_id = ?2)`,
    [c.studioId, projectId]
  );
  return r?.at ?? '';
}

// ---- proposals ----------------------------------------------------------------------------------------------------------------

interface ProposalRow extends Omit<CanonProposal, 'payload' | 'change'> {
  change: CanonChangeKind;
  payload: string;
}
const PCOLS = 'id, project_id AS projectId, change, payload, state, reason, finding_id AS findingId, proposed_by AS proposedBy, proposed_at AS proposedAt, decided_by AS decidedBy, decided_at AS decidedAt';
const toProposal = (r: ProposalRow): CanonProposal => ({ ...r, payload: JSON.parse(r.payload) as CanonChange });

export async function getProposal(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<CanonProposal | null> {
  const r = await db.first<ProposalRow>(`SELECT ${PCOLS} FROM canon_proposal WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
  return r ? toProposal(r) : null;
}
export interface ProposalFilter {
  projectId?: string;
  projectIds?: string[];
  /** One state, or 'any' (the default). */
  state?: CanonProposal['state'] | 'any';
  proposedBy?: string;
}
export async function listProposals(db: Db, c: Pick<Ctx, 'studioId'>, f: ProposalFilter = {}): Promise<CanonProposal[]> {
  const where = ['studio_id = ?'];
  const params: unknown[] = [c.studioId];
  if (f.projectId) (where.push('project_id = ?'), params.push(f.projectId));
  if (f.projectIds) {
    if (!f.projectIds.length) return [];
    where.push(`project_id IN (${f.projectIds.map(() => '?').join(',')})`);
    params.push(...f.projectIds);
  }
  if (f.state && f.state !== 'any') (where.push('state = ?'), params.push(f.state));
  if (f.proposedBy) (where.push('proposed_by = ?'), params.push(f.proposedBy));
  return (await db.all<ProposalRow>(`SELECT ${PCOLS} FROM canon_proposal WHERE ${where.join(' AND ')} ORDER BY proposed_at, rowid`, params)).map(toProposal);
}

async function cleanSource(db: Db, c: Pick<Ctx, 'studioId'>, s: FactSource | null | undefined): Promise<FactSource | null> {
  if (!s) return null;
  if (typeof s.fileId !== 'string' || !s.fileId) return fail('invalid', 'A source needs its file.');
  const file = await db.first<{ current: number }>('SELECT current_version AS current FROM vault_file WHERE id = ? AND studio_id = ?', [s.fileId, c.studioId]);
  if (!file) return fail('not-found', 'The file a source names is not there.');
  if (!Number.isInteger(s.version) || s.version < 1 || s.version > file.current) return fail('not-found', 'That version of the file is not there.');
  return { fileId: s.fileId, version: s.version, anchor: cleanAnchor(s.anchor, 'the source') };
}
const cleanWhere = (bookProjectId: unknown, chapter: unknown) => {
  if (bookProjectId !== undefined && bookProjectId !== null && (typeof bookProjectId !== 'string' || !bookProjectId)) fail('invalid', 'The book a fact was established in is a project.');
  if (chapter !== undefined && chapter !== null && (!Number.isInteger(chapter) || (chapter as number) < 1)) fail('invalid', 'A chapter is a whole number from 1.');
  return { bookProjectId: (bookProjectId as string | null | undefined) ?? null, chapter: (chapter as number | null | undefined) ?? null };
};

/** Checks a requested change against the series' canon as it is now, and returns it cleaned. Used when it is proposed and again when it is approved. */
export async function checkChange(db: Db, c: Pick<Ctx, 'studioId'>, projectId: string, raw: unknown): Promise<CanonChange> {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || !CANON_CHANGES.includes(r.change as CanonChangeKind)) return fail('invalid', 'Say what to change in canon.');
  const entryOf = async (id: unknown): Promise<CanonEntry> => {
    const e = typeof id === 'string' ? await getEntry(db, c, id) : null;
    if (!e) return fail('not-found', 'That entry is not there.');
    if (e.projectId !== projectId) return fail('invalid', 'That entry belongs to another series.');
    return e;
  };
  const factOf = async (id: unknown): Promise<CanonFact> => {
    const f = typeof id === 'string' ? await getFact(db, c, id) : null;
    if (!f) return fail('not-found', 'That fact is not there.');
    if (f.projectId !== projectId) return fail('invalid', 'That fact belongs to another series.');
    if (f.status !== 'canon') return fail('conflict', 'That fact is no longer canon.');
    return f;
  };
  switch (r.change) {
    case 'add_entry': {
      if (!CANON_KINDS.includes(r.kind as CanonKind)) return fail('invalid', 'An entry is a character, place, rule, event or term.');
      const name = clean(r.name, 'The name', CANON_NAME_MAX, true);
      const taken = await db.first('SELECT 1 AS x FROM canon_entry WHERE studio_id = ? AND project_id = ? AND kind = ? AND lower(name) = lower(?) AND state = ?', [c.studioId, projectId, r.kind, name, 'active']);
      if (taken) return fail('exists', `The series already has a ${r.kind} called ${name}.`);
      return { change: 'add_entry', kind: r.kind as CanonKind, name, aliases: cleanAliases(r.aliases), summary: clean(r.summary, 'The summary', CANON_SUMMARY_MAX, true) };
    }
    case 'edit_entry': {
      const e = await entryOf(r.entryId);
      if (e.state !== 'active') return fail('conflict', 'That entry has been retired.');
      if (r.basedOn !== e.version) return fail('conflict', 'The entry has been revised since you read it. Open the newest version and try again.');
      const name = r.name === undefined ? undefined : clean(r.name, 'The name', CANON_NAME_MAX, true);
      if (name && name.toLowerCase() !== e.name.toLowerCase()) {
        const taken = await db.first('SELECT 1 AS x FROM canon_entry WHERE studio_id = ? AND project_id = ? AND kind = ? AND lower(name) = lower(?) AND state = ? AND id <> ?', [c.studioId, projectId, e.kind, name, 'active', e.id]);
        if (taken) return fail('exists', `The series already has a ${e.kind} called ${name}.`);
      }
      const summary = r.summary === undefined ? undefined : clean(r.summary, 'The summary', CANON_SUMMARY_MAX, true);
      const aliases = r.aliases === undefined ? undefined : cleanAliases(r.aliases);
      if (name === undefined && summary === undefined && aliases === undefined) return fail('invalid', 'Nothing is being changed.');
      return { change: 'edit_entry', entryId: e.id, ...(name !== undefined ? { name } : {}), ...(aliases !== undefined ? { aliases } : {}), ...(summary !== undefined ? { summary } : {}), basedOn: e.version };
    }
    case 'retire_entry': {
      const e = await entryOf(r.entryId);
      if (e.state !== 'active') return fail('conflict', 'That entry has already been retired.');
      return { change: 'retire_entry', entryId: e.id, reason: clean(r.reason, 'The reason', CANON_REASON_MAX, true) };
    }
    case 'add_fact': {
      const e = await entryOf(r.entryId);
      if (e.state !== 'active') return fail('conflict', 'That entry has been retired.');
      return { change: 'add_fact', entryId: e.id, text: clean(r.text, 'The fact', CANON_FACT_MAX, true), source: await cleanSource(db, c, r.source as FactSource | null), ...cleanWhere(r.bookProjectId, r.chapter) };
    }
    case 'supersede_fact': {
      const f = await factOf(r.factId);
      const text = clean(r.text, 'The new fact', CANON_FACT_MAX, true);
      if (text === f.text) return fail('invalid', 'The new fact says the same thing.');
      return { change: 'supersede_fact', factId: f.id, text, source: await cleanSource(db, c, r.source as FactSource | null), ...cleanWhere(r.bookProjectId, r.chapter) };
    }
    default: {
      const f = await factOf(r.factId);
      return { change: 'retire_fact', factId: f.id, reason: clean(r.reason, 'The reason', CANON_REASON_MAX, true) };
    }
  }
}

/** Asks for a change to canon. Nothing changes until it is approved. */
export async function proposeChange(db: Db, c: Ctx, projectId: string, raw: unknown, o: { findingId?: string } = {}): Promise<CanonProposal> {
  if (typeof projectId !== 'string' || !projectId) fail('invalid', 'A series is needed.');
  const payload = await checkChange(db, c, projectId, raw);
  const id = newRecordId();
  await db.batch([
    {
      sql: "INSERT INTO canon_proposal (id, studio_id, project_id, change, payload, state, finding_id, proposed_by, proposed_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)",
      params: [id, c.studioId, projectId, payload.change, JSON.stringify(payload), o.findingId ?? null, c.actor, c.now]
    },
    audit(c, 'canon.propose', id, { projectId, change: payload.change })
  ]);
  return (await getProposal(db, c, id))!;
}

/** The statements that make an approved change true. The change has just been checked against the canon as it now stands. */
function apply(c: Ctx, projectId: string, proposalId: string, p: CanonChange, entry: CanonEntry | null, fact: CanonFact | null): { sql: string; params: unknown[] }[] {
  const factRow = (id: string, entryId: string, text: string, source: FactSource | null | undefined, bookProjectId: string | null | undefined, chapter: number | null | undefined, supersedes: string | null) => ({
    sql: `INSERT INTO canon_fact (id, studio_id, project_id, entry_id, text, status, source_file_id, source_version, source_quote, source_prefix, source_suffix, source_start, book_project_id, chapter, supersedes_id, proposal_id, created_at, created_by)
          VALUES (?, ?, ?, ?, ?, 'canon', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [id, c.studioId, projectId, entryId, text, source?.fileId ?? null, source?.version ?? null, source?.anchor.quote ?? null, source?.anchor.prefix ?? '', source?.anchor.suffix ?? '', source?.anchor.start ?? null, bookProjectId ?? null, chapter ?? null, supersedes, proposalId, c.now, c.actor]
  });
  const retire = (id: string, reason: string) => ({ sql: "UPDATE canon_fact SET status = 'retired', retired_at = ?, retired_by = ?, retired_reason = ? WHERE id = ? AND studio_id = ?", params: [c.now, c.actor, reason, id, c.studioId] });
  switch (p.change) {
    case 'add_entry': {
      const id = newRecordId();
      return [
        { sql: "INSERT INTO canon_entry (id, studio_id, project_id, kind, name, aliases, state, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)", params: [id, c.studioId, projectId, p.kind, p.name, JSON.stringify(p.aliases ?? []), c.now, c.actor, c.now] },
        { sql: 'INSERT INTO canon_entry_version (entry_id, n, summary, written_at, written_by) VALUES (?, 1, ?, ?, ?)', params: [id, p.summary, c.now, c.actor] }
      ];
    }
    case 'edit_entry': {
      const e = entry!;
      const out: { sql: string; params: unknown[] }[] = [
        { sql: 'UPDATE canon_entry SET name = ?, aliases = ?, updated_at = ? WHERE id = ? AND studio_id = ?', params: [p.name ?? e.name, JSON.stringify(p.aliases ?? e.aliases), c.now, e.id, c.studioId] }
      ];
      if (p.summary !== undefined && p.summary !== e.summary) out.push({ sql: 'INSERT INTO canon_entry_version (entry_id, n, summary, written_at, written_by) VALUES (?, ?, ?, ?, ?)', params: [e.id, e.version + 1, p.summary, c.now, c.actor] });
      return out;
    }
    case 'retire_entry':
      return [
        { sql: "UPDATE canon_entry SET state = 'retired', updated_at = ? WHERE id = ? AND studio_id = ?", params: [c.now, p.entryId, c.studioId] },
        { sql: "UPDATE canon_fact SET status = 'retired', retired_at = ?, retired_by = ?, retired_reason = ? WHERE entry_id = ? AND studio_id = ? AND status = 'canon'", params: [c.now, c.actor, `The entry was retired: ${p.reason}`, p.entryId, c.studioId] }
      ];
    case 'add_fact':
      return [factRow(newRecordId(), p.entryId, p.text, p.source, p.bookProjectId, p.chapter, null)];
    case 'supersede_fact': {
      const old = fact!;
      return [retire(old.id, 'Superseded by a newer fact.'), factRow(newRecordId(), old.entryId, p.text, p.source, p.bookProjectId, p.chapter, old.id)];
    }
    case 'retire_fact':
      return [retire(p.factId, p.reason)];
  }
}

/**
 * Approves or rejects an open proposal. Approving applies the change in one batch with its audit row; a change that no longer fits the canon (the
 * entry was revised, the fact was retired) is refused with a `conflict` and the proposal stays open to be withdrawn. Rejecting needs a reason.
 */
export async function decideProposal(db: Db, c: Ctx, proposalId: string, d: { approve: boolean; reason?: string }): Promise<CanonProposal> {
  const p = await getProposal(db, c, proposalId);
  if (!p) return fail('not-found', 'That proposal is not there.');
  if (p.state !== 'open') return fail('conflict', `That proposal has already been ${p.state}.`);
  if (!d.approve) {
    const reason = clean(d.reason, 'The reason', CANON_REASON_MAX, true);
    await db.batch([
      { sql: "UPDATE canon_proposal SET state = 'rejected', reason = ?, decided_by = ?, decided_at = ? WHERE id = ? AND studio_id = ? AND state = 'open'", params: [reason, c.actor, c.now, proposalId, c.studioId] },
      audit(c, 'canon.reject', proposalId, { change: p.change })
    ]);
    return (await getProposal(db, c, proposalId))!;
  }
  const now = await checkChange(db, c, p.projectId, p.payload);
  const entry = 'entryId' in now ? await getEntry(db, c, now.entryId) : null;
  const fact = 'factId' in now ? await getFact(db, c, now.factId) : null;
  try {
    await db.batch([
      ...apply(c, p.projectId, proposalId, now, entry, fact),
      { sql: "UPDATE canon_proposal SET state = 'approved', decided_by = ?, decided_at = ? WHERE id = ? AND studio_id = ? AND state = 'open'", params: [c.actor, c.now, proposalId, c.studioId] },
      audit(c, 'canon.approve', proposalId, { projectId: p.projectId, change: p.change })
    ]);
  } catch (e) {
    if (isUnique(e)) return fail('exists', 'The series already has an entry with that name.');
    throw e;
  }
  return (await getProposal(db, c, proposalId))!;
}

/** The person who made a proposal (or someone who may approve) takes it back. */
export async function withdrawProposal(db: Db, c: Ctx, proposalId: string): Promise<CanonProposal> {
  const p = await getProposal(db, c, proposalId);
  if (!p) return fail('not-found', 'That proposal is not there.');
  if (p.state !== 'open') return fail('conflict', `That proposal has already been ${p.state}.`);
  await db.batch([
    { sql: "UPDATE canon_proposal SET state = 'withdrawn', decided_by = ?, decided_at = ? WHERE id = ? AND studio_id = ? AND state = 'open'", params: [c.actor, c.now, proposalId, c.studioId] },
    audit(c, 'canon.withdraw', proposalId, { change: p.change })
  ]);
  return (await getProposal(db, c, proposalId))!;
}
