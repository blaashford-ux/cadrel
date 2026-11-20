/**
 * Release plans (docs/M6-PLAN.md): a launch that works backwards from its date. Records and rules over the kernel's async `Db`; nothing here decides
 * who may do what (the service checks first), it decides what is valid.
 *
 *   - A **template** is the phases of a launch as offsets from the release date, versioned like a brief.
 *   - A **plan** is made from a template for a book and a date. Each **item is a task** (so it is in the Planner and on Home) plus what it needs.
 *   - What is **outstanding** is computed from the records (an approved cover, a clear Preflight run, a sign-off, a fulfilled request, a brief, ARC
 *     readers), never typed in: `evaluateItem` is a pure function of the plan's tasks and the facts the caller gathers.
 *   - **Moving the date makes a proposal**: each open item's old and new due date is listed, done items are untouched, and nothing changes until it is
 *     applied. **Approval is of an exact revision** of the plan, so a change afterwards shows as changed.
 * Errors are `WorkError`s, so they cross the wire like the rest of the work records.
 */
import { newRecordId } from './ids';
import type { Ctx } from './catalogue';
import type { Db } from './vault';
import { WorkError, createTask, getTask, setTaskState, updateTask, type TaskRecord } from './work';

export type Requirement =
  | { kind: 'manual' }
  | { kind: 'cover_approved' }
  | { kind: 'preflight_clear' }
  | { kind: 'approval'; label: string }
  | { kind: 'asset_request'; requestId?: string }
  | { kind: 'brief'; briefKind: 'launch' | 'campaign' }
  | { kind: 'arc'; minReaders: number };
export const REQUIREMENT_KINDS = ['manual', 'cover_approved', 'preflight_clear', 'approval', 'asset_request', 'brief', 'arc'] as const;

export interface TemplateItem {
  key: string;
  title: string;
  /** Days from the release date; negative is before. */
  offsetDays: number;
  required: boolean;
  /** Who it is for ("marketing", "art", "author", "director"), so a plan can name a person per role. */
  role?: string;
  /** The keys of items that must be done first. They must come earlier in the list. */
  dependsOn?: string[];
  requirement?: Requirement;
  /** A fixed date that cannot slip silently (the release itself, the upload): a deadline rather than a task. */
  deadline?: boolean;
}

const fail = (code: ConstructorParameters<typeof WorkError>[0], m: string, reasons: string[] = []): never => {
  throw new WorkError(code, m, reasons);
};
const audit = (c: Ctx, action: string, target: string, detail: unknown) => ({
  sql: 'INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)',
  params: [c.now, c.actor, action, target, JSON.stringify(detail)]
});
const clean = (v: unknown, what: string, max: number, required = true): string => {
  const s = typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : '';
  if (required && !s) return fail('invalid', `${what} cannot be empty.`);
  return s.length > max ? fail('invalid', `${what} is too long (${max} characters at most).`) : s;
};
const isUnique = (e: unknown) => /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|SQLITE_CONSTRAINT_PRIMARYKEY/i.test(String((e as Error)?.message ?? e));

// ---- dates and revisions (pure) -------------------------------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export function cleanDay(v: unknown, what = 'A date'): string {
  if (typeof v !== 'string' || !DATE.test(v) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) return fail('invalid', `${what} is a day written YYYY-MM-DD.`);
  return v;
}
/** `day` plus `n` days (negative for before), as YYYY-MM-DD. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
/** Whole days from `a` to `b` (positive when b is later). */
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** A short stable hash of a string (cyrb53), for "this is the plan that was approved". Not for secrets. */
export function hashText(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

// ---- templates -------------------------------------------------------------------------------------------------------------------

export const DEFAULT_TEMPLATES: { key: string; name: string; items: TemplateItem[] }[] = [
  {
    key: 'ebook_launch',
    name: 'Ebook launch',
    items: [
      { key: 'brief', title: 'Write the marketing brief', offsetDays: -60, required: true, role: 'marketing', requirement: { kind: 'brief', briefKind: 'launch' } },
      { key: 'cover', title: 'Cover approved', offsetDays: -56, required: true, role: 'art', requirement: { kind: 'cover_approved' } },
      { key: 'art', title: 'Campaign art delivered', offsetDays: -35, required: false, role: 'art', dependsOn: ['brief'], requirement: { kind: 'asset_request' } },
      { key: 'arc', title: 'Send ARC copies', offsetDays: -42, required: true, role: 'marketing', dependsOn: ['cover'], requirement: { kind: 'arc', minReaders: 10 } },
      { key: 'preflight', title: 'EPUB passes Preflight', offsetDays: -14, required: true, role: 'marketing', dependsOn: ['cover'], requirement: { kind: 'preflight_clear' } },
      { key: 'upload', title: 'Upload and set the preorder', offsetDays: -10, required: true, role: 'marketing', dependsOn: ['preflight'], deadline: true },
      { key: 'signoff', title: 'Ready to publish sign-off', offsetDays: -7, required: true, role: 'director', dependsOn: ['preflight'], requirement: { kind: 'approval', label: 'Ready to publish' } },
      { key: 'newsletter', title: 'Newsletter and swaps go out', offsetDays: -3, required: false, role: 'marketing', dependsOn: ['upload'] },
      { key: 'launch', title: 'Launch day', offsetDays: 0, required: true, role: 'marketing', dependsOn: ['signoff'], deadline: true },
      { key: 'review', title: 'Post-launch review', offsetDays: 30, required: false, role: 'marketing', dependsOn: ['launch'] }
    ]
  },
  {
    key: 'series_launch',
    name: 'Series launch',
    items: [
      { key: 'brief', title: 'Write the marketing brief', offsetDays: -75, required: true, role: 'marketing', requirement: { kind: 'brief', briefKind: 'launch' } },
      { key: 'cover', title: 'Cover approved', offsetDays: -70, required: true, role: 'art', requirement: { kind: 'cover_approved' } },
      { key: 'art', title: 'Campaign art delivered', offsetDays: -42, required: false, role: 'art', dependsOn: ['brief'], requirement: { kind: 'asset_request' } },
      { key: 'arc', title: 'Send ARC copies', offsetDays: -49, required: true, role: 'marketing', dependsOn: ['cover'], requirement: { kind: 'arc', minReaders: 15 } },
      { key: 'alsoby', title: 'Update the Also by pages of the earlier books', offsetDays: -21, required: true, role: 'author' },
      { key: 'preflight', title: 'EPUB passes Preflight', offsetDays: -14, required: true, role: 'marketing', dependsOn: ['cover'], requirement: { kind: 'preflight_clear' } },
      { key: 'upload', title: 'Upload and set the preorder', offsetDays: -10, required: true, role: 'marketing', dependsOn: ['preflight'], deadline: true },
      { key: 'signoff', title: 'Ready to publish sign-off', offsetDays: -7, required: true, role: 'director', dependsOn: ['preflight'], requirement: { kind: 'approval', label: 'Ready to publish' } },
      { key: 'series', title: 'Series page and links checked', offsetDays: -5, required: true, role: 'marketing', dependsOn: ['upload'] },
      { key: 'newsletter', title: 'Newsletter and swaps go out', offsetDays: -3, required: false, role: 'marketing', dependsOn: ['upload'] },
      { key: 'launch', title: 'Launch day', offsetDays: 0, required: true, role: 'marketing', dependsOn: ['signoff'], deadline: true },
      { key: 'review', title: 'Post-launch review', offsetDays: 30, required: false, role: 'marketing', dependsOn: ['launch'] }
    ]
  }
];

const MAX_ITEMS = 60;
export function cleanRequirement(r: unknown): Requirement {
  const o = (r ?? { kind: 'manual' }) as Requirement & Record<string, unknown>;
  if (!(REQUIREMENT_KINDS as readonly string[]).includes(o.kind)) return fail('invalid', 'An item needs one of: a cover, a Preflight result, a sign-off, a campaign asset, a brief, ARC readers, or nothing.');
  switch (o.kind) {
    case 'approval':
      return { kind: 'approval', label: clean(o.label, 'The sign-off label', 100) };
    case 'brief':
      return o.briefKind === 'campaign' ? { kind: 'brief', briefKind: 'campaign' } : { kind: 'brief', briefKind: 'launch' };
    case 'arc': {
      const n = Number(o.minReaders);
      if (!Number.isInteger(n) || n < 1 || n > 10_000) return fail('invalid', 'ARC needs a number of readers from 1.');
      return { kind: 'arc', minReaders: n };
    }
    case 'asset_request':
      return typeof o.requestId === 'string' && o.requestId ? { kind: 'asset_request', requestId: o.requestId } : { kind: 'asset_request' };
    default:
      return { kind: o.kind } as Requirement;
  }
}
/** Validates and tidies a template's items: unique keys, offsets in range, dependencies that exist and come earlier. */
export function cleanTemplateItems(raw: unknown): TemplateItem[] {
  if (!Array.isArray(raw) || raw.length === 0) return fail('invalid', 'A template needs at least one item.');
  if (raw.length > MAX_ITEMS) return fail('invalid', `A template has at most ${MAX_ITEMS} items.`);
  const seen = new Set<string>();
  return raw.map((x: TemplateItem, i) => {
    const key = clean(x?.key, `Item ${i + 1}'s key`, 40).toLowerCase();
    if (!/^[a-z0-9_]+$/.test(key)) fail('invalid', `Item ${i + 1}'s key uses letters, digits and underscores.`);
    if (seen.has(key)) fail('invalid', `Two items are called "${key}".`);
    const offset = Number(x.offsetDays);
    if (!Number.isInteger(offset) || offset < -730 || offset > 730) fail('invalid', `“${x.title ?? key}” is that many days from the release date: use a whole number within two years.`);
    const deps = [...new Set(x.dependsOn ?? [])];
    for (const d of deps) if (!seen.has(d)) fail('invalid', `“${key}” waits for “${d}”, which must be an earlier item.`);
    seen.add(key);
    return { key, title: clean(x.title, `Item ${i + 1}'s title`, 200), offsetDays: offset, required: x.required !== false, ...(x.role ? { role: clean(x.role, 'The role', 40).toLowerCase() } : {}), ...(deps.length ? { dependsOn: deps } : {}), requirement: cleanRequirement(x.requirement), ...(x.deadline ? { deadline: true } : {}) };
  });
}

export interface ReleaseTemplate {
  id: string;
  key: string | null;
  name: string;
  version: number;
  items: TemplateItem[];
  note: string;
  writtenAt: string;
  writtenBy: string;
  archived: boolean;
}
interface TemplateRow {
  id: string;
  key: string | null;
  name: string;
  archivedAt: string | null;
  n: number;
  items: string;
  note: string;
  writtenAt: string;
  writtenBy: string;
}
const TCOLS = `t.id AS id, t.key AS key, t.name AS name, t.archived_at AS archivedAt, v.n AS n, v.items AS items, v.note AS note, v.written_at AS writtenAt, v.written_by AS writtenBy`;
const toTemplate = (r: TemplateRow): ReleaseTemplate => ({ id: r.id, key: r.key, name: r.name, version: r.n, items: JSON.parse(r.items) as TemplateItem[], note: r.note, writtenAt: r.writtenAt, writtenBy: r.writtenBy, archived: !!r.archivedAt });
const NEWEST = '(v.n = (SELECT MAX(n) FROM release_template_version WHERE template_id = t.id))';

export async function listTemplates(db: Db, c: Pick<Ctx, 'studioId'>, o: { archived?: boolean } = {}): Promise<ReleaseTemplate[]> {
  const rows = await db.all<TemplateRow>(`SELECT ${TCOLS} FROM release_template t JOIN release_template_version v ON v.template_id = t.id WHERE t.studio_id = ? AND ${NEWEST} ${o.archived ? '' : 'AND t.archived_at IS NULL'} ORDER BY lower(t.name)`, [c.studioId]);
  return rows.map(toTemplate);
}
export async function getTemplate(db: Db, c: Pick<Ctx, 'studioId'>, id: string, version?: number): Promise<ReleaseTemplate | null> {
  const r = version
    ? await db.first<TemplateRow>(`SELECT ${TCOLS} FROM release_template t JOIN release_template_version v ON v.template_id = t.id WHERE t.id = ? AND t.studio_id = ? AND v.n = ?`, [id, c.studioId, version])
    : await db.first<TemplateRow>(`SELECT ${TCOLS} FROM release_template t JOIN release_template_version v ON v.template_id = t.id WHERE t.id = ? AND t.studio_id = ? AND ${NEWEST}`, [id, c.studioId]);
  return r ? toTemplate(r) : null;
}
export async function createTemplate(db: Db, c: Ctx, i: { name: string; items: TemplateItem[]; key?: string | null }): Promise<ReleaseTemplate> {
  const name = clean(i?.name, 'The name', 100);
  const items = cleanTemplateItems(i?.items);
  const id = newRecordId();
  try {
    await db.batch([
      { sql: 'INSERT INTO release_template (id, studio_id, key, name, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)', params: [id, c.studioId, i.key ?? null, name, c.now, c.actor] },
      { sql: "INSERT INTO release_template_version (template_id, n, items, note, written_at, written_by) VALUES (?, 1, ?, '', ?, ?)", params: [id, JSON.stringify(items), c.now, c.actor] },
      audit(c, 'launch.template_create', id, { name, items: items.length })
    ]);
  } catch (e) {
    if (isUnique(e)) return fail('exists', 'There is already a template with that name.');
    throw e;
  }
  return (await getTemplate(db, c, id))!;
}
/** A revision is a new numbered version; a stale one is refused. A plan keeps the version it was made from. */
export async function reviseTemplate(db: Db, c: Ctx, id: string, i: { items: TemplateItem[]; name?: string; note?: string; basedOn: number }): Promise<ReleaseTemplate> {
  const t = await getTemplate(db, c, id);
  if (!t) return fail('not-found', 'That template is not there.');
  if (i.basedOn !== t.version) return fail('conflict', `That template is now at version ${t.version}; it was changed while you were editing.`);
  const items = cleanTemplateItems(i.items);
  if (JSON.stringify(items) === JSON.stringify(t.items) && (i.name === undefined || i.name.trim() === t.name)) return fail('invalid', 'Nothing was changed.');
  const stmts = [
    { sql: 'INSERT INTO release_template_version (template_id, n, items, note, written_at, written_by) VALUES (?, ?, ?, ?, ?, ?)', params: [id, t.version + 1, JSON.stringify(items), clean(i.note, 'The note', 500, false), c.now, c.actor] },
    ...(i.name !== undefined && i.name.trim() !== t.name ? [{ sql: 'UPDATE release_template SET name = ? WHERE id = ? AND studio_id = ?', params: [clean(i.name, 'The name', 100), id, c.studioId] }] : []),
    audit(c, 'launch.template_revise', id, { version: t.version + 1 })
  ];
  try {
    await db.batch(stmts);
  } catch (e) {
    if (isUnique(e)) return fail('exists', 'There is already a template with that name.');
    throw e;
  }
  return (await getTemplate(db, c, id))!;
}
export async function archiveTemplate(db: Db, c: Ctx, id: string): Promise<void> {
  if (!(await getTemplate(db, c, id))) return fail('not-found', 'That template is not there.');
  await db.batch([{ sql: 'UPDATE release_template SET archived_at = ? WHERE id = ? AND studio_id = ?', params: [c.now, id, c.studioId] }, audit(c, 'launch.template_archive', id, {})]);
}
/** Puts the shipped templates in a Studio that has none of those keys; ones already there (edited, renamed) are left alone. */
export async function ensureDefaultTemplates(db: Db, c: Ctx): Promise<void> {
  for (const d of DEFAULT_TEMPLATES) {
    const have = await db.first<{ id: string }>('SELECT id FROM release_template WHERE studio_id = ? AND key = ?', [c.studioId, d.key]);
    if (!have) {
      const named = await db.first<{ id: string }>('SELECT id FROM release_template WHERE studio_id = ? AND lower(name) = lower(?) AND archived_at IS NULL', [c.studioId, d.name]);
      await createTemplate(db, c, { name: named ? `${d.name} (shipped)` : d.name, items: d.items, key: d.key });
    }
  }
}

// ---- plans ------------------------------------------------------------------------------------------------------------------------

export const PLAN_STATES = ['draft', 'approved', 'live', 'reviewed', 'cancelled'] as const;
export type PlanState = (typeof PLAN_STATES)[number];
export interface PlanTargets {
  /** The rank (best seller rank) the studio hopes to reach in the first 30 days; lower is better. */
  rank?: number;
  /** Reviews hoped for by day 30. */
  reviews?: number;
  /** ARC readers hoped for. */
  readers?: number;
}
export interface ReleasePlan {
  id: string;
  projectId: string;
  editionId: string | null;
  templateId: string | null;
  templateVersion: number | null;
  name: string;
  releaseDate: string;
  state: PlanState;
  targets: PlanTargets;
  approvedRevision: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  liveAt: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}
interface PlanRow extends Omit<ReleasePlan, 'targets'> {
  targets: string;
}
const PCOLS = `id, project_id AS projectId, edition_id AS editionId, template_id AS templateId, template_version AS templateVersion, name, release_date AS releaseDate, state, targets, approved_revision AS approvedRevision, approved_by AS approvedBy, approved_at AS approvedAt, live_at AS liveAt, created_at AS createdAt, created_by AS createdBy, updated_at AS updatedAt`;
const toPlan = (r: PlanRow): ReleasePlan => ({ ...r, targets: JSON.parse(r.targets) as PlanTargets });

export interface PlanFilter {
  projectId?: string;
  projectIds?: string[];
  editionId?: string;
  /** 'live' (the default: not cancelled or reviewed), a state, or 'any'. */
  state?: PlanState | 'open' | 'any';
}
export async function listPlans(db: Db, c: Pick<Ctx, 'studioId'>, f: PlanFilter = {}): Promise<ReleasePlan[]> {
  const where = ['studio_id = ?'];
  const params: unknown[] = [c.studioId];
  if (f.projectId) (where.push('project_id = ?'), params.push(f.projectId));
  if (f.projectIds) {
    if (!f.projectIds.length) return [];
    where.push(`project_id IN (${f.projectIds.map(() => '?').join(',')})`);
    params.push(...f.projectIds);
  }
  if (f.editionId) (where.push('edition_id = ?'), params.push(f.editionId));
  const state = f.state ?? 'open';
  if (state === 'open') where.push("state NOT IN ('cancelled', 'reviewed')");
  else if (state !== 'any') (where.push('state = ?'), params.push(state));
  return (await db.all<PlanRow>(`SELECT ${PCOLS} FROM release_plan WHERE ${where.join(' AND ')} ORDER BY release_date, created_at`, params)).map(toPlan);
}
export async function getPlan(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<ReleasePlan | null> {
  const r = await db.first<PlanRow>(`SELECT ${PCOLS} FROM release_plan WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
  return r ? toPlan(r) : null;
}

export interface PlanItem {
  id: string;
  planId: string;
  key: string;
  taskId: string;
  offsetDays: number;
  required: boolean;
  role: string;
  requirement: Requirement;
}
interface ItemRow extends Omit<PlanItem, 'requirement' | 'required'> {
  required: number;
  requirement: string;
}
const toItem = (r: ItemRow): PlanItem => ({ ...r, required: !!r.required, requirement: JSON.parse(r.requirement) as Requirement });
export async function itemsOf(db: Db, planId: string): Promise<PlanItem[]> {
  return (await db.all<ItemRow>('SELECT id, plan_id AS planId, key, task_id AS taskId, offset_days AS offsetDays, required, role, requirement FROM release_item WHERE plan_id = ? ORDER BY offset_days, rowid', [planId])).map(toItem);
}

export interface NewPlan {
  projectId: string;
  editionId?: string | null;
  templateId: string;
  releaseDate: string;
  name?: string;
  /** A person for each role the template names ("marketing", "art"…); a role left out gives its tasks to no one. */
  assignees?: Record<string, string | null>;
  targets?: PlanTargets;
}
const cleanTargets = (t: PlanTargets | undefined): PlanTargets => {
  const out: PlanTargets = {};
  for (const k of ['rank', 'reviews', 'readers'] as const) {
    const v = t?.[k];
    if (v === undefined || v === null) continue;
    if (!Number.isInteger(v) || v < 1 || v > 100_000_000) fail('invalid', `The ${k} target is a whole number from 1.`);
    out[k] = v;
  }
  return out;
};

/** Makes a plan from a template: the plan, and a task for each item, due that many days from the date, waiting on the tasks the template says. */
export async function createPlan(db: Db, c: Ctx, i: NewPlan): Promise<{ plan: ReleasePlan; items: PlanItem[] }> {
  if (typeof i?.projectId !== 'string' || !i.projectId) fail('invalid', 'A book is needed.');
  const date = cleanDay(i.releaseDate, 'The release date');
  const t = await getTemplate(db, c, i.templateId);
  if (!t || t.archived) return fail('not-found', 'That template is not there.');
  const targets = cleanTargets(i.targets);
  const planId = newRecordId();
  const name = clean(i.name ?? `${t.name}, ${date}`, 'The name', 200);
  await db.batch([
    { sql: "INSERT INTO release_plan (id, studio_id, project_id, edition_id, template_id, template_version, name, release_date, state, targets, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)", params: [planId, c.studioId, i.projectId, i.editionId ?? null, t.id, t.version, name, date, JSON.stringify(targets), c.now, c.actor, c.now] },
    audit(c, 'launch.plan_create', planId, { projectId: i.projectId, date, template: `${t.name}@${t.version}` })
  ]);
  const taskOf = new Map<string, string>();
  for (const it of t.items) {
    const task = await createTask(db, c, {
      projectId: i.projectId,
      title: it.title,
      kind: it.deadline ? 'deadline' : 'task',
      due: addDays(date, it.offsetDays),
      assigneeId: (it.role && i.assignees?.[it.role]) || null,
      notes: `Part of the release plan “${name}”.`,
      dependsOn: (it.dependsOn ?? []).map((d) => taskOf.get(d)!).filter(Boolean)
    });
    taskOf.set(it.key, task.id);
    await db.run('INSERT INTO release_item (id, plan_id, key, task_id, offset_days, required, role, requirement) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [newRecordId(), planId, it.key, task.id, it.offsetDays, it.required ? 1 : 0, it.role ?? '', JSON.stringify(it.requirement ?? { kind: 'manual' })]);
  }
  return { plan: (await getPlan(db, c, planId))!, items: await itemsOf(db, planId) };
}

export async function updatePlan(db: Db, c: Ctx, id: string, patch: { name?: string; targets?: PlanTargets; editionId?: string | null }): Promise<ReleasePlan> {
  const p = await getPlan(db, c, id);
  if (!p) return fail('not-found', 'That plan is not there.');
  if (p.state === 'cancelled' || p.state === 'reviewed') return fail('conflict', `That plan is ${p.state}.`);
  const name = patch.name === undefined ? p.name : clean(patch.name, 'The name', 200);
  const targets = patch.targets === undefined ? p.targets : cleanTargets(patch.targets);
  await db.batch([
    { sql: 'UPDATE release_plan SET name = ?, targets = ?, edition_id = ?, updated_at = ? WHERE id = ? AND studio_id = ?', params: [name, JSON.stringify(targets), patch.editionId === undefined ? p.editionId : patch.editionId, c.now, id, c.studioId] },
    audit(c, 'launch.plan_update', id, { name, targets })
  ]);
  return (await getPlan(db, c, id))!;
}

/** Points an item at a campaign asset request (so "asset delivered" can be computed). */
export async function linkItemRequest(db: Db, c: Ctx, planId: string, key: string, requestId: string): Promise<PlanItem> {
  const it = (await itemsOf(db, planId)).find((x) => x.key === key);
  if (!it) return fail('not-found', 'That item is not in the plan.');
  if (it.requirement.kind !== 'asset_request') return fail('invalid', 'That item does not wait for a campaign asset.');
  await db.batch([{ sql: 'UPDATE release_item SET requirement = ? WHERE id = ?', params: [JSON.stringify({ kind: 'asset_request', requestId }), it.id] }, audit(c, 'launch.item_link', planId, { key, requestId })]);
  return (await itemsOf(db, planId)).find((x) => x.key === key)!;
}

// ---- what is outstanding (pure) -----------------------------------------------------------------------------------------------------

/** What the caller reads from the other records. Each field is what a requirement is judged by. */
export interface PlanFacts {
  /** Today, as 2026-11-20. */
  today: string;
  cover: { approved: boolean; licenceExpired: boolean };
  /** The newest Preflight run of the book's EPUBs: how many are counted, and the errors open in them. */
  preflight: { checked: number; openErrors: number };
  /** The sign-off labels the book stands approved under. */
  approvals: string[];
  /** Campaign asset requests by id: whether each is fulfilled, and its title. */
  requests: Record<string, { fulfilled: boolean; title: string }>;
  /** The kinds of marketing brief the book has. */
  briefs: string[];
  /** ARC readers who have the file. */
  arcSent: number;
}
export const NO_FACTS = (today: string): PlanFacts => ({ today, cover: { approved: false, licenceExpired: false }, preflight: { checked: 0, openErrors: 0 }, approvals: [], requests: {}, briefs: [], arcSent: 0 });

export type ItemStatus = 'done' | 'late' | 'blocked' | 'outstanding' | 'cancelled';
export interface ItemView {
  item: PlanItem;
  task: TaskRecord;
  status: ItemStatus;
  /** Why it cannot be done yet, in words: what is waiting and what is missing. Empty for a done item. */
  reasons: string[];
  /** Days past its due date (0 or negative when not yet due). */
  daysLate: number;
}
/** Whether an item's requirement is met by the facts, and what is missing if not. `manual` is met only by the task being done. */
export function requirementMet(r: Requirement, f: PlanFacts): { met: boolean; missing: string } {
  switch (r.kind) {
    case 'manual':
      return { met: false, missing: '' };
    case 'cover_approved':
      return f.cover.approved ? { met: true, missing: '' } : { met: false, missing: 'The cover is not approved yet.' };
    case 'preflight_clear':
      if (f.preflight.checked === 0) return { met: false, missing: 'The EPUB has not been through Preflight.' };
      return f.preflight.openErrors === 0 ? { met: true, missing: '' } : { met: false, missing: `${f.preflight.openErrors} Preflight error${f.preflight.openErrors === 1 ? ' is' : 's are'} still open.` };
    case 'approval':
      return f.approvals.some((a) => a.toLowerCase() === r.label.toLowerCase()) ? { met: true, missing: '' } : { met: false, missing: `Needs the sign-off “${r.label}”.` };
    case 'asset_request': {
      if (!r.requestId) return { met: false, missing: 'No campaign art has been asked for.' };
      const q = f.requests[r.requestId];
      return q?.fulfilled ? { met: true, missing: '' } : { met: false, missing: `“${q?.title ?? 'The campaign art'}” has not been delivered and approved.` };
    }
    case 'brief':
      return f.briefs.includes(r.briefKind) ? { met: true, missing: '' } : { met: false, missing: `There is no ${r.briefKind === 'launch' ? 'marketing' : 'campaign'} brief yet.` };
    case 'arc':
      return f.arcSent >= r.minReaders ? { met: true, missing: '' } : { met: false, missing: `${f.arcSent} of ${r.minReaders} ARC readers have the file.` };
  }
}

/**
 * Where an item stands. A requirement met by the records counts as done whatever the task says; a task marked done whose requirement is not met is
 * *blocked*, with the reason. `late` is an open item past its due date.
 */
export function evaluateItem(item: PlanItem, task: TaskRecord, tasks: Map<string, TaskRecord>, f: PlanFacts, satisfied: Set<string> = new Set()): ItemView {
  const base = { item, task, daysLate: daysBetween(task.due ?? f.today, f.today) };
  if (task.state === 'cancelled') return { ...base, status: 'cancelled', reasons: [] };
  const req = requirementMet(item.requirement, f);
  const manual = item.requirement.kind === 'manual';
  if (!manual && req.met) return { ...base, status: 'done', reasons: [] };
  if (manual && task.state === 'done') return { ...base, status: 'done', reasons: [] };
  const reasons: string[] = [];
  // it waits for the tasks it depends on that are still open, unless their own requirement is met by the records (an approved cover needs no one to tick it)
  const waiting = task.dependsOn.map((d) => tasks.get(d)).filter((d): d is TaskRecord => !!d && d.state === 'open' && !satisfied.has(d.id));
  if (waiting.length) reasons.push(`Waiting on: ${waiting.map((w) => w.title).join(', ')}.`);
  if (!manual) reasons.push(task.state === 'done' ? `Marked done, but ${req.missing.charAt(0).toLowerCase()}${req.missing.slice(1)}` : req.missing);
  const late = task.due !== null && task.due < f.today;
  return { ...base, status: late ? 'late' : reasons.length ? 'blocked' : 'outstanding', reasons };
}

export interface PlanView {
  plan: ReleasePlan;
  items: ItemView[];
  /** Required items not done, soonest first: what is still to do for the date. */
  outstanding: ItemView[];
  counts: Record<ItemStatus, number>;
  /** The plan's revision now, and whether it differs from the one that was approved. */
  revision: string;
  changedSinceApproval: boolean;
  daysToRelease: number;
}
/** The exact revision of a plan: its date and, for each item, its key, due date, requirement and whether it is required. Approval is of this. */
export function planRevision(plan: Pick<ReleasePlan, 'releaseDate'>, items: { item: PlanItem; task: TaskRecord }[]): string {
  return hashText(JSON.stringify([plan.releaseDate, items.map((x) => [x.item.key, x.task.due, x.item.required, x.item.requirement, x.task.state === 'cancelled'])]));
}
export async function planView(db: Db, c: Pick<Ctx, 'studioId'>, planId: string, f: PlanFacts): Promise<PlanView | null> {
  const plan = await getPlan(db, c, planId);
  if (!plan) return null;
  const items = await itemsOf(db, planId);
  const tasks = new Map<string, TaskRecord>();
  for (const it of items) {
    const t = await getTask(db, c, it.taskId);
    if (t) tasks.set(t.id, t);
  }
  const pairs = items.filter((it) => tasks.has(it.taskId)).map((item) => ({ item, task: tasks.get(item.taskId)! }));
  const satisfied = new Set(pairs.filter((p) => (p.item.requirement.kind === 'manual' ? p.task.state === 'done' : requirementMet(p.item.requirement, f).met)).map((p) => p.task.id));
  const views = pairs.map((p) => evaluateItem(p.item, p.task, tasks, f, satisfied));
  const counts: Record<ItemStatus, number> = { done: 0, late: 0, blocked: 0, outstanding: 0, cancelled: 0 };
  for (const v of views) counts[v.status]++;
  const revision = planRevision(plan, pairs);
  return {
    plan,
    items: views,
    outstanding: views.filter((v) => v.item.required && v.status !== 'done' && v.status !== 'cancelled').sort((a, b) => (a.task.due ?? '').localeCompare(b.task.due ?? '')),
    counts,
    revision,
    changedSinceApproval: plan.approvedRevision !== null && plan.approvedRevision !== revision,
    daysToRelease: daysBetween(f.today, plan.releaseDate)
  };
}

// ---- moving the date --------------------------------------------------------------------------------------------------------------

export interface DateChange {
  key: string;
  title: string;
  taskId: string;
  from: string | null;
  to: string;
  /** The new date is before today. */
  past: boolean;
  /** The new date is earlier than an item it waits for (templates with odd offsets). */
  beforeDependency: string | null;
}
export interface DateProposalRecord {
  id: string;
  planId: string;
  fromDate: string;
  newDate: string;
  changes: DateChange[];
  state: 'open' | 'applied' | 'rejected';
  reason: string;
  proposedBy: string;
  proposedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
}
interface ProposalRow extends Omit<DateProposalRecord, 'changes'> {
  changes: string;
}
const DCOLS = `id, plan_id AS planId, from_date AS fromDate, new_date AS newDate, changes, state, reason, proposed_by AS proposedBy, proposed_at AS proposedAt, decided_by AS decidedBy, decided_at AS decidedAt`;
const toProposal = (r: ProposalRow): DateProposalRecord => ({ ...r, changes: JSON.parse(r.changes) as DateChange[] });
export async function getDateProposal(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<DateProposalRecord | null> {
  const r = await db.first<ProposalRow>(`SELECT ${DCOLS} FROM date_proposal WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
  return r ? toProposal(r) : null;
}
export async function dateProposalsOf(db: Db, c: Pick<Ctx, 'studioId'>, planId: string): Promise<DateProposalRecord[]> {
  return (await db.all<ProposalRow>(`SELECT ${DCOLS} FROM date_proposal WHERE plan_id = ? AND studio_id = ? ORDER BY proposed_at, rowid`, [planId, c.studioId])).map(toProposal);
}

/** "Move the release to this day": lists each open item's old and new due date; done items keep theirs. Changes nothing. */
export async function proposeDate(db: Db, c: Ctx, planId: string, newDate: string, reason = ''): Promise<DateProposalRecord> {
  const plan = await getPlan(db, c, planId);
  if (!plan) return fail('not-found', 'That plan is not there.');
  if (plan.state === 'cancelled' || plan.state === 'reviewed') return fail('conflict', `That plan is ${plan.state}.`);
  const to = cleanDay(newDate, 'The new release date');
  if (to === plan.releaseDate) return fail('invalid', 'That is the release date already.');
  if ((await dateProposalsOf(db, c, planId)).some((p) => p.state === 'open')) return fail('exists', 'A change of date is already waiting for a decision.');
  const items = await itemsOf(db, planId);
  const tasks = new Map<string, TaskRecord>();
  for (const it of items) {
    const t = await getTask(db, c, it.taskId);
    if (t) tasks.set(it.key, t);
  }
  const newDue = new Map(items.map((it) => [it.key, addDays(to, it.offsetDays)]));
  const keyOfTask = new Map(items.map((it) => [it.taskId, it.key]));
  const changes: DateChange[] = [];
  for (const it of items) {
    const t = tasks.get(it.key);
    if (!t || t.state !== 'open') continue; // done and cancelled items are history
    const toDay = newDue.get(it.key)!;
    const dep = t.dependsOn.map((d) => keyOfTask.get(d)).find((k) => k && tasks.get(k)?.state === 'open' && newDue.get(k)! > toDay);
    changes.push({ key: it.key, title: t.title, taskId: t.id, from: t.due, to: toDay, past: toDay < c.now.slice(0, 10), beforeDependency: dep ? tasks.get(dep)!.title : null });
  }
  const id = newRecordId();
  await db.batch([
    { sql: "INSERT INTO date_proposal (id, studio_id, plan_id, from_date, new_date, changes, state, reason, proposed_by, proposed_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)", params: [id, c.studioId, planId, plan.releaseDate, to, JSON.stringify(changes), clean(reason, 'The reason', 500, false), c.actor, c.now] },
    audit(c, 'launch.date_propose', planId, { from: plan.releaseDate, to })
  ]);
  return (await getDateProposal(db, c, id))!;
}

/** Applies a proposal in one batch: the plan's date and every listed task's due date. A plan that was approved goes back to draft (it has changed). */
export async function applyDateProposal(db: Db, c: Ctx, id: string): Promise<{ proposal: DateProposalRecord; plan: ReleasePlan }> {
  const p = await getDateProposal(db, c, id);
  if (!p) return fail('not-found', 'That change of date is not there.');
  if (p.state !== 'open') return fail('conflict', `That change of date has already been ${p.state}.`);
  const plan = (await getPlan(db, c, p.planId))!;
  if (plan.releaseDate !== p.fromDate) return fail('conflict', 'The release date was changed since this was proposed. Propose it again.');
  await db.batch([
    ...p.changes.map((ch) => ({ sql: "UPDATE task SET due = ?, updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ? AND state = 'open'", params: [ch.to, c.now, c.actor, ch.taskId, c.studioId] })),
    { sql: `UPDATE release_plan SET release_date = ?, updated_at = ?${plan.state === 'approved' ? ", state = 'draft'" : ''} WHERE id = ? AND studio_id = ?`, params: [p.newDate, c.now, p.planId, c.studioId] },
    { sql: "UPDATE date_proposal SET state = 'applied', decided_by = ?, decided_at = ? WHERE id = ? AND state = 'open'", params: [c.actor, c.now, id] },
    audit(c, 'launch.date_apply', p.planId, { from: p.fromDate, to: p.newDate, items: p.changes.length })
  ]);
  return { proposal: (await getDateProposal(db, c, id))!, plan: (await getPlan(db, c, p.planId))! };
}
export async function rejectDateProposal(db: Db, c: Ctx, id: string, reason: string): Promise<DateProposalRecord> {
  const p = await getDateProposal(db, c, id);
  if (!p) return fail('not-found', 'That change of date is not there.');
  if (p.state !== 'open') return fail('conflict', `That change of date has already been ${p.state}.`);
  await db.batch([{ sql: "UPDATE date_proposal SET state = 'rejected', reason = ?, decided_by = ?, decided_at = ? WHERE id = ? AND state = 'open'", params: [clean(reason, 'The reason', 500), c.actor, c.now, id] }, audit(c, 'launch.date_reject', p.planId, {})]);
  return (await getDateProposal(db, c, id))!;
}

// ---- approval and the states ---------------------------------------------------------------------------------------------------------

/** Go/no-go on an exact revision. `revision` must be the plan's revision now: someone who approved a plan that has since changed is refused. */
export async function approvePlan(db: Db, c: Ctx, planId: string, revision: string, facts: { item: PlanItem; task: TaskRecord }[]): Promise<ReleasePlan> {
  const plan = await getPlan(db, c, planId);
  if (!plan) return fail('not-found', 'That plan is not there.');
  if (plan.state !== 'draft' && plan.state !== 'approved') return fail('conflict', `That plan is ${plan.state}.`);
  const now = planRevision(plan, facts);
  if (revision !== now) return fail('conflict', 'The plan changed since you looked at it. Look again, then approve.');
  await db.batch([
    { sql: "UPDATE release_plan SET state = 'approved', approved_revision = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND studio_id = ?", params: [now, c.actor, c.now, c.now, planId, c.studioId] },
    audit(c, 'launch.plan_approve', planId, { revision: now })
  ]);
  return (await getPlan(db, c, planId))!;
}
/** The release happens: needs a plan approved at its current revision. */
export async function goLive(db: Db, c: Ctx, planId: string, facts: { item: PlanItem; task: TaskRecord }[]): Promise<ReleasePlan> {
  const plan = await getPlan(db, c, planId);
  if (!plan) return fail('not-found', 'That plan is not there.');
  if (plan.state === 'live') return plan;
  if (plan.state !== 'approved') return fail('conflict', plan.state === 'draft' ? 'The plan has not been approved.' : `That plan is ${plan.state}.`);
  if (plan.approvedRevision !== planRevision(plan, facts)) return fail('conflict', 'The plan changed after it was approved. It needs approving again.');
  await db.batch([{ sql: "UPDATE release_plan SET state = 'live', live_at = ?, updated_at = ? WHERE id = ? AND studio_id = ?", params: [c.now, c.now, planId, c.studioId] }, audit(c, 'launch.plan_live', planId, {})]);
  return (await getPlan(db, c, planId))!;
}
export async function cancelPlan(db: Db, c: Ctx, planId: string, reason: string): Promise<ReleasePlan> {
  const plan = await getPlan(db, c, planId);
  if (!plan) return fail('not-found', 'That plan is not there.');
  if (plan.state === 'cancelled') return plan;
  if (plan.state === 'reviewed') return fail('conflict', 'That plan has been reviewed.');
  const why = clean(reason, 'The reason', 500);
  const items = await itemsOf(db, planId);
  const stmts: { sql: string; params?: unknown[] }[] = [];
  for (const it of items) {
    const t = await getTask(db, c, it.taskId);
    if (t?.state === 'open') stmts.push({ sql: "UPDATE task SET state = 'cancelled', updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ?", params: [c.now, c.actor, t.id, c.studioId] });
  }
  await db.batch([...stmts, { sql: "UPDATE release_plan SET state = 'cancelled', updated_at = ? WHERE id = ? AND studio_id = ?", params: [c.now, planId, c.studioId] }, audit(c, 'launch.plan_cancel', planId, { reason: why })]);
  return (await getPlan(db, c, planId))!;
}
/** Marks a manual item's task done (or open again): the same as on the task, with the plan's audit row. */
export async function markItem(db: Db, c: Ctx, planId: string, key: string, done: boolean): Promise<PlanItem> {
  const it = (await itemsOf(db, planId)).find((x) => x.key === key);
  if (!it) return fail('not-found', 'That item is not in the plan.');
  await setTaskState(db, c, it.taskId, done ? 'done' : 'open');
  await db.run('INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)', [c.now, c.actor, 'launch.item_mark', planId, JSON.stringify({ key, done })]);
  return it;
}
/** Reassigns an item's task (to a person, or to no one). */
export async function assignItem(db: Db, c: Ctx, planId: string, key: string, personId: string | null): Promise<void> {
  const it = (await itemsOf(db, planId)).find((x) => x.key === key);
  if (!it) return fail('not-found', 'That item is not in the plan.');
  await updateTask(db, c, it.taskId, { assigneeId: personId });
}

/** What a workflow gate sees: for the live plans of these projects, how many required items are late or blocked. */
export interface LaunchFacts {
  plans: number;
  late: number;
  blocked: number;
}
export function launchFactsOf(views: PlanView[]): LaunchFacts {
  let late = 0;
  let blocked = 0;
  for (const v of views) for (const i of v.items) if (i.item.required) (i.status === 'late' && late++, i.status === 'blocked' && blocked++);
  return { plans: views.length, late, blocked };
}
