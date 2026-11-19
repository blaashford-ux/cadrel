/**
 * Preflight runs and their results (docs/M5-PLAN.md). A run is pinned to the exact file, cover and catalogue metadata it looked at, and to the
 * rule pack and its version; each result says what was measured and what the rule expects. The rules themselves are in `preflightRules.ts`: pure
 * functions over facts the computer holding the file extracts. Here are only the records, and the one rule about waivers: a waiver needs a reason
 * and shows on later runs of the same rule against the same file.
 */
import { newRecordId } from './ids';
import type { Ctx } from './catalogue';
import type { Db } from './vault';
import { WorkError } from './work';

export const GRADES = ['error', 'warning', 'suggestion'] as const;
export type Grade = (typeof GRADES)[number];

const fail = (code: ConstructorParameters<typeof WorkError>[0], m: string): never => {
  throw new WorkError(code, m);
};
const audit = (c: Ctx, action: string, target: string, detail: unknown) => ({
  sql: 'INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)',
  params: [c.now, c.actor, action, target, JSON.stringify(detail)]
});

/** What a rule found. `location` says where (a file inside the EPUB, a field), `measured` and `expected` are shown as they are. */
export interface Finding {
  ruleId: string;
  grade: Grade;
  what: string;
  location?: string;
  measured?: string;
  expected?: string;
}
export interface PreflightResult extends Required<Finding> {
  seq: number;
  state: 'open' | 'waived';
  waivedBy: string | null;
  waivedReason: string | null;
  waivedAt: string | null;
  /** Waived on an earlier run of the same file and carried onto this one. */
  carried: boolean;
}
export interface PreflightRun {
  id: string;
  projectId: string;
  editionId: string | null;
  fileId: string;
  fileVersion: number;
  fileHash: string;
  coverAssetId: string | null;
  coverVersion: number | null;
  metadataHash: string;
  packId: string;
  packVersion: string;
  packVerified: string;
  runBy: string;
  at: string;
  /** Open results by grade (a waived one is not counted). */
  errors: number;
  warnings: number;
  suggestions: number;
  /** What this pack does not check, said on the run so "ready" is not read as more than it is. */
  notChecked: string[];
  ready: boolean;
}
export interface NewRun {
  projectId: string;
  editionId?: string | null;
  fileId: string;
  fileVersion: number;
  fileHash: string;
  coverAssetId?: string | null;
  coverVersion?: number | null;
  metadataHash?: string;
  packId: string;
  packVersion: string;
  packVerified?: string;
  notChecked?: string[];
  findings: Finding[];
}

interface RunRow extends Omit<PreflightRun, 'notChecked' | 'ready'> {
  notChecked: string;
}
const RCOLS =
  'id, project_id AS projectId, edition_id AS editionId, file_id AS fileId, file_version AS fileVersion, file_hash AS fileHash, cover_asset_id AS coverAssetId, cover_version AS coverVersion, metadata_hash AS metadataHash, pack_id AS packId, pack_version AS packVersion, pack_verified AS packVerified, run_by AS runBy, at, errors, warnings, suggestions, not_checked AS notChecked';
const toRun = (r: RunRow): PreflightRun => ({ ...r, notChecked: JSON.parse(r.notChecked) as string[], ready: r.errors === 0 });

function cleanFinding(f: Finding, i: number): Finding {
  if (!GRADES.includes(f?.grade)) return fail('invalid', `Result ${i + 1} needs a grade (error, warning or suggestion).`);
  if (typeof f.ruleId !== 'string' || !f.ruleId) return fail('invalid', `Result ${i + 1} needs the rule it came from.`);
  if (typeof f.what !== 'string' || !f.what.trim()) return fail('invalid', `Result ${i + 1} must say what is wrong.`);
  const cut = (s: unknown, n: number) => (typeof s === 'string' ? s.slice(0, n) : '');
  return { ruleId: f.ruleId.slice(0, 100), grade: f.grade, what: f.what.trim().slice(0, 1000), location: cut(f.location, 500), measured: cut(f.measured, 500), expected: cut(f.expected, 500) };
}

/** Records a run and its results in one batch. A result waived on an earlier run of the same file, for the same rule and place, arrives waived. */
export async function recordRun(db: Db, c: Ctx, i: NewRun): Promise<{ run: PreflightRun; results: PreflightResult[] }> {
  if (typeof i?.projectId !== 'string' || !i.projectId) fail('invalid', 'A project is needed.');
  if (typeof i.fileId !== 'string' || !i.fileId) fail('invalid', 'A file is needed.');
  if (!Number.isInteger(i.fileVersion) || i.fileVersion < 1) fail('invalid', 'A file version is needed.');
  if (typeof i.fileHash !== 'string' || !i.fileHash) fail('invalid', 'The file’s hash is needed.');
  if (typeof i.packId !== 'string' || !i.packId || typeof i.packVersion !== 'string') fail('invalid', 'A rule pack and its version are needed.');
  const file = await db.first<{ id: string }>('SELECT id FROM vault_file WHERE id = ? AND studio_id = ?', [i.fileId, c.studioId]);
  if (!file) return fail('not-found', 'That file is not in the vault.');
  const found = i.findings.map(cleanFinding);
  // waivers carry over: the same rule at the same place in the same file (any version), waived before
  const waived = await db.all<{ rule_id: string; location: string; waived_by: string; waived_reason: string; waived_at: string }>(
    `SELECT r.rule_id, r.location, r.waived_by, r.waived_reason, r.waived_at FROM preflight_result r JOIN preflight_run p ON p.id = r.run_id
      WHERE p.studio_id = ? AND p.file_id = ? AND r.state = 'waived' ORDER BY r.waived_at`,
    [c.studioId, i.fileId]
  );
  const carry = new Map(waived.map((w) => [`${w.rule_id}\u0000${w.location}`, w]));
  const id = newRecordId();
  const rows = found.map((f, n) => {
    const w = carry.get(`${f.ruleId}\u0000${f.location ?? ''}`);
    return { f, seq: n + 1, w };
  });
  const open = (g: Grade) => rows.filter((r) => !r.w && r.f.grade === g).length;
  await db.batch([
    {
      sql: `INSERT INTO preflight_run (id, studio_id, project_id, edition_id, file_id, file_version, file_hash, cover_asset_id, cover_version, metadata_hash, pack_id, pack_version, pack_verified, run_by, at, errors, warnings, suggestions, not_checked)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [id, c.studioId, i.projectId, i.editionId ?? null, i.fileId, i.fileVersion, i.fileHash, i.coverAssetId ?? null, i.coverVersion ?? null, i.metadataHash ?? '', i.packId, i.packVersion, i.packVerified ?? '', c.actor, c.now, open('error'), open('warning'), open('suggestion'), JSON.stringify(i.notChecked ?? [])]
    },
    ...rows.map(({ f, seq, w }) => ({
      sql: 'INSERT INTO preflight_result (run_id, seq, rule_id, grade, what, location, measured, expected, state, waived_by, waived_reason, waived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [id, seq, f.ruleId, f.grade, f.what, f.location ?? '', f.measured ?? '', f.expected ?? '', w ? 'waived' : 'open', w?.waived_by ?? null, w?.waived_reason ?? null, w?.waived_at ?? null]
    })),
    audit(c, 'preflight.run', id, { fileId: i.fileId, fileVersion: i.fileVersion, pack: `${i.packId}@${i.packVersion}`, errors: open('error'), warnings: open('warning') })
  ]);
  return (await getRun(db, c, id))!;
}

interface ResultRow extends Omit<PreflightResult, 'carried'> {
  runId: string;
}
const XCOLS = 'run_id AS runId, seq, rule_id AS ruleId, grade, what, location, measured, expected, state, waived_by AS waivedBy, waived_reason AS waivedReason, waived_at AS waivedAt';
export async function getRun(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<{ run: PreflightRun; results: PreflightResult[] } | null> {
  const r = await db.first<RunRow>(`SELECT ${RCOLS} FROM preflight_run WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
  if (!r) return null;
  const rows = await db.all<ResultRow>(`SELECT ${XCOLS} FROM preflight_result WHERE run_id = ? ORDER BY seq`, [id]);
  const order = { error: 0, warning: 1, suggestion: 2 } as const;
  const results = rows
    .map(({ runId: _r, ...x }) => ({ ...x, carried: x.state === 'waived' && !!x.waivedAt && x.waivedAt < r.at }))
    .sort((a, b) => order[a.grade] - order[b.grade] || a.seq - b.seq);
  return { run: toRun(r), results };
}
export interface RunFilter {
  projectId?: string;
  projectIds?: string[];
  editionId?: string;
  fileId?: string;
  limit?: number;
}
export async function listRuns(db: Db, c: Pick<Ctx, 'studioId'>, f: RunFilter = {}): Promise<PreflightRun[]> {
  const where = ['studio_id = ?'];
  const params: unknown[] = [c.studioId];
  if (f.projectId) (where.push('project_id = ?'), params.push(f.projectId));
  if (f.projectIds) {
    if (!f.projectIds.length) return [];
    where.push(`project_id IN (${f.projectIds.map(() => '?').join(',')})`);
    params.push(...f.projectIds);
  }
  if (f.editionId) (where.push('edition_id = ?'), params.push(f.editionId));
  if (f.fileId) (where.push('file_id = ?'), params.push(f.fileId));
  params.push(Math.min(Math.max(f.limit ?? 50, 1), 200));
  return (await db.all<RunRow>(`SELECT ${RCOLS} FROM preflight_run WHERE ${where.join(' AND ')} ORDER BY at DESC, rowid DESC LIMIT ?`, params)).map(toRun);
}
/** The newest run for an edition (or, with none given, for a file). */
export async function latestRun(db: Db, c: Pick<Ctx, 'studioId'>, f: { editionId?: string; fileId?: string; projectIds?: string[] }): Promise<PreflightRun | null> {
  return (await listRuns(db, c, { ...f, limit: 1 }))[0] ?? null;
}

/** Waives one open result, with a reason. A waived result stays on the run and carries onto later runs of the same file. */
export async function waiveResult(db: Db, c: Ctx, runId: string, seq: number, reason: string): Promise<{ run: PreflightRun; results: PreflightResult[] }> {
  const got = await getRun(db, c, runId);
  if (!got) return fail('not-found', 'That run is not there.');
  const r = got.results.find((x) => x.seq === seq);
  if (!r) return fail('not-found', 'That result is not there.');
  if (r.state === 'waived') return fail('conflict', 'That result has already been waived.');
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (!why) return fail('invalid', 'A waiver needs a reason.');
  if (why.length > 1000) return fail('invalid', 'The reason is too long (1000 characters at most).');
  await db.batch([
    { sql: "UPDATE preflight_result SET state = 'waived', waived_by = ?, waived_reason = ?, waived_at = ? WHERE run_id = ? AND seq = ? AND state = 'open'", params: [c.actor, why, c.now, runId, seq] },
    { sql: `UPDATE preflight_run SET ${r.grade === 'error' ? 'errors = errors - 1' : r.grade === 'warning' ? 'warnings = warnings - 1' : 'suggestions = suggestions - 1'} WHERE id = ?`, params: [runId] },
    audit(c, 'preflight.waive', runId, { seq, ruleId: r.ruleId, reason: why })
  ]);
  return (await getRun(db, c, runId))!;
}
