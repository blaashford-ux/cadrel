/**
 * Revision verification: which of the changes the author accepted in an editorial pass were made in the revised manuscript. `verifyRevision` is
 * pure (the two texts and the accepted items in, a result for each out); `saveVerification` keeps the results with the pass. The records hold no
 * manuscript text, so whoever calls (the screen, an assistant tool) supplies the text of the version the pass covers and of the revised version.
 *
 *   made       a suggestion's replacement is where the passage was (and the passage is not).
 *   missed     the passage is still there as it was.
 *   changed    the passage is no longer there, but the replacement is not either; or, for a comment or query that asked for a change, the
 *              passage or the text around it was altered. Someone should look.
 *   unchecked  an accepted item with no passage to look for.
 */
import { contextMatch, locateAnchor, type TextAnchor } from './anchor';
import { newRecordId } from './ids';
import type { Ctx } from './catalogue';
import type { Db } from './vault';
import { WorkError } from './work';
import { getPass } from './editPass';
import { listEditDecisions } from './editDecision';
import { listQueries, type QueryRecord } from './editQuery';

export const VERIFY_RESULTS = ['made', 'changed', 'missed', 'unchecked'] as const;
export type VerifyResult = (typeof VERIFY_RESULTS)[number];

export interface VerifyItem {
  queryId: string;
  kind: 'query' | 'comment' | 'suggestion';
  anchor: TextAnchor | null;
  replacement: string | null;
}
export interface ItemVerdict {
  queryId: string;
  result: VerifyResult;
  /** Where it was found in the revised text, when it was. */
  found: { start: number; end: number } | null;
  note: string;
}

export function verifyRevision(revised: string, items: VerifyItem[]): ItemVerdict[] {
  return items.map((it): ItemVerdict => {
    const a = it.anchor;
    if (!a || !a.quote.trim()) return { queryId: it.queryId, result: 'unchecked', found: null, note: 'This item has no passage to look for.' };
    const orig = locateAnchor(revised, a);
    const origCtx = orig ? contextMatch(revised, a, orig.start, orig.end - orig.start) : 0;

    if (it.kind === 'suggestion' && it.replacement !== null) {
      if (it.replacement === '') {
        return orig
          ? { queryId: it.queryId, result: 'missed', found: orig, note: 'The passage that should have been taken out is still there.' }
          : { queryId: it.queryId, result: 'made', found: null, note: 'The passage was taken out.' };
      }
      const r = locateAnchor(revised, { quote: it.replacement, prefix: a.prefix, suffix: a.suffix, start: a.start });
      const rCtx = r ? contextMatch(revised, { quote: it.replacement, prefix: a.prefix, suffix: a.suffix, start: a.start }, r.start, r.end - r.start) : 0;
      if (r && (!orig || (rCtx >= 1 && rCtx >= origCtx))) return { queryId: it.queryId, result: 'made', found: r, note: rCtx >= 1 ? '' : 'The replacement is in the text, but the words around it were changed too.' };
      if (orig) return { queryId: it.queryId, result: 'missed', found: orig, note: 'The passage is still as it was.' };
      return { queryId: it.queryId, result: 'changed', found: null, note: 'The passage was changed, but not to the suggested text.' };
    }

    // an accepted comment or query: all that can be seen is whether the passage was left alone
    if (orig && origCtx === 2) return { queryId: it.queryId, result: 'missed', found: orig, note: 'The passage and the text around it are as they were.' };
    return { queryId: it.queryId, result: 'changed', found: orig, note: orig ? 'The text around the passage was altered.' : 'The passage was altered or removed.' };
  });
}

export interface VerificationRecord extends ItemVerdict {
  id: string;
  passId: string;
  revisedVersion: number;
  checkedBy: string;
  checkedAt: string;
}
interface Row {
  id: string;
  passId: string;
  queryId: string;
  revisedVersion: number;
  result: VerifyResult;
  start: number | null;
  end: number | null;
  note: string;
  checkedBy: string;
  checkedAt: string;
}
const COLS = 'id, pass_id AS passId, query_id AS queryId, revised_version AS revisedVersion, result, found_start AS start, found_end AS end, note, checked_by AS checkedBy, checked_at AS checkedAt';
const toRecord = ({ start, end, ...r }: Row): VerificationRecord => ({ ...r, found: start === null || end === null ? null : { start, end } });

const fail = (code: ConstructorParameters<typeof WorkError>[0], m: string): never => {
  throw new WorkError(code, m);
};

/** The accepted items of a pass, as they stand now (a later decision replaces an earlier one). */
export async function acceptedItems(db: Db, c: Pick<Ctx, 'studioId'>, passId: string): Promise<VerifyItem[]> {
  const accepted = new Set((await listEditDecisions(db, c, { passId })).filter((d) => d.outcome === 'accept').map((d) => d.queryId));
  return (await listQueries(db, c, { passId }))
    .filter((q: QueryRecord) => accepted.has(q.id) && q.state !== 'withdrawn')
    .map((q) => ({ queryId: q.id, kind: q.kind, anchor: q.anchor, replacement: q.replacement }));
}

/**
 * Checks the accepted changes of a responded or closed pass against the text of a later version of the same file and keeps the results,
 * replacing any earlier check against that version. Returns them in the pass's item order.
 */
export async function verifyPass(db: Db, c: Ctx, passId: string, input: { revisedVersion: number; revisedText: string }): Promise<VerificationRecord[]> {
  const pass = await getPass(db, c, passId);
  if (!pass) return fail('not-found', 'That pass is not there.');
  if (pass.state !== 'responded' && pass.state !== 'closed') fail('conflict', 'A revision is checked once the author has responded to the pass.');
  if (typeof input?.revisedText !== 'string') fail('invalid', 'The text of the revised version is needed.');
  if (input.revisedText.length > 20_000_000) fail('invalid', 'The revised text is too large to check.');
  const v = input.revisedVersion;
  if (!Number.isInteger(v) || v <= pass.fileVersion) fail('invalid', `A revision is a version after the one the pass covers (version ${pass.fileVersion}).`);
  const exists = await db.first('SELECT 1 AS x FROM file_version WHERE file_id = ? AND n = ?', [pass.fileId, v]);
  if (!exists) return fail('not-found', 'That version of the file is not there.');

  const results = verifyRevision(input.revisedText, await acceptedItems(db, c, passId));
  await db.batch([
    { sql: 'DELETE FROM edit_verification WHERE pass_id = ? AND revised_version = ? AND studio_id = ?', params: [passId, v, c.studioId] },
    ...results.map((r) => ({
      sql: 'INSERT INTO edit_verification (id, studio_id, pass_id, query_id, revised_version, result, found_start, found_end, note, checked_by, checked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      params: [newRecordId(), c.studioId, passId, r.queryId, v, r.result, r.found?.start ?? null, r.found?.end ?? null, r.note, c.actor, c.now]
    })),
    { sql: 'INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)', params: [c.now, c.actor, 'pass.verify', passId, JSON.stringify({ revisedVersion: v, counts: Object.fromEntries(VERIFY_RESULTS.map((k) => [k, results.filter((r) => r.result === k).length])) })] }
  ]);
  return listVerification(db, c, { passId, revisedVersion: v });
}

export async function listVerification(db: Db, c: Pick<Ctx, 'studioId'>, f: { passId: string; revisedVersion?: number }): Promise<VerificationRecord[]> {
  const v = f.revisedVersion ?? (await db.first<{ v: number | null }>('SELECT MAX(revised_version) AS v FROM edit_verification WHERE pass_id = ? AND studio_id = ?', [f.passId, c.studioId]))?.v;
  if (v === null || v === undefined) return [];
  return (
    await db.all<Row>(
      `SELECT ${COLS.split(', ').map((x) => 'v.' + x).join(', ')} FROM edit_verification v JOIN edit_query q ON q.id = v.query_id WHERE v.studio_id = ? AND v.pass_id = ? AND v.revised_version = ? ORDER BY q.seq`,
      [c.studioId, f.passId, v]
    )
  ).map(toRecord);
}
