import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { localDate, recordSnapshot, sanitizeProgress, type Progress } from '../src/shared/progress';
import {
  defaultTemplates, flattenFolders, newProjectMeta, PROGRESS_FILE, PROJECT_DIR, PROJECT_FILE, projectNameError, sanitizeProjectMeta,
  type ProjectMeta, type ProjectSummary, type ProjectTemplate, type RootListing
} from '../src/shared/projects';
import { countWords } from '../src/shared/words';
import { writeFileAtomic } from './files';

export interface Deps {
  now?: () => Date;
  uuid?: () => string;
  /** Test hook: called before each creation step ("folders", "files", "meta", "rename"); may throw to simulate a failure. */
  step?: (name: string) => void | Promise<void>;
}

const metaPath = (dir: string) => path.join(dir, PROJECT_DIR, PROJECT_FILE);
/** History file: one for the whole project, and one per active manuscript (named from a hash of its relative path). */
const progressPath = (dir: string, manuscript: string | null = null) =>
  path.join(dir, PROJECT_DIR, manuscript ? `progress-${createHash('sha1').update(manuscript.toLowerCase()).digest('hex').slice(0, 12)}.json` : PROGRESS_FILE);
const MD = /\.(md|markdown)$/i;
const exists = (p: string) => fs.lstat(p).then(() => true, () => false);

export async function isProject(dir: string): Promise<boolean> {
  return exists(metaPath(dir));
}

export async function readMeta(dir: string, now: () => Date = () => new Date()): Promise<ProjectMeta | null> {
  let text: string;
  try {
    text = await fs.readFile(metaPath(dir), 'utf8');
  } catch {
    return null;
  }
  let raw: unknown;
  let damaged = false;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
    damaged = true;
  }
  const meta = sanitizeProjectMeta(raw, path.basename(dir), localDate(now()));
  if (damaged) {
    // keep what was there, then start again from defaults named after the folder
    await fs.copyFile(metaPath(dir), metaPath(dir) + '.bak').catch(() => undefined);
    await writeMeta(dir, meta).catch(() => undefined);
  } else if (JSON.stringify(raw) !== JSON.stringify(meta)) {
    await writeMeta(dir, meta).catch(() => undefined); // tidy once
  }
  return meta;
}

export async function writeMeta(dir: string, meta: ProjectMeta): Promise<void> {
  await fs.mkdir(path.join(dir, PROJECT_DIR), { recursive: true });
  await writeFileAtomic(metaPath(dir), JSON.stringify(meta, null, 2) + '\n');
}

/** Merges a partial change into a project's metadata (sanitised) and saves it. */
export async function updateMeta(dir: string, patch: Partial<Omit<ProjectMeta, 'version' | 'id'>>, now: () => Date = () => new Date()): Promise<ProjectMeta> {
  const current = await readMeta(dir, now);
  if (!current) throw new Error('That folder is not a project.');
  const next = sanitizeProjectMeta({ ...current, ...patch, overrides: { ...current.overrides, ...(patch.overrides ?? {}) } }, current.name, localDate(now()));
  await writeMeta(dir, next);
  return next;
}

// ---- counting ---------------------------------------------------------------------------

/** Words, file count and last edit of a project's Markdown files, leaving out `excluded` folders (relative, "/" separated). */
export async function countProject(dir: string, excluded: readonly string[] = []): Promise<{ words: number; files: number; lastEdited: number | null }> {
  const skip = excluded.map((e) => e.toLowerCase());
  let words = 0;
  let files = 0;
  let lastEdited: number | null = null;
  const walk = async (d: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (e) => {
        if (e.isSymbolicLink()) return;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (e.name.startsWith('.') || e.name === 'node_modules') return;
          const key = childRel.toLowerCase();
          if (skip.some((s) => key === s || key.startsWith(s + '/'))) return;
          await walk(path.join(d, e.name), childRel);
        } else if (e.isFile() && MD.test(e.name)) {
          try {
            const full = path.join(d, e.name);
            const [text, st] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
            words += countWords(text);
            files++;
            lastEdited = Math.max(lastEdited ?? 0, st.mtimeMs);
          } catch {
            // unreadable file: ignore
          }
        }
      })
    );
  };
  await walk(dir, '');
  return { words, files, lastEdited };
}

async function summarise(dir: string, now: () => Date): Promise<ProjectSummary | null> {
  const meta = await readMeta(dir, now);
  if (!meta) return null;
  const c = await countProject(dir, meta.excludedFolders);
  if (meta.activeManuscript) {
    const n = await countFile(dir, meta.activeManuscript);
    if (n !== null) return { path: dir, name: path.basename(dir), meta, ...c, words: n };
  }
  return { path: dir, name: path.basename(dir), meta, ...c };
}

/** The projects (and other folders) directly inside the Root Folder. */
export async function listProjects(root: string, now: () => Date = () => new Date()): Promise<RootListing> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return { root, exists: false, projects: [], folders: [] };
  }
  const projects: ProjectSummary[] = [];
  const folders: { name: string; path: string }[] = [];
  await Promise.all(
    entries.map(async (e) => {
      if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith('.')) return;
      const dir = path.join(root, e.name);
      const s = await summarise(dir, now);
      if (s) projects.push(s);
      else folders.push({ name: e.name, path: dir });
    })
  );
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  return { root, exists: true, projects: projects.sort(byName), folders: folders.sort(byName) };
}

async function childNames(root: string): Promise<string[]> {
  try {
    return (await fs.readdir(root)).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}

// ---- progress ---------------------------------------------------------------------------

export async function readProgress(dir: string, manuscript: string | null = null): Promise<Progress> {
  try {
    return sanitizeProgress(JSON.parse(await fs.readFile(progressPath(dir, manuscript), 'utf8')));
  } catch {
    return sanitizeProgress(null);
  }
}

/** Words in one file of the project (0 when it is missing). */
async function countFile(dir: string, rel: string): Promise<number | null> {
  try {
    return countWords(await fs.readFile(path.join(dir, ...rel.split('/')), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Counts the words that goals follow now (the active manuscript, or the project's counted folders) and notes them in
 * that history for today. If the active manuscript has been deleted or moved away, it is cleared.
 */
export async function recordProgress(dir: string, now: () => Date = () => new Date()): Promise<{ progress: Progress; total: number; manuscript: string | null }> {
  let meta = await readMeta(dir, now);
  if (!meta) throw new Error('That folder is not a project.');
  let manuscript = meta.activeManuscript;
  let words: number;
  if (manuscript) {
    const n = await countFile(dir, manuscript);
    if (n === null) {
      meta = await updateMeta(dir, { activeManuscript: null }, now);
      manuscript = null;
      words = (await countProject(dir, meta.excludedFolders)).words;
    } else words = n;
  } else words = (await countProject(dir, meta.excludedFolders)).words;
  const before = await readProgress(dir, manuscript);
  const after = recordSnapshot(before, localDate(now()), words);
  if (after !== before) {
    await fs.mkdir(path.join(dir, PROJECT_DIR), { recursive: true });
    await writeFileAtomic(progressPath(dir, manuscript), JSON.stringify(after, null, 2) + '\n');
  }
  return { progress: after, total: words, manuscript };
}

// ---- operations -------------------------------------------------------------------------

/**
 * Makes a project from a template: the folders, starter files and metadata are built in a hidden temporary folder and
 * renamed into place at the end, so a failure at any step leaves nothing behind. Returns its path and metadata.
 */
export async function createProject(root: string, name: string, template: ProjectTemplate, deps: Deps = {}): Promise<{ path: string; meta: ProjectMeta }> {
  const now = deps.now ?? (() => new Date());
  const step = async (s: string) => void (await deps.step?.(s));
  const clean = name.trim();
  const bad = projectNameError(clean, await childNames(root));
  if (bad) throw new Error(bad);
  await fs.mkdir(root, { recursive: true });
  const target = path.join(root, clean);
  const tmp = path.join(root, `.${clean}.creating-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await fs.mkdir(tmp);
    await step('folders');
    for (const rel of flattenFolders(template.folders)) await fs.mkdir(path.join(tmp, ...rel.split('/')), { recursive: true });
    await step('files');
    let starterWords = 0;
    for (const f of template.files) {
      const full = path.join(tmp, ...f.path.split('/'));
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, f.content, { encoding: 'utf8', flag: 'wx' });
    }
    await step('meta');
    const meta = newProjectMeta({ id: (deps.uuid ?? randomUUID)(), name: clean, template, now: now() });
    await writeMeta(tmp, meta);
    starterWords = (await countProject(tmp, meta.excludedFolders)).words;
    const progress = recordSnapshot(sanitizeProgress(null), localDate(now()), starterWords);
    await writeFileAtomic(progressPath(tmp), JSON.stringify(progress, null, 2) + '\n');
    await step('rename');
    if (await exists(target)) throw new Error(`There is already a project or folder called “${clean}”.`);
    await fs.rename(tmp, target);
    return { path: target, meta };
  } catch (e) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
}

/** Renames a project's folder and its recorded name. Returns the new path. */
export async function renameProject(dir: string, newName: string): Promise<string> {
  const root = path.dirname(dir);
  const clean = newName.trim();
  const siblings = (await childNames(root)).filter((n) => n.toLowerCase() !== path.basename(dir).toLowerCase());
  const bad = projectNameError(clean, siblings);
  if (bad) throw new Error(bad);
  const to = path.join(root, clean);
  if (to !== dir) await fs.rename(dir, to);
  await updateMeta(to, { name: clean }).catch(() => undefined);
  return to;
}

/** Copies a project (files, structure, goal and settings; not its writing history) under a new name. */
export async function duplicateProject(dir: string, newName: string, deps: Deps = {}): Promise<{ path: string; meta: ProjectMeta }> {
  const now = deps.now ?? (() => new Date());
  const root = path.dirname(dir);
  const clean = newName.trim();
  const bad = projectNameError(clean, await childNames(root));
  if (bad) throw new Error(bad);
  const target = path.join(root, clean);
  const tmp = path.join(root, `.${clean}.copying-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await fs.cp(dir, tmp, { recursive: true, errorOnExist: true });
    const meta = await readMeta(tmp, now);
    if (!meta) throw new Error('That folder is not a project.');
    const copy: ProjectMeta = { ...meta, id: (deps.uuid ?? randomUUID)(), name: clean, createdAt: now().toISOString() };
    await writeMeta(tmp, copy);
    for (const f of await fs.readdir(path.join(tmp, PROJECT_DIR)).catch(() => [] as string[])) {
      if (/^progress.*\.json(\.bak)?$/.test(f)) await fs.rm(path.join(tmp, PROJECT_DIR, f), { force: true });
    }
    const manuscriptWords = copy.activeManuscript ? await countFile(tmp, copy.activeManuscript) : null;
    const words = manuscriptWords ?? (await countProject(tmp, copy.excludedFolders)).words;
    await writeFileAtomic(progressPath(tmp, manuscriptWords === null ? null : copy.activeManuscript), JSON.stringify(recordSnapshot(sanitizeProgress(null), localDate(now()), words), null, 2) + '\n');
    if (await exists(target)) throw new Error(`There is already a project or folder called “${clean}”.`);
    await fs.rename(tmp, target);
    return { path: target, meta: copy };
  } catch (e) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
}

/** Sends the project folder to the Recycle Bin (the caller supplies the trash function so this stays testable). */
export async function deleteProject(dir: string, trash: (p: string) => Promise<void>): Promise<void> {
  if (!(await isProject(dir))) throw new Error('That folder is not a project.');
  await trash(dir);
}

/** Turns an ordinary folder into a project (adds only the hidden marker; nothing else changes). */
export async function convertToProject(dir: string, deps: Deps = {}): Promise<ProjectMeta> {
  if (await isProject(dir)) throw new Error('That folder is already a project.');
  const now = deps.now ?? (() => new Date());
  const blank = defaultTemplates().find((t) => t.id === 'blank')!;
  const meta = newProjectMeta({ id: (deps.uuid ?? randomUUID)(), name: path.basename(dir), template: blank, now: now() });
  await writeMeta(dir, meta);
  const { words } = await countProject(dir, []);
  await fs.mkdir(path.join(dir, PROJECT_DIR), { recursive: true });
  await writeFileAtomic(progressPath(dir), JSON.stringify(recordSnapshot(sanitizeProgress(null), localDate(now()), words), null, 2) + '\n');
  return meta;
}

/** Adds any template folders (and missing starter files) that a project lacks. Returns what was added. */
export async function addMissingTemplateParts(dir: string, template: ProjectTemplate): Promise<string[]> {
  const added: string[] = [];
  for (const rel of flattenFolders(template.folders)) {
    const full = path.join(dir, ...rel.split('/'));
    if (!(await exists(full))) {
      await fs.mkdir(full, { recursive: true });
      added.push(rel);
    }
  }
  for (const f of template.files) {
    const full = path.join(dir, ...f.path.split('/'));
    if (!(await exists(full))) {
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, f.content, { encoding: 'utf8', flag: 'wx' });
      added.push(f.path);
    }
  }
  return added;
}

/** Moves every project (and nothing else) from one Root Folder to another. Reports what could not be moved. */
export async function moveProjects(oldRoot: string, newRoot: string): Promise<{ moved: string[]; failed: { name: string; error: string }[] }> {
  const moved: string[] = [];
  const failed: { name: string; error: string }[] = [];
  if (path.resolve(oldRoot) === path.resolve(newRoot)) return { moved, failed };
  await fs.mkdir(newRoot, { recursive: true });
  const { projects } = await listProjects(oldRoot);
  for (const p of projects) {
    const to = path.join(newRoot, p.name);
    try {
      if (await exists(to)) throw new Error(`“${p.name}” already exists in the new Root Folder.`);
      try {
        await fs.rename(p.path, to);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
        await fs.cp(p.path, to, { recursive: true, errorOnExist: true }); // another drive: copy, then remove the original
        await fs.rm(p.path, { recursive: true, force: true });
      }
      moved.push(p.name);
    } catch (e) {
      failed.push({ name: p.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { moved, failed };
}
