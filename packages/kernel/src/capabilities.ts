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

/** Plain-language descriptions for the role editor's checklist. A test fails when a capability in the catalogue has none. */
export const CAPABILITY_INFO: Record<string, string> = {
  'people.read': 'See the people, teams and who holds which role',
  'people.invite': 'Invite people to the studio',
  'people.manage': 'Add, change and deactivate people and their pen names',
  'roles.manage': 'Create and edit roles, and give roles to people and teams',
  'teams.manage': 'Create teams and change who is in them',
  'studio.settings': 'Change the studio’s settings',
  'security.policy': 'Change sign-in, guest and session rules',
  'audit.read': 'Read the audit log',
  'vault.force': 'Release someone else’s check-out (their unsaved work is kept aside, not lost)',
  'confidential.access': 'See confidential projects without being assigned to them',
  'catalogue.read': 'See IP, series, books and editions',
  'catalogue.edit': 'Edit books and editions: titles, stages, ASIN, ISBN, price, dates',
  'catalogue.create': 'Create IP, series and books',
  'catalogue.archive': 'Archive and restore IP, series, books and editions',
  'workflow.design': 'Design workflow states and transitions',
  'task.read': 'See tasks and deadlines',
  'task.edit': 'Edit tasks and deadlines assigned to you',
  'task.assign': 'Assign tasks to other people',
  'task.manage': 'Create, change and remove any task or deadline',
  'manuscript.read': 'Read manuscripts',
  'manuscript.comment': 'Comment on manuscripts',
  'manuscript.write': 'Write and edit manuscripts',
  'manuscript.approve': 'Approve manuscripts for the next stage',
  'manuscript.manage': 'Manage manuscripts: structure, versions and states',
  'edit.read': 'See editorial passes and queries',
  'edit.respond': 'Respond to editorial queries',
  'edit.approve': 'Approve editorial passes',
  'edit.run': 'Run editorial passes',
  'edit.assign': 'Assign editors to passes',
  'canon.read': 'Read the series bible',
  'canon.propose': 'Propose changes to the series bible',
  'canon.approve': 'Approve changes to the series bible',
  'canon.manage': 'Manage the series bible',
  'asset.read': 'See art, covers and other assets',
  'asset.comment': 'Comment on assets',
  'asset.write': 'Upload and edit assets',
  'asset.approve': 'Approve assets for use',
  'asset.manage': 'Manage assets, licences and usage',
  'brief.write': 'Write briefs for covers, art and campaigns',
  'preflight.read': 'See preflight results',
  'preflight.run': 'Run preflight checks',
  'launch.read': 'See launch plans and campaigns',
  'launch.comment': 'Comment on launch plans',
  'launch.approve': 'Approve launch plans',
  'launch.manage': 'Plan and run launches and campaigns',
  'market.read': 'See market research',
  'market.capture': 'Capture pages for market research',
  'market.manage': 'Manage market research data and settings',
  'sales.read': 'See sales figures (not royalties or payments)',
  'royalties.read': 'See royalties, payments and payouts (reads are logged)',
  'royalties.manage': 'Import KDP reports, set splits and record payouts',
  'business.read': 'See contracts, credits, rights, revenue shares and costs (reads are logged)',
  'business.manage': 'Manage contracts, credits, rights, revenue shares and costs',
  'assistant.use': 'Use the assistant, acting only with your own permissions'
};
