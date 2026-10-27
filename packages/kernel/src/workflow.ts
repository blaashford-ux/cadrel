/**
 * Workflows: the stages a book moves through and the gates between them, as data an administrator builds. Records and rules over the
 * kernel's async `Db`, in the shape of the catalogue: every change is one batch with its audit row, and nothing here decides who may build
 * a workflow or move a book (the service checks `can` first); it does decide whether a move is *allowed by the workflow*.
 *
 * A **stage** has a stable key (used by books), a name, a category and a colour. A **transition** is a way from one stage to another; its
 * **gate** is the roles allowed to make the move and a list of **conditions** on the book that must all hold. Both are editable. The shipped
 * default is MDEdit's own list (Planning, Drafting, Revising, Editing, Published, On hold), with every move open, as it was there.
 */
import { newRecordId } from './ids';
import { EDITION_FORMATS, type Ctx } from './catalogue';
import type { Db } from './vault';

export type WorkflowCode = 'invalid' | 'exists' | 'not-found' | 'conflict' | 'gated';
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

/** What a gate can ask of a book. Each is checked from the catalogue, so it can be answered now. */
export const CONDITION_KINDS = {
  edition: 'The book has at least one edition',
  asin: 'An edition has an ASIN',
  isbn: 'An edition has an ISBN',
  published_date: 'An edition has a publication date',
  series: 'The book is in a series',
  pen_name: 'The book has a pen name'
} as const;
export type ConditionKind = keyof typeof CONDITION_KINDS;
export interface Condition {
  kind: ConditionKind;
  /** For the edition checks: only this format counts. */
  format?: string;
}

export interface Stage { key: string; name: string; category: StageCategory; color: string; position: number }
export interface Transition { from: string; to: string; roleIds: string[]; conditions: Condition[] }
export interface WorkflowRecord {
  id: string;
  studioId: string;
  name: string;
  description: string;
  isDefault: boolean;
  templateKey: string | null;
  stages: Stage[];
  transitions: Transition[];
  /** Live books in this workflow. */
  books: number;
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
  /** For a stage the draft removes: where the books in it go. */
  moveBooks?: Record<string, string>;
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
    const format = (c as Condition).format;
    if (format !== undefined && format !== '') {
      if (!['edition', 'asin', 'isbn', 'published_date'].includes(kind)) fail('invalid', `${CONDITION_KINDS[kind]} does not depend on a format.`);
      if (!(EDITION_FORMATS as readonly string[]).includes(format)) fail('invalid', `${format} is not an edition format.`);
    }
    if (!out.some((x) => x.kind === kind && (x.format ?? '') === (format ?? ''))) out.push({ kind, ...(format ? { format } : {}) });
  }
  return out;
}

// ---- reading -----------------------------------------------------------------------------------------------------------------

interface WfRow { id: string; studioId: string; name: string; description: string; isDefault: number; templateKey: string | null; createdAt: string; updatedAt: string }

export async function listWorkflows(db: Db, c: Pick<Ctx, 'studioId'>): Promise<WorkflowRecord[]> {
  const rows = await db.all<WfRow>('SELECT id, studio_id AS studioId, name, description, is_default AS isDefault, template_key AS templateKey, created_at AS createdAt, updated_at AS updatedAt FROM workflow WHERE studio_id = ? ORDER BY is_default DESC, lower(name)', [c.studioId]);
  if (!rows.length) return [];
  const stages = await db.all<Stage & { workflowId: string }>('SELECT workflow_id AS workflowId, key, name, position, category, color FROM workflow_stage ORDER BY position');
  const trans = await db.all<{ id: string; workflowId: string; from: string; to: string; conditions: string }>('SELECT id, workflow_id AS workflowId, from_key AS "from", to_key AS "to", conditions FROM workflow_transition ORDER BY id');
  const roles = await db.all<{ transitionId: string; roleId: string }>('SELECT transition_id AS transitionId, role_id AS roleId FROM workflow_transition_role ORDER BY role_id');
  const counts = await db.all<{ workflowId: string; n: number }>('SELECT workflow_id AS workflowId, COUNT(*) AS n FROM book WHERE studio_id = ? AND archived_at IS NULL AND workflow_id IS NOT NULL GROUP BY workflow_id', [c.studioId]);
  return rows.map((r) => ({
    id: r.id, studioId: r.studioId, name: r.name, description: r.description, isDefault: !!r.isDefault, templateKey: r.templateKey, createdAt: r.createdAt, updatedAt: r.updatedAt,
    stages: stages.filter((s) => s.workflowId === r.id).map(({ key, name, category, color, position }) => ({ key, name, category, color, position })),
    transitions: trans.filter((t) => t.workflowId === r.id).map((t) => ({ from: t.from, to: t.to, roleIds: roles.filter((x) => x.transitionId === t.id).map((x) => x.roleId), conditions: JSON.parse(t.conditions) as Condition[] })),
    books: counts.find((n) => n.workflowId === r.id)?.n ?? 0
  }));
}
export async function getWorkflow(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<WorkflowRecord | null> {
  return (await listWorkflows(db, c)).find((w) => w.id === id) ?? null;
}
export async function defaultWorkflow(db: Db, c: Pick<Ctx, 'studioId'>): Promise<WorkflowRecord | null> {
  return (await listWorkflows(db, c)).find((w) => w.isDefault) ?? null;
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
 * Makes the shipped default (MDEdit's stages, every move open) if the studio has no workflow at all, and makes it the default. A studio
 * that already has workflows is left alone, so one an administrator deleted or replaced does not come back.
 */
export async function ensureDefaultWorkflow(db: Db, c: Ctx): Promise<boolean> {
  if ((await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM workflow WHERE studio_id = ?', [c.studioId]))!.n > 0) return false;
  const id = 'workflow_default';
  const stages = MDEDIT_STAGES.map((s, i) => ({ ...s, position: i }));
  await write(db, [
    { sql: 'INSERT INTO workflow (id, studio_id, name, description, is_default, template_key, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?)', params: [id, c.studioId, 'Writing and publishing', 'The stages from MDEdit: Planning, Drafting, Revising, Editing, Published and On hold. Any stage can move to any other.', 1, 'mdedit', c.now, c.actor, c.now, c.actor] },
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
    { sql: 'INSERT INTO workflow (id, studio_id, name, description, is_default, template_key, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,0,NULL,?,?,?,?)', params: [id, c.studioId, name, description, c.now, c.actor, c.now, c.actor] },
    ...insertDefinition(c, id, stages, transitions),
    audit(c, 'workflow.create', id, { name, copyFrom: input?.copyFrom ?? null })
  ], `There is already a workflow called “${name}”.`);
  return (await getWorkflow(db, c, id))!;
}

/**
 * Saves a workflow's whole definition. Stages keep their keys (a new one gets a key from its name), so renaming or reordering moves no
 * book; a stage that is dropped while books are in it needs `moveBooks` to say where they go. Roles named in gates must exist.
 */
export async function saveWorkflow(db: Db, c: Ctx, id: string, draft: WorkflowDraft): Promise<WorkflowRecord> {
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

  // dropped stages: the books in them must be told where to go
  const dropped = cur.stages.filter((s) => !taken.has(s.key));
  const moves: { sql: string; params?: unknown[] }[] = [];
  for (const s of dropped) {
    const n = (await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM book WHERE workflow_id = ? AND stage = ? AND archived_at IS NULL', [id, s.key]))!.n;
    const to = draft.moveBooks?.[s.key];
    if (n > 0 && !to) fail('conflict', `${n} book${n === 1 ? ' is' : 's are'} in “${s.name}”. Choose a stage to move ${n === 1 ? 'it' : 'them'} to before removing it.`);
    if (to && !taken.has(to)) fail('invalid', 'Books can only move to a stage that stays in the workflow.');
    if (to) moves.push({ sql: 'UPDATE book SET stage = ?, updated_at = ?, updated_by = ? WHERE workflow_id = ? AND stage = ?', params: [to, c.now, c.actor, id, s.key] });
  }

  await write(db, [
    { sql: 'DELETE FROM workflow_transition_role WHERE transition_id IN (SELECT id FROM workflow_transition WHERE workflow_id = ?)', params: [id] },
    { sql: 'DELETE FROM workflow_transition WHERE workflow_id = ?', params: [id] },
    ...moves,
    { sql: 'DELETE FROM workflow_stage WHERE workflow_id = ?', params: [id] },
    { sql: 'UPDATE workflow SET name = ?, description = ?, updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ?', params: [name, description, c.now, c.actor, id, c.studioId] },
    ...insertDefinition(c, id, stages, transitions),
    audit(c, 'workflow.save', id, { name, stages: stages.map((s) => s.key), dropped: dropped.map((s) => s.key), transitions: transitions.length })
  ], `There is already a workflow called “${name}”.`);
  return (await getWorkflow(db, c, id))!;
}

export async function setDefaultWorkflow(db: Db, c: Ctx, id: string): Promise<WorkflowRecord> {
  if (!(await getWorkflow(db, c, id))) return fail('not-found', 'That workflow is not there.');
  await write(db, [
    { sql: 'UPDATE workflow SET is_default = 0 WHERE studio_id = ? AND is_default = 1', params: [c.studioId] },
    { sql: 'UPDATE workflow SET is_default = 1, updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ?', params: [c.now, c.actor, id, c.studioId] },
    audit(c, 'workflow.default', id, {})
  ], 'There is already a default workflow.');
  return (await getWorkflow(db, c, id))!;
}

/** Not the default (make another the default first), and not one that books are still in. */
export async function deleteWorkflow(db: Db, c: Ctx, id: string): Promise<void> {
  const w = await getWorkflow(db, c, id);
  if (!w) return fail('not-found', 'That workflow is not there.');
  if (w.isDefault) fail('conflict', 'This is the default workflow. Make another the default first.');
  const used = (await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM book WHERE workflow_id = ?', [id]))!.n;
  if (used) fail('conflict', `${used} book${used === 1 ? ' is' : 's are'} in this workflow. Move ${used === 1 ? 'it' : 'them'} to another workflow first.`);
  await write(db, [
    { sql: 'DELETE FROM workflow_transition_role WHERE transition_id IN (SELECT id FROM workflow_transition WHERE workflow_id = ?)', params: [id] },
    { sql: 'DELETE FROM workflow_transition WHERE workflow_id = ?', params: [id] },
    { sql: 'DELETE FROM workflow_stage WHERE workflow_id = ?', params: [id] },
    { sql: 'DELETE FROM workflow WHERE id = ? AND studio_id = ?', params: [id, c.studioId] },
    audit(c, 'workflow.delete', id, { name: w.name })
  ], '');
}

// ---- moving a book -----------------------------------------------------------------------------------------------------------

interface BookFacts { id: string; seriesId: string | null; penName: string; stage: string; workflowId: string | null; archivedAt: string | null; editions: { format: string; asin: string | null; isbn: string | null; publishedOn: string | null }[] }

async function facts(db: Db, c: Pick<Ctx, 'studioId'>, bookId: string): Promise<BookFacts | null> {
  const b = await db.first<Omit<BookFacts, 'editions'>>('SELECT id, series_id AS seriesId, pen_name AS penName, stage, workflow_id AS workflowId, archived_at AS archivedAt FROM book WHERE id = ? AND studio_id = ?', [bookId, c.studioId]);
  if (!b) return null;
  const editions = await db.all<BookFacts['editions'][number]>('SELECT format, asin, isbn, published_on AS publishedOn FROM edition WHERE book_id = ? AND archived_at IS NULL', [bookId]);
  return { ...b, editions };
}

/** The conditions that do not hold for a book, in words. Empty means the gate is open on the book's side. */
export function unmetConditions(book: Pick<BookFacts, 'seriesId' | 'penName' | 'editions'>, conditions: Condition[]): string[] {
  const out: string[] = [];
  for (const cond of conditions) {
    const eds = cond.format ? book.editions.filter((e) => e.format === cond.format) : book.editions;
    const of = cond.format ? ` on the ${cond.format} edition` : '';
    const ok =
      cond.kind === 'edition' ? eds.length > 0
      : cond.kind === 'asin' ? eds.some((e) => e.asin)
      : cond.kind === 'isbn' ? eds.some((e) => e.isbn)
      : cond.kind === 'published_date' ? eds.some((e) => e.publishedOn)
      : cond.kind === 'series' ? !!book.seriesId
      : !!book.penName.trim();
    if (!ok) out.push(cond.kind === 'edition' ? `${CONDITION_KINDS.edition}${of}` : `${CONDITION_KINDS[cond.kind]}${of}`);
  }
  return out;
}

export interface StageOption { key: string; name: string; category: StageCategory; color: string; allowed: boolean; /** Why not, when it is not allowed. */ reasons: string[] }

/** Where a book can go from its current stage, and for each, whether it may now and what is in the way. `holdsRole` says whether the person holds any of the given roles. */
export async function stageOptions(db: Db, c: Pick<Ctx, 'studioId'>, bookId: string, holdsRole: (roleIds: string[]) => boolean): Promise<{ workflow: WorkflowRecord | null; current: Stage | null; options: StageOption[] }> {
  const book = await facts(db, c, bookId);
  if (!book) return fail('not-found', 'That book is not there.');
  const workflows = await listWorkflows(db, c);
  const wf = workflows.find((w) => w.id === book.workflowId) ?? workflows.find((w) => w.isDefault) ?? null;
  if (!wf) return { workflow: null, current: null, options: [] };
  const current = wf.stages.find((s) => s.key === book.stage) ?? null;
  const options = wf.transitions.filter((t) => t.from === book.stage).map((t): StageOption => {
    const to = wf.stages.find((s) => s.key === t.to)!;
    const reasons = unmetConditions(book, t.conditions);
    if (t.roleIds.length && !holdsRole(t.roleIds)) reasons.push('Only people with certain roles can make this move');
    return { key: to.key, name: to.name, category: to.category, color: to.color, allowed: reasons.length === 0, reasons };
  });
  return { workflow: wf, current, options: options.sort((a, b) => (wf.stages.find((s) => s.key === a.key)!.position - wf.stages.find((s) => s.key === b.key)!.position)) };
}

/** Moves a book to another stage if its workflow has that move and the gate is open: the book's conditions hold and the person holds one of the gate's roles. */
export async function setBookStage(db: Db, c: Ctx, bookId: string, toKey: string, holdsRole: (roleIds: string[]) => boolean): Promise<{ from: string; to: string; workflowId: string }> {
  const book = await facts(db, c, bookId);
  if (!book) return fail('not-found', 'That book is not there.');
  if (book.archivedAt) fail('conflict', 'That book is archived. Restore it first.');
  const { workflow: wf, options, current } = await stageOptions(db, c, bookId, holdsRole);
  if (!wf) return fail('conflict', 'There is no workflow yet. An administrator builds one under Admin.');
  if (toKey === book.stage && current) return fail('invalid', `The book is already in ${current.name}.`);
  const opt = options.find((o) => o.key === toKey);
  if (!opt) {
    const target = wf.stages.find((s) => s.key === toKey);
    return fail('gated', target ? `This workflow has no move from ${current?.name ?? book.stage} to ${target.name}.` : 'That stage is not in the book’s workflow.');
  }
  if (!opt.allowed) fail('gated', `${opt.name} is not open yet: ${opt.reasons.join('; ')}.`, opt.reasons);
  await write(db, [
    { sql: 'UPDATE book SET stage = ?, workflow_id = ?, updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ?', params: [toKey, wf.id, c.now, c.actor, bookId, c.studioId] },
    audit(c, 'catalogue.book.stage', bookId, { from: book.stage, to: toKey, workflowId: wf.id })
  ], '');
  return { from: book.stage, to: toKey, workflowId: wf.id };
}
