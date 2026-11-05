/**
 * What a workflow gate can see of a project's editorial passes (see `pass_closed` and `queries_resolved` in workflow.ts). The project tree is a
 * file, so the caller passes in the project and the subprojects under it; this reads only the records. Proofreading is counted like any pass
 * here, but a gate can never ask for it (workflow.ts refuses), so a proofread only advises.
 */
import type { Ctx } from './catalogue';
import type { EditorialFacts } from './workflow';
import type { Db } from './vault';

export async function editorialFacts(db: Db, c: Pick<Ctx, 'studioId'>, projectIds: string[]): Promise<EditorialFacts> {
  if (!projectIds.length) return { closed: [], live: [], unansweredQueries: 0 };
  const marks = projectIds.map(() => '?').join(',');
  const passes = await db.all<{ kind: string; state: string }>(`SELECT DISTINCT kind, state FROM edit_pass WHERE studio_id = ? AND project_id IN (${marks}) AND state != 'cancelled'`, [c.studioId, ...projectIds]);
  const open = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM edit_query q JOIN edit_pass p ON p.id = q.pass_id WHERE q.studio_id = ? AND p.project_id IN (${marks}) AND p.state != 'cancelled' AND q.kind = 'query' AND q.state = 'open'`,
    [c.studioId, ...projectIds]
  );
  return {
    closed: [...new Set(passes.filter((p) => p.state === 'closed').map((p) => p.kind))],
    live: [...new Set(passes.filter((p) => p.state !== 'closed').map((p) => p.kind))],
    unansweredQueries: open?.n ?? 0
  };
}
