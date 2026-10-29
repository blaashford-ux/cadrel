/**
 * Workflows: the stages a project moves through and the gates between them, as data an administrator builds. Records and rules over the
 * kernel's async `Db`: every change is one batch with its audit row, and nothing here decides who may build a workflow or move a project
 * (the service checks `can` first); it does decide whether a move is *allowed by the workflow*.
 *
 * A **stage** has a stable key (projects hold it), a name, a category and a colour. A **transition** is a way from one stage to another;
 * its **gate** is the roles allowed to make the move and a list of **conditions** on the project that must all hold. Several workflows
 * exist side by side: each project is given one when it is made and keeps it, so a Series and its Books can live by different ones. A
 * studio has a default workflow for new projects and one for new subprojects. The shipped default is MDEdit's own stage list
 * (Planning, Drafting, Revising, Editing, Published, On hold) with every move open, as it was there.
 *
 * Projects live in the project tree (a file), not in this database, so what a project looks like to a gate is passed in as `ProjectFacts`
 * and how many projects use a workflow or stage is passed in by the caller.
 */
import { newRecordId } from './ids';
import type { Ctx } from './catalogue';
import type { Db } from './vault';

export type WorkflowCode = 'invalid' | 'exists' | 'not-found' | 'conflict' | 'gated';

/** The two places a new project can be made: at the top (a Series, a standalone book) or inside another (a Book in a Series). */
export const PROJECT_LEVELS = ['project', 'subproject'] as const;
export type ProjectLevel = (typeof PROJECT_LEVELS)[number];
export class WorkflowError extends Error {
  constructor(readonly code: WorkflowCode, message: string, /** For a gated move: every reason it cannot be made. */ readonly reasons: string[] = []) {
    super(message);
  }
}
const fail = (code: WorkflowCode, m: string, reasons: string[] = []): never => {
  throw new WorkflowError(code, m, reasons);
};

export const STAGE_CATEGORIES = ['start', 'active', 'review', 'done', 'hold'] as const;
export type StageCategory = (typeof STAGE_CATEGORIES)[number];

/** MDEdit's statuses, in its order, with the names it shows. A test keeps these equal to Write's own list. */
export const MDEDIT_STAGES: { key: string; name: string; category: StageCategory; color: string }[] = [
  { key: 'planning', name: 'Planning', category: 'start', color: '#7a8b99' },
  { key: 'drafting', name: 'Drafting', category: 'active', color: '#3f7cac' },
  { key: 'revising', name: 'Revising', category: 'active', color: '#8a6fb5' },
  { key: 'editing', name: 'Editing', category: 'review', color: '#c58b2a' },
  { key: 'published', name: 'Published', category: 'done', color: '#3d8b5a' },
  { key: 'paused', name: 'On hold', category: 'hold', color: '#a65b5b' }
];

/** What a gate can ask of a project. Each is answered from the project tree and its notes, so it can be checked now. */
export const CONDITION_KINDS = {
  has_manuscript: 'A manuscript is linked to it',
  no_open_notes: 'It and its subprojects have no open notes',
  has_subprojects: 'It has at least one subproject',
  subprojects_done: 'Every subproject has reached a Done stage',
  no_open_tasks: 'It and its subprojects have no open tasks',
  approved: 'It has been signed off'
} as const;
export type ConditionKind = keyof typeof CONDITION_KINDS;
export interface Condition {
  kind: ConditionKind;
  /** For `approved`: the label of the sign-off that must stand ("Cover approved"). */
  label?: string;
}

export interface Stage { key: string; name: string; category: StageCategory; color: string; position: number }
export interface Transition { from: string; to: string; roleIds: string[]; conditions: Condition[] }
export interface WorkflowRecord {
  id: string;
  studioId: string;
  name: string;
  description: string;
  /** Which new projects start in it: at the top level, inside another project, both, or neither. */
  defaultFor: ProjectLevel[];
  templateKey: string | null;
  stages: Stage[];
  transitions: Transition[];
  createdAt: string;
  updatedAt: string;
}
/** What the builder sends back: the whole definition, saved in one go. A stage without a key is new. */
export interface WorkflowDraft {
  name: string;
  description?: string;
  /** A key that is already in the workflow keeps that stage; a new stage may bring its own key (so moves can name it) or get one from its name. */
  stages: { key?: string | null; name: string; category?: string; color?: string }[];
  transitions: { from: string; to: string; roleIds?: string[]; conditions?: Condition[] }[];
  /** For a stage the draft removes that projects are in: the stage they move to (the caller moves them). */
  moveProjects?: Record<string, string>;
}

const audit = (c: Ctx, action: string, target: string, detail: unknown) => ({
  sql: 'INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)',
  params: [c.now, c.actor, action, target, JSON.stringify(detail)]
});

async function write(db: Db, stmts: { sql: string; params?: unknown[] }[], onUnique: string): Promise<void> {
  try {
    await db.batch(stmts);
  } catch (e) {
    const m = String((e as Error)?.message ?? e);
    if (/UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(m)) fail('exists', onUnique);
    if (/FOREIGN KEY/i.test(m)) fail('not-found', 'Something this refers to is not there any more.');
    throw e;
  }
}

// ---- validation -------------------------------------------------------------------------------------------------------------

function cleanName(v: unknown, what: string): string {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (!s) return fail('invalid', `${what} needs a name.`);
  return s.length > 60 ? fail('invalid', `${what} name is too long (60 characters at most).`) : s;
}
const slug = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'stage';
const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The key a new stage gets from its name, different from every key in `taken`. The builder uses this too, so a draft can name a stage in its moves before it is saved. */
export function newStageKey(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slug(name);
  let key = base;
  for (let n = 2; used.has(key); n++) key = `${base}-${n}`;
  return key;
}
const cleanColor = (v: unknown): string => (v === undefined || v === null || v === '' ? '' : typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : fail('invalid', 'A colour is written #3f7cac.'));
const cleanCategory = (v: unknown): StageCategory => (v === undefined ? 'active' : (STAGE_CATEGORIES as readonly string[]).includes(v as string) ? (v as StageCategory) : fail('invalid', `A stage category is one of: ${STAGE_CATEGORIES.join(', ')}.`));

export function cleanConditions(raw: unknown): Condition[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return fail('invalid', 'Conditions are a list.');
  const out: Condition[] = [];
  for (const c of raw) {
    const kind = (c as Condition)?.kind;
    if (!kind || !Object.hasOwn(CONDITION_KINDS, kind)) return fail('invalid', `${String(kind)} is not a condition a gate can check.`);
    if (kind === 'approved') {
      const label = typeof (c as Condition).label === 'string' ? (c as Condition).label!.trim().replace(/\s+/g, ' ') : '';
      if (!label) return fail('invalid', 'A sign-off gate needs the label of the approval it asks for.');
      if (label.length > 40) return fail('invalid', 'A sign-off label is 40 characters at most.');
      if (!out.some((x) => x.kind === kind && x.label!.toLowerCase() === label.toLowerCase())) out.push({ kind, label });
    } else if (!out.some((x) => x.kind === kind)) out.push({ kind });
  }
  return out;
}

// ---- reading -----------------------------------------------------------------------------------------------------------------

interface WfRow { id: string; studioId: string; name: string; description: string; defaultProject: number; defaultSubproject: number; templateKey: string | null; createdAt: string; updatedAt: string }

export async function listWorkflows(db: Db, c: Pick<Ctx, 'studioId'>): Promise<WorkflowRecord[]> {
  const rows = await db.all<WfRow>('SELECT id, studio_id AS studioId, name, description, default_project AS defaultProject, default_subproject AS defaultSubproject, template_key AS templateKey, created_at AS createdAt, updated_at AS updatedAt FROM workflow WHERE studio_id = ? ORDER BY default_project DESC, default_subproject DESC, lower(name)', [c.studioId]);
  if (!rows.length) return [];
  const stages = await db.all<Stage & { workflowId: string }>('SELECT workflow_id AS workflowId, key, name, position, category, color FROM workflow_stage ORDER BY position');
  const trans = await db.all<{ id: string; workflowId: string; from: string; to: string; conditions: string }>('SELECT id, workflow_id AS workflowId, from_key AS "from", to_key AS "to", conditions FROM workflow_transition ORDER BY id');
  const roles = await db.all<{ transitionId: string; roleId: string }>('SELECT transition_id AS transitionId, role_id AS roleId FROM workflow_transition_role ORDER BY role_id');
  return rows.map((r) => ({
    id: r.id, studioId: r.studioId, name: r.name, description: r.description, templateKey: r.templateKey, createdAt: r.createdAt, updatedAt: r.updatedAt,
    defaultFor: [...(r.defaultProject ? ['project' as const] : []), ...(r.defaultSubproject ? ['subproject' as const] : [])],
    stages: stages.filter((s) => s.workflowId === r.id).map(({ key, name, category, color, position }) => ({ key, name, category, color, position })),
    transitions: trans.filter((t) => t.workflowId === r.id).map((t) => ({ from: t.from, to: t.to, roleIds: roles.filter((x) => x.transitionId === t.id).map((x) => x.roleId), conditions: JSON.parse(t.conditions) as Condition[] }))
  }));
}
export async function getWorkflow(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<WorkflowRecord | null> {
  return (await listWorkflows(db, c)).find((w) => w.id === id) ?? null;
}
/** The workflow a new project (or subproject) starts in. */
export async function defaultWorkflow(db: Db, c: Pick<Ctx, 'studioId'>, level: ProjectLevel = 'project'): Promise<WorkflowRecord | null> {
  return (await listWorkflows(db, c)).find((w) => w.defaultFor.includes(level)) ?? null;
}

// ---- building ----------------------------------------------------------------------------------------------------------------

function insertDefinition(c: Ctx, workflowId: string, stages: Stage[], transitions: Transition[]) {
  const out: { sql: string; params?: unknown[] }[] = [];
  for (const s of stages) out.push({ sql: 'INSERT INTO workflow_stage (workflow_id, key, name, position, category, color) VALUES (?,?,?,?,?,?)', params: [workflowId, s.key, s.name, s.position, s.category, s.color] });
  for (const t of transitions) {
    const id = newRecordId();
    out.push({ sql: 'INSERT INTO workflow_transition (id, workflow_id, from_key, to_key, conditions) VALUES (?,?,?,?,?)', params: [id, workflowId, t.from, t.to, JSON.stringify(t.conditions)] });
    for (const r of t.roleIds) out.push({ sql: 'INSERT INTO workflow_transition_role (transition_id, role_id) VALUES (?, ?)', params: [id, r] });
  }
  void c;
  return out;
}

/** Every stage open to every other: how MDEdit's statuses behave. */
const openMoves = (keys: string[]): Transition[] => keys.flatMap((from) => keys.filter((to) => to !== from).map((to) => ({ from, to, roleIds: [], conditions: [] })));

/**
 * Makes the shipped default (MDEdit's stages, every move open) if the studio has no workflow at all, and makes it the default for projects and subprojects. A studio
 * that already has workflows is left alone, so one an administrator deleted or replaced does not come back.
 */
export async function ensureDefaultWorkflow(db: Db, c: Ctx): Promise<boolean> {
  if ((await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM workflow WHERE studio_id = ?', [c.studioId]))!.n > 0) return false;
  const id = 'workflow_default';
  const stages = MDEDIT_STAGES.map((s, i) => ({ ...s, position: i }));
  await write(db, [
    { sql: 'INSERT INTO workflow (id, studio_id, name, description, default_project, default_subproject, template_key, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,1,1,?,?,?,?,?)', params: [id, c.studioId, 'Writing and publishing', 'The stages from MDEdit: Planning, Drafting, Revising, Editing, Published and On hold. Any stage can move to any other.', 'mdedit', c.now, c.actor, c.now, c.actor] },
    ...insertDefinition(c, id, stages, openMoves(stages.map((s) => s.key))),
    audit(c, 'workflow.defaults', id, { stages: stages.map((s) => s.key) })
  ], 'There is already a workflow with that name.');
  return true;
}

/** A new workflow: a copy of another, or a blank one with a single stage to start from. It is not the default until it is made so. */
export async function createWorkflow(db: Db, c: Ctx, input: { name: string; description?: string; copyFrom?: string }): Promise<WorkflowRecord> {
  const name = cleanName(input?.name, 'A workflow');
  const description = typeof input?.description === 'string' ? input.description.trim().slice(0, 500) : '';
  let stages: Stage[] = [{ key: 'start', name: 'Start', category: 'start', color: '', position: 0 }];
  let transitions: Transition[] = [];
  if (input?.copyFrom) {
    const src = await getWorkflow(db, c, input.copyFrom);
    if (!src) return fail('not-found', 'The workflow to copy is not there.');
    stages = src.stages;
    transitions = src.transitions;
  }
  const id = newRecordId();
  await write(db, [
    { sql: 'INSERT INTO workflow (id, studio_id, name, description, default_project, default_subproject, template_key, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,0,0,NULL,?,?,?,?)', params: [id, c.studioId, name, description, c.now, c.actor, c.now, c.actor] },
    ...insertDefinition(c, id, stages, transitions),
    audit(c, 'workflow.create', id, { name, copyFrom: input?.copyFrom ?? null })
  ], `There is already a workflow called “${name}”.`);
  return (await getWorkflow(db, c, id))!;
}

/** How many projects are in each stage of a workflow, and how many use it at all. Projects are in the project tree, so the caller counts them. */
export interface WorkflowUsage {
  projects: number;
  byStage: Record<string, number>;
}

/**
 * Saves a workflow's whole definition. Stages keep their keys (a new one gets a key from its name), so renaming or reordering moves no
 * project; a stage that is dropped while projects are in it needs `moveProjects` to say where they go (the caller moves them: the tree is
 * a file, not this database). Roles named in gates must exist.
 */
export async function saveWorkflow(db: Db, c: Ctx, id: string, draft: WorkflowDraft, usage?: WorkflowUsage): Promise<WorkflowRecord> {
  const cur = await getWorkflow(db, c, id);
  if (!cur) return fail('not-found', 'That workflow is not there.');
  const name = cleanName(draft?.name, 'A workflow');
  const description = typeof draft?.description === 'string' ? draft.description.trim().slice(0, 500) : cur.description;
  if (!Array.isArray(draft?.stages) || draft.stages.length === 0) fail('invalid', 'A workflow needs at least one stage.');
  if (draft.stages.length > 30) fail('invalid', 'A workflow can have 30 stages at most.');

  const taken = new Set<string>();
  const names = new Set<string>();
  const stages: Stage[] = draft.stages.map((s, i) => {
    const sname = cleanName(s?.name, 'A stage');
    if (names.has(sname.toLowerCase())) fail('invalid', `Two stages are called “${sname}”.`);
    names.add(sname.toLowerCase());
    // a key that exists is that stage, kept; one that does not is a new stage with that key; none at all gets one from its name
    let key = typeof s.key === 'string' && s.key ? s.key : '';
    if (key && !KEY.test(key)) fail('invalid', 'A stage key is lower-case letters, digits and hyphens.');
    if (!key) key = newStageKey(sname, [...taken, ...cur.stages.map((x) => x.key)]);
    if (taken.has(key)) fail('invalid', 'A stage appears twice.');
    taken.add(key);
    return { key, name: sname, category: cleanCategory(s.category), color: cleanColor(s.color), position: i };
  });

  const seen = new Set<string>();
  const roleIds = new Set<string>();
  const transitions: Transition[] = (draft.transitions ?? []).map((t) => {
    if (!taken.has(t?.from) || !taken.has(t?.to)) fail('invalid', 'A move goes between stages that are in the workflow.');
    if (t.from === t.to) fail('invalid', 'A stage cannot move to itself.');
    const k = `${t.from}>${t.to}`;
    if (seen.has(k)) fail('invalid', 'The same move is listed twice.');
    seen.add(k);
    const rids = [...new Set(t.roleIds ?? [])];
    rids.forEach((r) => roleIds.add(r));
    return { from: t.from, to: t.to, roleIds: rids, conditions: cleanConditions(t.conditions) };
  });
  for (const r of roleIds) if (!(await db.first('SELECT 1 FROM role WHERE id = ? AND studio_id = ?', [r, c.studioId]))) fail('not-found', 'A role in a gate is not there any more.');

  // dropped stages: the projects in them must be told where to go
  const dropped = cur.stages.filter((s) => !taken.has(s.key));
  for (const s of dropped) {
    const n = usage?.byStage[s.key] ?? 0;
    const to = draft.moveProjects?.[s.key];
    if (n > 0 && !to) fail('conflict', `${n} project${n === 1 ? ' is' : 's are'} in “${s.name}”. Choose a stage to move ${n === 1 ? 'it' : 'them'} to before removing it.`);
    if (to && !taken.has(to)) fail('invalid', 'Projects can only move to a stage that stays in the workflow.');
  }

  await write(db, [
    { sql: 'DELETE FROM workflow_transition_role WHERE transition_id IN (SELECT id FROM workflow_transition WHERE workflow_id = ?)', params: [id] },
    { sql: 'DELETE FROM workflow_transition WHERE workflow_id = ?', params: [id] },
    { sql: 'DELETE FROM workflow_stage WHERE workflow_id = ?', params: [id] },
    { sql: 'UPDATE workflow SET name = ?, description = ?, updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ?', params: [name, description, c.now, c.actor, id, c.studioId] },
    ...insertDefinition(c, id, stages, transitions),
    audit(c, 'workflow.save', id, { name, stages: stages.map((s) => s.key), dropped: dropped.map((s) => s.key), transitions: transitions.length })
  ], `There is already a workflow called “${name}”.`);
  return (await getWorkflow(db, c, id))!;
}

/** Makes a workflow the one new projects, new subprojects, or both start in. A studio has exactly one for each. */
export async function setDefaultWorkflow(db: Db, c: Ctx, id: string, levels: readonly ProjectLevel[] = PROJECT_LEVELS): Promise<WorkflowRecord> {
  if (!(await getWorkflow(db, c, id))) return fail('not-found', 'That workflow is not there.');
  const chosen = [...new Set(levels)];
  if (!chosen.length || chosen.some((l) => !(PROJECT_LEVELS as readonly string[]).includes(l))) fail('invalid', 'Choose projects, subprojects or both.');
  const column = (l: ProjectLevel) => (l === 'project' ? 'default_project' : 'default_subproject');
  await write(db, [
    ...chosen.flatMap((l) => [
      { sql: `UPDATE workflow SET ${column(l)} = 0 WHERE studio_id = ? AND ${column(l)} = 1`, params: [c.studioId] },
      { sql: `UPDATE workflow SET ${column(l)} = 1, updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ?`, params: [c.now, c.actor, id, c.studioId] }
    ]),
    audit(c, 'workflow.default', id, { levels: chosen })
  ], 'There is already a default workflow.');
  return (await getWorkflow(db, c, id))!;
}

/** Not a default for projects or subprojects (make another the default first), and not one that projects use. */
export async function deleteWorkflow(db: Db, c: Ctx, id: string, usage?: WorkflowUsage): Promise<void> {
  const w = await getWorkflow(db, c, id);
  if (!w) return fail('not-found', 'That workflow is not there.');
  if (w.defaultFor.length) fail('conflict', `This is the default for new ${w.defaultFor.length === 2 ? 'projects and subprojects' : w.defaultFor[0] === 'project' ? 'projects' : 'subprojects'}. Make another workflow the default first.`);
  const used = usage?.projects ?? 0;
  if (used) fail('conflict', `${used} project${used === 1 ? ' uses' : 's use'} this workflow. A project keeps the workflow it was made with, so it cannot be deleted while any project uses it.`);
  await write(db, [
    { sql: 'DELETE FROM workflow_transition_role WHERE transition_id IN (SELECT id FROM workflow_transition WHERE workflow_id = ?)', params: [id] },
    { sql: 'DELETE FROM workflow_transition WHERE workflow_id = ?', params: [id] },
    { sql: 'DELETE FROM workflow_stage WHERE workflow_id = ?', params: [id] },
    { sql: 'DELETE FROM workflow WHERE id = ? AND studio_id = ?', params: [id, c.studioId] },
    audit(c, 'workflow.delete', id, { name: w.name })
  ], '');
}

// ---- moving a project --------------------------------------------------------------------------------------------------------

/**
 * What a gate can see of a project. The project tree is a file, so the caller builds this from it (and from the notes and the
 * subprojects' own workflows) and passes it in; this file stays pure.
 */
export interface ProjectFacts {
  /** A Write manuscript (or any manuscript link) is attached. */
  hasManuscript: boolean;
  /** Open notes on the project and everything under it. */
  openNotes: number;
  /** The category of each live subproject's current stage; null for one that has no workflow yet. */
  subprojects: (StageCategory | null)[];
  /** Open tasks on the project and everything under it. */
  openTasks: number;
  /** The labels of the sign-offs the project currently stands approved under. */
  approved: string[];
}

/** The conditions that do not hold for a project, in words. Empty means the gate is open on the project's side. */
export function unmetConditions(facts: ProjectFacts, conditions: Condition[]): string[] {
  const out: string[] = [];
  for (const { kind, label } of conditions) {
    if (kind === 'approved') {
      if (!facts.approved.some((l) => l.toLowerCase() === (label ?? '').toLowerCase())) out.push(`Needs sign-off: “${label}”`);
      continue;
    }
    const ok =
      kind === 'has_manuscript' ? facts.hasManuscript
      : kind === 'no_open_notes' ? facts.openNotes === 0
      : kind === 'no_open_tasks' ? facts.openTasks === 0
      : kind === 'has_subprojects' ? facts.subprojects.length > 0
      : facts.subprojects.length > 0 && facts.subprojects.every((c) => c === 'done'); // subprojects_done: nothing to be done is not done
    if (ok) continue;
    if (kind === 'no_open_notes' && facts.openNotes > 0) out.push(`${facts.openNotes} open note${facts.openNotes === 1 ? '' : 's'} to resolve first (${CONDITION_KINDS.no_open_notes.toLowerCase()})`);
    else if (kind === 'no_open_tasks') out.push(`${facts.openTasks} open task${facts.openTasks === 1 ? '' : 's'} to finish first (${CONDITION_KINDS.no_open_tasks.toLowerCase()})`);
    else out.push(CONDITION_KINDS[kind]);
  }
  return out;
}

export interface StageOption { key: string; name: string; category: StageCategory; color: string; allowed: boolean; /** Why not, when it is not allowed. */ reasons: string[] }

/** Where a project in stage `current` of `wf` can go, and for each move whether it is open now and what is in the way. `holdsRole` says whether the person holds any of the given roles. */
export function stageOptions(wf: WorkflowRecord, current: string | null, facts: ProjectFacts, holdsRole: (roleIds: string[]) => boolean): { current: Stage | null; options: StageOption[] } {
  const here = wf.stages.find((s) => s.key === current) ?? null;
  const options = wf.transitions.filter((t) => t.from === current).map((t): StageOption => {
    const to = wf.stages.find((s) => s.key === t.to)!;
    const reasons = unmetConditions(facts, t.conditions);
    if (t.roleIds.length && !holdsRole(t.roleIds)) reasons.push('Only people with certain roles can make this move');
    return { key: to.key, name: to.name, category: to.category, color: to.color, allowed: reasons.length === 0, reasons };
  });
  const pos = (k: string) => wf.stages.find((s) => s.key === k)!.position;
  return { current: here, options: options.sort((a, b) => pos(a.key) - pos(b.key)) };
}

/** Throws (code `gated`, with every reason) unless a project in stage `from` may move to `to` under this workflow. */
export function checkMove(wf: WorkflowRecord, from: string | null, to: string, facts: ProjectFacts, holdsRole: (roleIds: string[]) => boolean): void {
  const { current, options } = stageOptions(wf, from, facts, holdsRole);
  if (from === to && current) fail('invalid', `It is already in ${current.name}.`);
  const opt = options.find((o) => o.key === to);
  if (!opt) {
    const target = wf.stages.find((s) => s.key === to);
    return fail('gated', target ? `${wf.name} has no move from ${current?.name ?? from ?? 'here'} to ${target.name}.` : 'That stage is not in this project’s workflow.');
  }
  if (!opt.allowed) fail('gated', `${opt.name} is not open yet: ${opt.reasons.join('; ')}.`, opt.reasons);
}

/** The stage a new project starts in: the first one. */
export const initialStage = (wf: WorkflowRecord): string => wf.stages[0]!.key;
