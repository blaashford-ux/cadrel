/**
 * What a workflow gate can see of a project's art and Preflight (see `cover_approved` and `preflight_clear` in workflow.ts). The caller passes in the
 * project and the subprojects under it; this reads only the records. Only the newest Preflight run of each EPUB counts: an earlier one has been
 * overtaken by it, and a waived result is not an open error.
 */
import type { Ctx } from './catalogue';
import type { Db } from './vault';
import type { ArtFacts } from './workflow';

export async function artFacts(db: Db, c: Pick<Ctx, 'studioId'>, projectIds: string[]): Promise<ArtFacts> {
  if (!projectIds.length) return { approvedCovers: 0, checked: 0, openErrors: 0 };
  const marks = projectIds.map(() => '?').join(',');
  const covers = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM asset WHERE studio_id = ? AND kind = 'cover' AND state = 'approved' AND project_id IN (${marks})`, [c.studioId, ...projectIds]);
  const runs = await db.all<{ fileId: string; errors: number }>(
    `SELECT file_id AS fileId, errors FROM preflight_run WHERE studio_id = ? AND project_id IN (${marks}) ORDER BY at, rowid`,
    [c.studioId, ...projectIds]
  );
  const newest = new Map<string, number>();
  for (const r of runs) newest.set(r.fileId, r.errors); // ordered oldest to newest, so the last one wins
  return { approvedCovers: covers?.n ?? 0, checked: newest.size, openErrors: [...newest.values()].reduce((n, e) => n + e, 0) };
}
