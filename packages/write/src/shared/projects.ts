import { defaultAppDefaults, type AppDefaults } from './appDefaults';
import { clampLevel } from './chapters';
import { applyOverrides, diffOverrides, overridesFromLegacyBook, projectLayer, sanitizeOverrides, type Overrides } from './export/layers';
import { sanitizeBookDetails, type BookDetails } from './export/model';
import { isDate, sanitizeGoal, type Goal } from './progress';
import { validateName } from './paths';

/**
 * Projects: a folder inside the Root Folder that carries `.mdedit/project.json`. Everything here is pure
 * (models, defensive parsing, templates, name rules); the file-system side lives in electron/projects.ts.
 */

export const PROJECT_DIR = '.mdedit';
export const PROJECT_FILE = 'project.json';
export const PROGRESS_FILE = 'progress.json';

export const STATUSES = ['planning', 'drafting', 'revising', 'editing', 'published', 'paused'] as const;
export type ProjectStatus = (typeof STATUSES)[number];
export const STATUS_LABELS: Record<ProjectStatus, string> = {
  planning: 'Planning',
  drafting: 'Drafting',
  revising: 'Revising',
  editing: 'Editing',
  published: 'Published',
  paused: 'On hold'
};

// ---- templates -----------------------------------------------------------------------------

export interface FolderNode {
  name: string;
  /** Do the words in this folder (and below) count toward the project's word-count goal? */
  counts: boolean;
  children: FolderNode[];
}

export interface StarterFile {
  /** Relative path inside the project, "/" separated (e.g. "Manuscript/Draft.md"). */
  path: string;
  content: string;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  folders: FolderNode[];
  files: StarterFile[];
  /** Chapter heading level for projects made from this template (null = use the app setting). */
  chapterLevel: number | null;
  /** Book defaults (author, copyright page, front/back matter, export choices…) (null = use the app defaults). */
  book: BookDetails | null;
}

export const MAX_FOLDER_DEPTH = 6;
export const MAX_TEMPLATE_FOLDERS = 200;

const folder = (name: string, counts = false, children: FolderNode[] = []): FolderNode => ({ name, counts, children });

/** The templates that ship with the app (editable; "Reset" brings them back). */
export function defaultTemplates(): ProjectTemplate[] {
  const t = (id: string, name: string, description: string, folders: FolderNode[], files: StarterFile[] = []): ProjectTemplate => ({
    id,
    name,
    description,
    folders,
    files,
    chapterLevel: null,
    book: null
  });
  return [
    t(
      'novel',
      'Novel',
      'One book: manuscript, characters, worldbuilding, research and exports.',
      [folder('Manuscript', true), folder('Characters'), folder('Worldbuilding'), folder('Research'), folder('Exports')],
      [{ path: 'Manuscript/Draft.md', content: '# Chapter 1\n\n' }]
    ),
    t(
      'series',
      'Series',
      'Several books in one project: a Manuscripts folder for the books, and a series bible.',
      [folder('Manuscripts', true), folder('Series Bible'), folder('Characters'), folder('Research'), folder('Exports')],
      [{ path: 'Series Bible/Series Bible.md', content: '# Series Bible\n\n' }]
    ),
    t('short-story', 'Short Story', 'A short story: drafts, notes and exports.', [folder('Drafts', true), folder('Notes'), folder('Exports')], [
      { path: 'Drafts/Draft.md', content: '# Title\n\n' }
    ]),
    t('blank', 'Blank', 'An empty project. Everything counts toward the goal.', [])
  ];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f]/g;
const text = (v: unknown, d: string, max: number) => (typeof v === 'string' ? v.replace(CTRL, ' ').trim().slice(0, max) : d);
const longText = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\u0000/g, '').slice(0, max) : '');

function sanitizeFolders(v: unknown, depth = 1): FolderNode[] {
  if (!Array.isArray(v) || depth > MAX_FOLDER_DEPTH) return [];
  return v
    .filter(isObj)
    .slice(0, 100)
    .map((n) => ({
      name: text(n.name, '', 100),
      counts: typeof n.counts === 'boolean' ? n.counts : true,
      children: sanitizeFolders(n.children, depth + 1)
    }))
    .filter((n) => n.name !== '');
}

const safeRelPath = (p: string) => p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && validateName(seg) === null);

export function sanitizeTemplate(raw: unknown): ProjectTemplate | null {
  if (!isObj(raw)) return null;
  const id = text(raw.id, '', 60).replace(/[^\w-]/g, '-');
  const name = text(raw.name, '', 80);
  if (!id || !name) return null;
  const files = Array.isArray(raw.files)
    ? raw.files
        .filter(isObj)
        .slice(0, 100)
        .map((f) => ({ path: text(f.path, '', 400).replace(/\\/g, '/'), content: longText(f.content, 200_000) }))
        .filter((f) => f.path !== '' && safeRelPath(f.path))
    : [];
  return {
    id,
    name,
    description: text(raw.description, '', 300),
    folders: sanitizeFolders(raw.folders),
    files,
    chapterLevel: raw.chapterLevel === null || raw.chapterLevel === undefined ? null : clampLevel(raw.chapterLevel),
    book: isObj(raw.book) ? sanitizeBookDetails(raw.book) : null
  };
}

/** A usable list: bad entries dropped, ids made unique, never empty (falls back to the built-ins). */
export function sanitizeTemplates(raw: unknown): ProjectTemplate[] {
  const list = Array.isArray(raw) ? raw.map(sanitizeTemplate).filter((t): t is ProjectTemplate => t !== null) : [];
  const seen = new Set<string>();
  const out: ProjectTemplate[] = [];
  for (const t of list.slice(0, 50)) {
    let id = t.id;
    for (let n = 2; seen.has(id); n++) id = `${t.id}-${n}`;
    seen.add(id);
    out.push({ ...t, id });
  }
  return out.length ? out : defaultTemplates();
}

/** Every folder path a template makes ("Manuscript", "Manuscript/Part 1", …) in creation order. */
export function flattenFolders(nodes: FolderNode[], prefix = ''): string[] {
  return nodes.flatMap((n) => {
    const p = prefix ? `${prefix}/${n.name}` : n.name;
    return [p, ...flattenFolders(n.children, p)];
  });
}

/** The folder paths that do NOT count toward the goal. */
export function uncountedFolders(nodes: FolderNode[], prefix = '', inherited = true): string[] {
  return nodes.flatMap((n) => {
    const p = prefix ? `${prefix}/${n.name}` : n.name;
    const counts = inherited && n.counts;
    return [...(counts ? [] : [p]), ...uncountedFolders(n.children, p, counts)];
  }).filter((p, _i, all) => !all.some((o) => o !== p && p.startsWith(o + '/'))); // a parent already excludes its children
}

/** Problems that would stop a template from being used; empty means fine. */
export function templateErrors(t: ProjectTemplate): string[] {
  const errors: string[] = [];
  if (!t.name.trim()) errors.push('The template needs a name.');
  const check = (nodes: FolderNode[], where: string, depth: number) => {
    if (depth > MAX_FOLDER_DEPTH) errors.push(`Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep.`);
    const seen = new Set<string>();
    for (const n of nodes) {
      const err = validateName(n.name);
      if (err) errors.push(`${where}“${n.name || '(empty)'}”: ${err}`);
      const key = n.name.trim().toLowerCase();
      if (seen.has(key)) errors.push(`${where}“${n.name}” appears twice.`);
      seen.add(key);
      check(n.children, `${where}${n.name}/`, depth + 1);
    }
  };
  check(t.folders, '', 1);
  if (flattenFolders(t.folders).length > MAX_TEMPLATE_FOLDERS) errors.push(`A template can have at most ${MAX_TEMPLATE_FOLDERS} folders.`);
  for (const f of t.files) if (!safeRelPath(f.path)) errors.push(`Starter file “${f.path}” has an invalid path.`);
  return errors;
}

// ---- project metadata ----------------------------------------------------------------------

export interface ProjectOverrides {
  /** null = use the app's chapter heading level. */
  chapterLevel: number | null;
  /** The book fields this project sets itself (field path → value); every other field follows the app. */
  book: Overrides;
}

export interface ProjectMeta {
  version: 1;
  id: string;
  name: string;
  templateId: string;
  templateName: string;
  createdAt: string;
  status: ProjectStatus;
  notes: string;
  archived: boolean;
  /** The project-wide goal, used when no manuscript is active. */
  goal: Goal | null;
  /** The one manuscript (file, relative to the project, "/" separated) that goals and progress follow; null = the whole project. */
  activeManuscript: string | null;
  /** A goal per manuscript, keyed by its relative path. */
  manuscriptGoals: Record<string, Goal>;
  /** Folders (relative, "/" separated) whose words do not count toward the goal. */
  excludedFolders: string[];
  /** Chapters marked as edited, per file (relative path): the chapter ids from `chapterIds`. Kept whatever the project's status. */
  editedChapters: Record<string, string[]>;
  overrides: ProjectOverrides;
}

/** What a template's book changes relative to the app. A year that is just the date it was made, or blank, isn't a choice. */
function templateOverrides(book: BookDetails, app: AppDefaults, now: Date): Overrides {
  const out = projectLayer(diffOverrides(app.book, book));
  const year = book.copyright.year.trim();
  if (year === '' || year === String(now.getFullYear())) delete out['copyright.year'];
  return out;
}

/** `app` is what a template's book is compared with: only what the template changes becomes a project override. */
export function newProjectMeta(opts: { id: string; name: string; template: ProjectTemplate; now: Date; app?: AppDefaults }): ProjectMeta {
  const { template: t } = opts;
  return {
    version: 1,
    id: opts.id,
    name: opts.name,
    templateId: t.id,
    templateName: t.name,
    createdAt: opts.now.toISOString(),
    status: 'planning',
    notes: '',
    archived: false,
    goal: null,
    activeManuscript: null,
    manuscriptGoals: {},
    excludedFolders: uncountedFolders(t.folders),
    editedChapters: {},
    overrides: { chapterLevel: t.chapterLevel, book: t.book ? templateOverrides(t.book, opts.app ?? defaultAppDefaults(), opts.now) : {} }
  };
}

export function sanitizeProjectMeta(raw: unknown, fallbackName: string, today: string): ProjectMeta {
  const r = isObj(raw) ? raw : {};
  const o = isObj(r.overrides) ? r.overrides : {};
  const name = text(r.name, fallbackName, 200) || fallbackName;
  return {
    version: 1,
    id: text(r.id, '', 80) || `p-${Math.abs(hash(name))}`,
    name,
    templateId: text(r.templateId, 'blank', 60),
    templateName: text(r.templateName, 'Blank', 80),
    createdAt: typeof r.createdAt === 'string' && !Number.isNaN(Date.parse(r.createdAt)) ? r.createdAt : new Date(0).toISOString(),
    status: (STATUSES as readonly string[]).includes(r.status as string) ? (r.status as ProjectStatus) : 'planning',
    notes: longText(r.notes, 5000),
    archived: r.archived === true,
    goal: sanitizeGoal(r.goal, today),
    activeManuscript: typeof r.activeManuscript === 'string' && safeRelPath(r.activeManuscript.replace(/\\/g, '/')) ? r.activeManuscript.replace(/\\/g, '/') : null,
    manuscriptGoals: sanitizeManuscriptGoals(r.manuscriptGoals, today),
    excludedFolders: Array.isArray(r.excludedFolders)
      ? r.excludedFolders.filter((x): x is string => typeof x === 'string' && safeRelPath(x.replace(/\\/g, '/'))).map((x) => x.replace(/\\/g, '/')).slice(0, 200)
      : [],
    editedChapters: sanitizeEditedChapters(r.editedChapters),
    overrides: {
      chapterLevel: o.chapterLevel === null || o.chapterLevel === undefined ? null : clampLevel(o.chapterLevel),
      // projects saved before layering held a whole book (or null for "use the app's")
      book: isObj(o.book) ? (isObj(o.book.copyright) ? overridesFromLegacyBook(o.book) : projectLayer(sanitizeOverrides(o.book))) : {}
    }
  };
}

function sanitizeManuscriptGoals(raw: unknown, today: string): Record<string, Goal> {
  const out: Record<string, Goal> = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw).slice(0, 200)) {
    const key = k.replace(/\\/g, '/');
    const g = sanitizeGoal(v, today);
    if (g && safeRelPath(key)) out[key] = g;
  }
  return out;
}

function sanitizeEditedChapters(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!isObj(raw)) return out;
  for (const [file, ids] of Object.entries(raw).slice(0, 2000)) {
    const key = file.replace(/\\/g, '/');
    if (!safeRelPath(key) || !Array.isArray(ids)) continue;
    const clean = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length <= 500))].slice(0, 2000);
    if (clean.length) out[key] = clean;
  }
  return out;
}

/**
 * A stable id for each chapter of a file: its title, with later chapters of the same title told apart by their order.
 * Unlike a position it survives chapters being moved around the file.
 */
export function chapterIds(chapters: readonly { title: string }[]): string[] {
  const seen = new Map<string, number>();
  return chapters.map((c) => {
    const n = seen.get(c.title) ?? 0;
    seen.set(c.title, n + 1);
    return n === 0 ? c.title : `${c.title}\u0001${n + 1}`;
  });
}

export const isChapterEdited = (meta: Pick<ProjectMeta, 'editedChapters'>, file: string, id: string): boolean => meta.editedChapters[file]?.includes(id) ?? false;

/** The edited-chapter record with `id` marked (or unmarked) in `file`; the input is not changed. */
export function withChapterEdited(edited: Record<string, string[]>, file: string, id: string, on: boolean): Record<string, string[]> {
  const rest = (edited[file] ?? []).filter((x) => x !== id);
  const next = { ...edited };
  const ids = on ? [...rest, id] : rest;
  if (ids.length) next[file] = ids;
  else delete next[file];
  return next;
}

/** The goal that applies now: the active manuscript's own goal. Without an active manuscript there is none (goals are kept per manuscript). */
export function goalFor(meta: Pick<ProjectMeta, 'goal' | 'activeManuscript' | 'manuscriptGoals'>): Goal | null {
  return meta.activeManuscript ? (meta.manuscriptGoals[meta.activeManuscript] ?? null) : null;
}

/** The same metadata with the applicable goal replaced (null removes it). */
export function withGoal<T extends Pick<ProjectMeta, 'goal' | 'activeManuscript' | 'manuscriptGoals'>>(meta: T, goal: Goal | null): T {
  if (!meta.activeManuscript) return { ...meta, goal };
  const goals = { ...meta.manuscriptGoals };
  if (goal) goals[meta.activeManuscript] = goal;
  else delete goals[meta.activeManuscript];
  return { ...meta, manuscriptGoals: goals };
}

/** A path inside the project as the "/"-separated relative path used in its metadata ("" for the project itself). */
export function relativeTo(projectPath: string, file: string): string {
  const norm = (x: string) => x.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = norm(projectPath);
  const f = norm(file);
  return f === base ? '' : f.startsWith(base + '/') ? f.slice(base.length + 1) : f;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// ---- names ---------------------------------------------------------------------------------

/** An error message for a project name, or null. `existing` are the names already in the Root Folder. */
export function projectNameError(name: string, existing: readonly string[] = []): string | null {
  const n = name.trim();
  const base = validateName(n);
  if (base) return base;
  if (n.startsWith('.')) return 'Names cannot start with a period.';
  if (existing.some((e) => e.toLowerCase() === n.toLowerCase())) return `There is already a project or folder called “${n}”.`;
  return null;
}

/** "The Lost King" → "The Lost King 2" … the first name not in `existing` (case-insensitive). */
export function uniqueName(base: string, existing: readonly string[]): string {
  const taken = new Set(existing.map((e) => e.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
  return `${base} ${Date.now()}`;
}

/** The default Root Folder: `<home>\MDEdit` (or `/` on POSIX). */
export function defaultRootFolder(home: string): string {
  const sep = home.includes('\\') && !home.includes('/') ? '\\' : '/';
  return home.replace(/[\\/]+$/, '') + sep + 'MDEdit';
}

export { isDate };

// ---- app-level settings for projects --------------------------------------------------------

export interface ProjectsSettings {
  /** The Root Folder, or null for the default (`<home>\MDEdit`). */
  rootFolder: string | null;
  /** The first-run welcome has been completed. */
  setupDone: boolean;
  templates: ProjectTemplate[];
  defaultTemplateId: string;
  /** Open the project that was open last time when the app starts. */
  reopenLast: boolean;
  lastProject: string | null;
  /** Project paths in the order they were opened on this device, most recent first (kept short). */
  recentProjects: string[];
}

export function defaultProjectsSettings(): ProjectsSettings {
  return { rootFolder: null, setupDone: false, templates: defaultTemplates(), defaultTemplateId: 'novel', reopenLast: true, lastProject: null, recentProjects: [] };
}

export function sanitizeProjectsSettings(raw: unknown): ProjectsSettings {
  const d = defaultProjectsSettings();
  if (!isObj(raw)) return d;
  const templates = sanitizeTemplates(raw.templates);
  const wanted = typeof raw.defaultTemplateId === 'string' ? raw.defaultTemplateId : d.defaultTemplateId;
  return {
    rootFolder: typeof raw.rootFolder === 'string' && raw.rootFolder.trim() ? raw.rootFolder.trim().slice(0, 1000) : null,
    setupDone: raw.setupDone === true,
    templates,
    defaultTemplateId: templates.some((t) => t.id === wanted) ? wanted : templates[0].id,
    reopenLast: raw.reopenLast !== false,
    lastProject: typeof raw.lastProject === 'string' && raw.lastProject ? raw.lastProject.slice(0, 1000) : null,
    recentProjects: Array.isArray(raw.recentProjects) ? raw.recentProjects.filter((p): p is string => typeof p === 'string' && !!p).map((p) => p.slice(0, 1000)).slice(0, MAX_RECENT) : []
  };
}

export const MAX_RECENT = 30;

const samePath = (a: string, b: string) => a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** The list of recently opened projects with `opened` moved to the front (once, whatever its spelling), or unchanged for null. */
export function withOpened(recent: string[], opened: string | null): string[] {
  if (!opened) return recent;
  return [opened, ...recent.filter((p) => !samePath(p, opened))].slice(0, MAX_RECENT);
}

/**
 * Projects for a "switch to" list: the ones opened on this device first, most recently opened first, then the rest by
 * when their files were last edited. Archived projects and `exceptPath` (the open one) are left out.
 */
export function byRecentlyOpened<T extends { path: string; lastEdited: number | null; meta: { archived?: boolean } }>(projects: T[], recent: string[], exceptPath: string | null = null): T[] {
  const rank = (p: T) => {
    const i = recent.findIndex((r) => samePath(r, p.path));
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  };
  return projects
    .filter((p) => !p.meta.archived && !(exceptPath && samePath(p.path, exceptPath)))
    .sort((a, b) => (rank(a) === rank(b) ? (b.lastEdited ?? 0) - (a.lastEdited ?? 0) : rank(a) - rank(b)));
}

/** What the renderer gets: the settings plus where the Root really is. */
export interface ProjectsConfig extends ProjectsSettings {
  /** The Root Folder in use (the saved one, or the default). */
  root: string;
  /** `<home>\MDEdit`: what "Use the default" means. */
  defaultRoot: string;
  rootExists: boolean;
}

/** What the Projects home shows for one project. */
export interface ProjectSummary {
  path: string;
  name: string;
  meta: ProjectMeta;
  /** Words in the active manuscript; null when no manuscript is active (nothing is counted then). */
  words: number | null;
  files: number;
  /** Most recent edit among the project's Markdown files (ms since epoch), or null if it has none. */
  lastEdited: number | null;
}

export interface RootListing {
  root: string;
  /** False when the Root Folder is missing or can't be read. */
  exists: boolean;
  projects: ProjectSummary[];
  /** Other folders in the Root: not projects yet (they can be converted). */
  folders: { name: string; path: string }[];
}


/**
 * The cascade for settings that exist at several levels: the app's defaults, overridden by the project's own
 * chapter level and book defaults where it has them (a project made from a template starts with the template's).
 */
export function effectiveDefaults(app: AppDefaults, meta: ProjectMeta | null): AppDefaults {
  if (!meta) return app;
  return { chapterLevel: meta.overrides.chapterLevel ?? app.chapterLevel, book: applyOverrides(app.book, meta.overrides.book) };
}
