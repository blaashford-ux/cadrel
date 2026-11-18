/**
 * What a workflow gate can see of a project's continuity checks (see `continuity_clear` in workflow.ts). The project tree is a file, so the caller
 * passes in the project and the subprojects under it; this reads only the records. Only the newest check of each manuscript counts: an earlier one
 * has been overtaken by it.
 */
import type { Ctx } from './catalogue';
import type { ContinuityFacts } from './workflow';
import type { Db } from './vault';

export async function continuityFacts(db: Db, c: Pick<Ctx, 'studioId'>, projectIds: string[]): Promise<ContinuityFacts> {
  if (!projectIds.length) return { checked: 0, underway: 0, openHigh: 0 };
  const marks = projectIds.map(() => '?').join(',');
  const rows = await db.all<{ fileId: string; state: string; createdAt: string; openHigh: number }>(
    `SELECT k.file_id AS fileId, k.state AS state, k.created_at AS createdAt,
            (SELECT COUNT(*) FROM continuity_finding f WHERE f.check_id = k.id AND f.state = 'open' AND f.severity = 'high') AS openHigh
     FROM continuity_check k WHERE k.studio_id = ? AND k.project_id IN (${marks}) ORDER BY k.created_at, k.rowid`,
    [c.studioId, ...projectIds]
  );
  const newest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) newest.set(r.fileId, r); // ordered oldest to newest, so the last one wins
  const latest = [...newest.values()];
  return {
    checked: latest.filter((r) => r.state !== 'open').length,
    underway: latest.filter((r) => r.state === 'open').length,
    openHigh: latest.reduce((n, r) => n + r.openHigh, 0)
  };
}
