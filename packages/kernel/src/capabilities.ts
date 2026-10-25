/**
 * The capability catalogue. A capability is a named permission, `area.action`. Roles are sets of capabilities.
 * Each area groups its capabilities by level so default roles can be written as one letter per area (see roles.ts):
 *   R read · C comment/respond · W write · A approve/decide · M manage.
 * Levels are cumulative in the sense that W includes R and C, A includes R and C, M includes everything in the area.
 */

export type Level = 'R' | 'C' | 'W' | 'A' | 'M';

export interface AreaDef {
  id: string;
  /** Label exactly as it appears in the default-role matrix of docs/PERMISSIONS.md (a test keeps them in step). */
  label: string;
  caps: Partial<Record<Level, string[]>>;
}

export const AREAS: AreaDef[] = [
  { id: 'people', label: 'People, teams, roles', caps: { R: ['people.read'], M: ['people.invite', 'people.manage', 'roles.manage', 'teams.manage'] } },
  { id: 'settings', label: 'Security policy, studio settings', caps: { M: ['studio.settings', 'security.policy'] } },
  { id: 'audit', label: 'Audit log', caps: { R: ['audit.read'] } },
  { id: 'force', label: 'Force check-out (`vault.force`)', caps: { A: ['vault.force'] } },
  { id: 'confidential', label: 'Confidential projects (`confidential.access`)', caps: { A: ['confidential.access'] } },
  { id: 'catalogue', label: 'Catalogue: IP, series, books, editions', caps: { R: ['catalogue.read'], W: ['catalogue.edit'], M: ['catalogue.create', 'catalogue.archive'] } },
  { id: 'workflow', label: 'Workflow design (states, transitions)', caps: { M: ['workflow.design'] } },
  { id: 'tasks', label: 'Tasks and deadlines', caps: { R: ['task.read'], W: ['task.edit'], M: ['task.assign', 'task.manage'] } },
  { id: 'manuscripts', label: 'Manuscripts', caps: { R: ['manuscript.read'], C: ['manuscript.comment'], W: ['manuscript.write'], A: ['manuscript.approve'], M: ['manuscript.manage'] } },
  { id: 'editorial', label: 'Editorial passes and queries', caps: { R: ['edit.read'], C: ['edit.respond'], A: ['edit.approve'], M: ['edit.run', 'edit.assign'] } },
  { id: 'canon', label: 'Canon / series bible', caps: { R: ['canon.read'], W: ['canon.propose'], A: ['canon.approve'], M: ['canon.manage'] } },
  { id: 'assets', label: 'Assets, art, covers', caps: { R: ['asset.read'], C: ['asset.comment'], W: ['asset.write'], A: ['asset.approve'], M: ['asset.manage', 'brief.write'] } },
  { id: 'preflight', label: 'Preflight', caps: { R: ['preflight.read'], W: ['preflight.run'] } },
  { id: 'launch', label: 'Launch and marketing', caps: { R: ['launch.read'], C: ['launch.comment'], A: ['launch.approve'], M: ['launch.manage'] } },
  { id: 'market', label: 'Market research', caps: { R: ['market.read'], W: ['market.capture'], M: ['market.manage'] } },
  { id: 'sales', label: 'Sales (aggregates)', caps: { R: ['sales.read'] } },
  { id: 'royalties', label: 'Royalties, payments, payouts', caps: { R: ['royalties.read'], M: ['royalties.manage'] } },
  { id: 'business', label: 'Contracts, credits, rights, revenue shares, costs', caps: { R: ['business.read'], M: ['business.manage'] } },
  { id: 'assistant', label: 'Assistant (MCP)', caps: { W: ['assistant.use'] } }
];

const ORDER: Level[] = ['R', 'C', 'W', 'A', 'M'];

/** The capabilities a level grants within one area. */
export function capsForLevel(area: AreaDef, level: Level): string[] {
  const out = new Set<string>();
  const take = (l: Level) => (area.caps[l] ?? []).forEach((c) => out.add(c));
  if (level === 'M') ORDER.forEach(take);
  else {
    take('R');
    if (level !== 'R') take('C');
    if (level !== 'R' && level !== 'C') take(level);
  }
  return [...out];
}

/** Every capability in the catalogue. */
export function allCapabilities(): string[] {
  return [...new Set(AREAS.flatMap((a) => ORDER.flatMap((l) => a.caps[l] ?? [])))];
}

/** Capabilities whose use is recorded in the audit log even for reads (finance and contract data). */
export const AUDITED_READS = new Set(['royalties.read', 'business.read']);
