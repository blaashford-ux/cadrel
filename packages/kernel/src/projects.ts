/**
 * Projects: the one structure everything in Cadrel hangs from. A project can hold subprojects, to any depth, and
 * carries no fixed meaning: a studio will usually make a Series a project and each Book a subproject of it, but a
 * standalone novel, a box set, an anthology or "Marketing 2027" fit the same shape.
 *
 * Modules do not own projects. They are linked to one: a Write manuscript folder, a Market category, later a cover
 * brief or a royalty statement. Notes and (with the vault) permission scopes attach to projects the same way.
 *
 * Everything here is pure: functions take a tree and return a new one (or throw `ProjectError`), so the desktop app,
 * the MCP server and the Worker can share it.
 */

export const PROJECT_TREE_VERSION = 1;

export const NAME_MAX = 120;
export const KIND_MAX = 30;
/** Offered in the kind picker; any text is allowed. */
export const KIND_SUGGESTIONS = ['Series', 'Book', 'Standalone', 'Box set', 'Anthology', 'Campaign'];

export type ProjectStatus = 'active' | 'archived';

export interface Project {
  id: string;
  /** Null at the top level. */
  parentId: string | null;
  name: string;
  /** A free label ("Series", "Book"); empty means the app shows "Project" or "Subproject" by position. */
  kind: string;
  status: ProjectStatus;
  /** Position among its siblings. */
  order: number;
  /**
   * The workflow this project's stages come from: chosen when the project is made and never changed (a project made before workflows
   * existed gets one once, when it is first opened by a version that has them). Null only until then.
   */
  workflowId: string | null;
  /** The key of the stage it is in, in `workflowId`'s workflow. Changed only by `setProjectStage`, which the app gates. */
  stage: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A module's record that belongs to a project: `module` is the module id, `ref` is that module's own name for it. */
export interface ProjectLink {
  projectId: string;
  module: string;
  ref: string;
}

export interface ProjectTree {
  projects: Project[];
  links: ProjectLink[];
}

export class ProjectError extends Error {}

export const emptyTree = (): ProjectTree => ({ projects: [], links: [] });

const fail = (m: string): never => {
  throw new ProjectError(m);
};

export function newId(prefix = 'p'): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const rnd = (c?.randomUUID?.() ?? `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`).replace(/-/g, '');
  return `${prefix}_${rnd.slice(0, 12)}`;
}

/** One line, trimmed, within the limit. */
export function cleanName(raw: unknown, what = 'name', max = NAME_MAX): string {
  const t = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!t) return fail(`A project needs a ${what}.`);
  return t.slice(0, max).trim();
}

export function cleanKind(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, KIND_MAX).trim() : '';
}

// ---- reading the tree -------------------------------------------------------------------------

export const getProject = (t: ProjectTree, id: string): Project | undefined => t.projects.find((p) => p.id === id);

function need(t: ProjectTree, id: string): Project {
  return getProject(t, id) ?? fail(`There is no project "${id}".`);
}

export function childrenOf(t: ProjectTree, parentId: string | null): Project[] {
  return t.projects.filter((p) => p.parentId === parentId).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** Every project below `id`, nearest first (breadth-first). */
export function descendantsOf(t: ProjectTree, id: string): Project[] {
  const out: Project[] = [];
  let level = childrenOf(t, id);
  while (level.length) {
    out.push(...level);
    level = level.flatMap((p) => childrenOf(t, p.id));
  }
  return out;
}

/** From the top-level project down to the parent of `id`. */
export function ancestorsOf(t: ProjectTree, id: string): Project[] {
  const out: Project[] = [];
  for (let p = getProject(t, id); p?.parentId; ) {
    p = getProject(t, p.parentId);
    if (p) out.unshift(p);
  }
  return out;
}

/** "Dragon Rider / Book 1". */
export function pathOf(t: ProjectTree, id: string): string {
  const p = need(t, id);
  return [...ancestorsOf(t, id), p].map((x) => x.name).join(' / ');
}

export interface OutlineRow {
  project: Project;
  depth: number;
  hasChildren: boolean;
}

/** The tree flattened top to bottom for display, each row with its depth. Archived projects are left out unless asked for. */
export function outline(t: ProjectTree, o: { archived?: boolean } = {}): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const p of childrenOf(t, parent)) {
      if (p.status === 'archived' && !o.archived) continue;
      rows.push({ project: p, depth, hasChildren: childrenOf(t, p.id).some((c) => o.archived || c.status !== 'archived') });
      walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/** The label to show for a project's kind. */
export function kindLabel(t: ProjectTree, p: Project): string {
  return p.kind || (p.parentId ? 'Subproject' : 'Project');
}

/** `id` and everything below it: the set a "this project, including its books" query means. */
export function subtreeIds(t: ProjectTree, id: string): string[] {
  return [id, ...descendantsOf(t, id).map((p) => p.id)];
}

// ---- changing the tree ------------------------------------------------------------------------

function siblingNameTaken(t: ProjectTree, parentId: string | null, name: string, except?: string): boolean {
  const n = name.toLowerCase();
  return t.projects.some((p) => p.parentId === parentId && p.id !== except && p.name.toLowerCase() === n);
}

export interface NewProject {
  name: string;
  parentId?: string | null;
  kind?: string;
  id?: string;
  now?: string;
  /** The workflow it lives by, and the stage it starts in. Set here, once: nothing changes the workflow afterwards. */
  workflowId?: string | null;
  stage?: string | null;
}

export function createProject(t: ProjectTree, o: NewProject): { tree: ProjectTree; project: Project } {
  const name = cleanName(o.name);
  const parentId = o.parentId ?? null;
  if (parentId !== null && need(t, parentId).status === 'archived') fail('That project is archived; restore it before adding to it.');
  if (siblingNameTaken(t, parentId, name)) fail(`"${name}" already exists here.`);
  const now = o.now ?? new Date().toISOString();
  const order = childrenOf(t, parentId).reduce((m, p) => Math.max(m, p.order + 1), 0);
  const workflowId = o.workflowId ?? null;
  const stage = workflowId ? cleanStageKey(o.stage) : null;
  if (workflowId && !stage) fail('A project made with a workflow starts in one of its stages.');
  const project: Project = { id: o.id ?? newId(), parentId, name, kind: cleanKind(o.kind), status: 'active', order, workflowId, stage, createdAt: now, updatedAt: now };
  return { tree: { ...t, projects: [...t.projects, project] }, project };
}

const cleanStageKey = (v: unknown): string | null => (typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(v) ? v : null);

const touch = (p: Project, change: Partial<Project>, now = new Date().toISOString()): Project => ({ ...p, ...change, updatedAt: now });

export function updateProject(t: ProjectTree, id: string, change: { name?: string; kind?: string }): ProjectTree {
  const p = need(t, id);
  const next: Partial<Project> = {};
  if (change.name !== undefined) {
    next.name = cleanName(change.name);
    if (siblingNameTaken(t, p.parentId, next.name, id)) fail(`"${next.name}" already exists here.`);
  }
  if (change.kind !== undefined) next.kind = cleanKind(change.kind);
  return { ...t, projects: t.projects.map((x) => (x.id === id ? touch(x, next) : x)) };
}

/**
 * Puts a project in another stage of its own workflow. The tree does not know the workflow, so the caller has already checked that the
 * stage exists and that the move is allowed (the gates); this only refuses a project that has no workflow.
 */
export function setProjectStage(t: ProjectTree, id: string, stage: string, now?: string): ProjectTree {
  const p = need(t, id);
  if (!p.workflowId) fail(`"${p.name}" has no workflow yet.`);
  const key = cleanStageKey(stage);
  if (!key) fail('That is not a stage.');
  return { ...t, projects: t.projects.map((x) => (x.id === id ? touch(x, { stage: key }, now) : x)) };
}

/**
 * The one time a project that has no workflow (made before workflows existed) is given one. A project that already has one cannot be
 * given another: the workflow is chosen at creation and stays.
 */
export function adoptWorkflow(t: ProjectTree, id: string, workflowId: string, stage: string, now?: string): ProjectTree {
  const p = need(t, id);
  if (p.workflowId) fail(`"${p.name}" already has a workflow, and it cannot be changed.`);
  const key = cleanStageKey(stage);
  if (!workflowId || !key) fail('A workflow and one of its stages are needed.');
  return { ...t, projects: t.projects.map((x) => (x.id === id ? touch(x, { workflowId, stage: key }, now) : x)) };
}

/**
 * Moves a project under another (or to the top level with `parentId` null), optionally to a position among its new
 * siblings. A project cannot go under itself or anything below it.
 */
export function moveProject(t: ProjectTree, id: string, parentId: string | null, index?: number): ProjectTree {
  const p = need(t, id);
  if (parentId !== null) {
    const target = need(t, parentId);
    if (subtreeIds(t, id).includes(parentId)) fail('A project cannot be moved into itself or into one of its own subprojects.');
    if (target.status === 'archived') fail('That project is archived; restore it before moving things into it.');
  }
  if (siblingNameTaken(t, parentId, p.name, id)) fail(`"${p.name}" already exists there.`);
  const siblings = childrenOf(t, parentId).filter((x) => x.id !== id);
  const at = Math.max(0, Math.min(index ?? siblings.length, siblings.length));
  siblings.splice(at, 0, p);
  const order = new Map(siblings.map((s, i) => [s.id, i]));
  return {
    ...t,
    projects: t.projects.map((x) => (x.id === id ? touch(x, { parentId, order: order.get(id)! }) : order.has(x.id) && x.parentId === parentId ? { ...x, order: order.get(x.id)! } : x))
  };
}

/** Archiving a project archives everything under it; restoring brings back only that project (its parent must be active). */
export function setArchived(t: ProjectTree, id: string, archived: boolean): ProjectTree {
  const p = need(t, id);
  if (!archived && p.parentId && need(t, p.parentId).status === 'archived') fail('Restore the parent project first.');
  const ids = new Set(archived ? subtreeIds(t, id) : [id]);
  return { ...t, projects: t.projects.map((x) => (ids.has(x.id) ? touch(x, { status: archived ? 'archived' : 'active' }) : x)) };
}

/** Deletes a project. Subprojects are only deleted along with it when `cascade` is set. Returns the ids that went. */
export function deleteProject(t: ProjectTree, id: string, o: { cascade?: boolean } = {}): { tree: ProjectTree; removed: string[] } {
  need(t, id);
  const kids = descendantsOf(t, id);
  if (kids.length && !o.cascade) fail(`"${getProject(t, id)!.name}" has ${kids.length} subproject${kids.length === 1 ? '' : 's'}; delete them too, or move them first.`);
  const gone = new Set([id, ...kids.map((k) => k.id)]);
  return { tree: { projects: t.projects.filter((p) => !gone.has(p.id)), links: t.links.filter((l) => !gone.has(l.projectId)) }, removed: [...gone] };
}

// ---- links to modules -------------------------------------------------------------------------

export function linksOf(t: ProjectTree, projectId: string, module?: string): ProjectLink[] {
  return t.links.filter((l) => l.projectId === projectId && (!module || l.module === module));
}

/** The project a module's record belongs to, if any. */
export function projectFor(t: ProjectTree, module: string, ref: string): Project | undefined {
  const l = t.links.find((x) => x.module === module && x.ref === ref);
  return l && getProject(t, l.projectId);
}

/** A record belongs to one project: linking it again moves it. */
export function linkRecord(t: ProjectTree, projectId: string, module: string, ref: string): ProjectTree {
  need(t, projectId);
  const m = module.trim(), r = ref.trim();
  if (!m || !r) fail('A link needs a module and a record.');
  return { ...t, links: [...t.links.filter((l) => !(l.module === m && l.ref === r)), { projectId, module: m, ref: r }] };
}

export function unlinkRecord(t: ProjectTree, module: string, ref: string): ProjectTree {
  return { ...t, links: t.links.filter((l) => !(l.module === module && l.ref === ref)) };
}

/** A module record was renamed (Write renames a folder, for instance): keep it linked. */
export function relinkRecord(t: ProjectTree, module: string, from: string, to: string): ProjectTree {
  return { ...t, links: t.links.map((l) => (l.module === module && l.ref === from ? { ...l, ref: to } : l)) };
}

// ---- reading what is on disk --------------------------------------------------------------------

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * Makes sense of whatever a file holds: a damaged or hand-edited tree must never stop the app starting. Malformed
 * entries are dropped, a project whose parent is missing goes to the top level, and a cycle is cut.
 */
export function sanitizeTree(raw: unknown): ProjectTree {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { projects?: unknown; links?: unknown };
  const seen = new Set<string>();
  const projects: Project[] = [];
  for (const x of Array.isArray(r.projects) ? r.projects : []) {
    const p = x as Partial<Project> | null;
    if (!p || !isStr(p.id) || !isStr(p.name) || seen.has(p.id)) continue;
    seen.add(p.id);
    const now = new Date(0).toISOString();
    projects.push({
      id: p.id,
      parentId: isStr(p.parentId) ? p.parentId : null,
      name: p.name.slice(0, NAME_MAX),
      kind: cleanKind(p.kind),
      status: p.status === 'archived' ? 'archived' : 'active',
      order: Number.isFinite(p.order) ? (p.order as number) : 0,
      workflowId: isStr(p.workflowId) ? p.workflowId : null,
      stage: isStr(p.workflowId) && cleanStageKey(p.stage) ? (p.stage as string) : null,
      createdAt: isStr(p.createdAt) ? p.createdAt : now,
      updatedAt: isStr(p.updatedAt) ? p.updatedAt : isStr(p.createdAt) ? p.createdAt : now
    });
  }
  const byId = new Map(projects.map((p) => [p.id, p]));
  for (const p of projects) {
    if (p.parentId !== null && !byId.has(p.parentId)) p.parentId = null;
  }
  for (const p of projects) {
    const path = new Set<string>([p.id]);
    for (let q = p; q.parentId !== null; q = byId.get(q.parentId)!) {
      if (path.has(q.parentId)) {
        q.parentId = null;
        break;
      }
      path.add(q.parentId);
    }
  }
  const links: ProjectLink[] = [];
  const claimed = new Set<string>();
  for (const x of Array.isArray(r.links) ? r.links : []) {
    const l = x as Partial<ProjectLink> | null;
    if (!l || !isStr(l.projectId) || !isStr(l.module) || !isStr(l.ref) || !byId.has(l.projectId)) continue;
    const key = `${l.module}\u0000${l.ref}`;
    if (claimed.has(key)) continue;
    claimed.add(key);
    links.push({ projectId: l.projectId, module: l.module, ref: l.ref });
  }
  return { projects, links };
}

/** The scope path a permission check needs for a project: the studio, then each project from the top down to it. */
export function scopePathFor(t: ProjectTree, projectId: string, studioId = 'studio'): { kind: 'studio' | 'project'; id: string }[] {
  need(t, projectId);
  return [{ kind: 'studio', id: studioId }, ...ancestorsOf(t, projectId).map((p) => ({ kind: 'project' as const, id: p.id })), { kind: 'project', id: projectId }];
}
