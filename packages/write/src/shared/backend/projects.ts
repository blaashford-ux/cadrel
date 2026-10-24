import type { AppDefaults } from '../appDefaults';
import { errorCode, type FsPort } from '../fsPort';
import { basename, dirname, joinParts, joinPath } from '../paths';
import { applyMap, EDITED_FILE, emptyMarks, marksToMap, sanitizeMarks, type EditedMarks } from '../editedMarks';
import { localDate, recordSnapshot, sanitizeProgress, type Progress } from '../progress';
import { sha1Hex } from '../sha1';
import {
  defaultTemplates, flattenFolders, newProjectMeta, PROGRESS_FILE, PROJECT_DIR, PROJECT_FILE, projectNameError, sanitizeProjectMeta,
  type ProjectMeta, type ProjectSummary, type ProjectTemplate, type RootListing
} from '../projects';
import { countWords } from '../words';
import { makeFiles } from './files';

export interface Deps {
  now?: () => Date;
  uuid?: () => string;
  /** The app's defaults: a template's book settings are stored as what they change relative to these. */
  app?: AppDefaults;
  /** Test hook: called before each creation step ("folders", "files", "meta", "rename"); may throw to simulate a failure. */
  step?: (name: string) => void | Promise<void>;
}

const metaPath = (dir: string) => joinParts(dir, PROJECT_DIR, PROJECT_FILE);
const marksPath = (dir: string) => joinParts(dir, PROJECT_DIR, EDITED_FILE);
/** History file: one for the whole project, and one per active manuscript (named from a hash of its relative path). */
const progressPath = (dir: string, manuscript: string | null = null) =>
  joinParts(dir, PROJECT_DIR, manuscript ? `progress-${sha1Hex(manuscript.toLowerCase()).slice(0, 12)}.json` : PROGRESS_FILE);
const MD = /\.(md|markdown)$/i;

const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, '') === b.replace(/[\\/]+$/, '');
const tempToken = () => Math.floor(Math.random() * 1e9);
const newUuid = (): string => globalThis.crypto.randomUUID();

/** Project operations (create, list, rename, duplicate, convert, progress…) over any `FsPort`. */
export function makeProjects(fs: FsPort) {
  const { writeFileAtomic } = makeFiles(fs);
  const exists = (p: string) => fs.stat(p).then((st) => st !== null, () => false);

  async function isProject(dir: string): Promise<boolean> {
    return exists(metaPath(dir));
  }

  async function readMeta(dir: string, now: () => Date = () => new Date()): Promise<ProjectMeta | null> {
    let text: string;
    try {
      text = await fs.readText(metaPath(dir));
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
    const meta = sanitizeProjectMeta(raw, basename(dir), localDate(now()));
    // Edited-chapter marks live in their own file (so sync can merge them). Marks an older project.json still carries move across once.
    let marks = await readMarks(dir);
    if (!marks && Object.keys(meta.editedChapters).length) {
      marks = applyMap(emptyMarks(), meta.editedChapters, now().getTime());
      await writeMarks(dir, marks).catch(() => undefined);
    }
    if (damaged) {
      // keep what was there, then start again from defaults named after the folder
      await fs.copy(metaPath(dir), metaPath(dir) + '.bak').catch(() => undefined);
      await writeMeta(dir, meta).catch(() => undefined);
    } else if (JSON.stringify(raw) !== JSON.stringify(meta)) {
      await writeMeta(dir, meta).catch(() => undefined); // tidy once
    }
    return { ...meta, editedChapters: marks ? marksToMap(marks) : {} };
  }

  /** The project's edited-chapter marks, or null when it has none yet (or the file is unreadable). */
  async function readMarks(dir: string): Promise<EditedMarks | null> {
    try {
      return sanitizeMarks(JSON.parse(await fs.readText(marksPath(dir))));
    } catch {
      return null;
    }
  }

  async function writeMarks(dir: string, marks: EditedMarks): Promise<void> {
    await fs.mkdir(joinPath(dir, PROJECT_DIR), { recursive: true });
    await writeFileAtomic(marksPath(dir), JSON.stringify(marks, null, 2) + '\n');
  }

  /** project.json never holds the marks (they would be overwritten, not merged, when two devices sync). */
  async function writeMeta(dir: string, meta: ProjectMeta): Promise<void> {
    await fs.mkdir(joinPath(dir, PROJECT_DIR), { recursive: true });
    await writeFileAtomic(metaPath(dir), JSON.stringify({ ...meta, editedChapters: {} }, null, 2) + '\n');
  }

  /** Merges a partial change into a project's metadata (sanitised) and saves it. */
  async function updateMeta(dir: string, patch: Partial<Omit<ProjectMeta, 'version' | 'id'>>, now: () => Date = () => new Date()): Promise<ProjectMeta> {
    const current = await readMeta(dir, now);
    if (!current) throw new Error('That folder is not a project.');
    const { editedChapters, ...rest } = patch;
    if (editedChapters) {
      const before = (await readMarks(dir)) ?? emptyMarks();
      const after = applyMap(before, editedChapters, now().getTime());
      if (after !== before) await writeMarks(dir, after);
    }
    const next = sanitizeProjectMeta({ ...current, ...rest, overrides: { ...current.overrides, ...(rest.overrides ?? {}) } }, current.name, localDate(now()));
    await writeMeta(dir, next);
    return (await readMeta(dir, now))!;
  }

  // ---- counting ---------------------------------------------------------------------------

  /** Word counts remembered by file (path + size + modification time), so unchanged files aren't read again each time the home screen refreshes. */
  const wordCache = new Map<string, { mtimeMs: number; size: number; words: number }>();

  /** Words, file count and last edit of a project's Markdown files, leaving out `excluded` folders (relative, "/" separated). */
  async function countProject(dir: string, excluded: readonly string[] = []): Promise<{ words: number; files: number; lastEdited: number | null }> {
    const skip = excluded.map((e) => e.toLowerCase());
    let words = 0;
    let files = 0;
    let lastEdited: number | null = null;
    const walk = async (d: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(d);
      } catch {
        return;
      }
      await Promise.all(
        entries.map(async (e) => {
          if (e.isSymbolicLink) return;
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory) {
            if (e.name.startsWith('.') || e.name === 'node_modules') return;
            const key = childRel.toLowerCase();
            if (skip.some((s) => key === s || key.startsWith(s + '/'))) return;
            await walk(joinPath(d, e.name), childRel);
          } else if (e.isFile && MD.test(e.name)) {
            try {
              const full = joinPath(d, e.name);
              const st = e.mtimeMs !== undefined && e.size !== undefined ? { mtimeMs: e.mtimeMs, size: e.size } : await fs.stat(full);
              if (!st) return;
              const cached = wordCache.get(full);
              let n: number;
              if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) n = cached.words;
              else {
                n = countWords(await fs.readText(full));
                wordCache.set(full, { mtimeMs: st.mtimeMs, size: st.size, words: n });
              }
              words += n;
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
    // words belong to the active manuscript alone: without one (or if it has gone) there is no count
    const words = meta.activeManuscript ? await countFile(dir, meta.activeManuscript) : null;
    return { path: dir, name: basename(dir), meta, files: c.files, lastEdited: c.lastEdited, words };
  }

  /** The projects (and other folders) directly inside the Root Folder. */
  async function listProjects(root: string, now: () => Date = () => new Date()): Promise<RootListing> {
    let entries;
    try {
      entries = await fs.readdir(root);
    } catch {
      return { root, exists: false, projects: [], folders: [] };
    }
    const projects: ProjectSummary[] = [];
    const folders: { name: string; path: string }[] = [];
    await Promise.all(
      entries.map(async (e) => {
        if (!e.isDirectory || e.isSymbolicLink || e.name.startsWith('.')) return;
        const dir = joinPath(root, e.name);
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
      return (await fs.readdir(root)).map((e) => e.name).filter((n) => !n.startsWith('.'));
    } catch {
      return [];
    }
  }

  // ---- progress ---------------------------------------------------------------------------

  async function readProgress(dir: string, manuscript: string | null = null): Promise<Progress> {
    try {
      return sanitizeProgress(JSON.parse(await fs.readText(progressPath(dir, manuscript))));
    } catch {
      return sanitizeProgress(null);
    }
  }

  /** Words in one file of the project (0 when it is missing). */
  async function countFile(dir: string, rel: string): Promise<number | null> {
    try {
      return countWords(await fs.readText(joinParts(dir, ...rel.split('/'))));
    } catch {
      return null;
    }
  }

  /**
   * Counts the words of the active manuscript and notes them in that manuscript's own history for today (each
   * manuscript keeps its history, so swapping back shows it again). With no active manuscript there is nothing to
   * count: the total is null and nothing is recorded. If the active manuscript has been deleted or moved away, it is cleared.
   */
  async function recordProgress(dir: string, now: () => Date = () => new Date()): Promise<{ progress: Progress; total: number | null; manuscript: string | null }> {
    const meta = await readMeta(dir, now);
    if (!meta) throw new Error('That folder is not a project.');
    const manuscript = meta.activeManuscript;
    const words = manuscript ? await countFile(dir, manuscript) : null;
    if (!manuscript || words === null) {
      if (manuscript) await updateMeta(dir, { activeManuscript: null }, now);
      return { progress: sanitizeProgress(null), total: null, manuscript: null };
    }
    const before = await readProgress(dir, manuscript);
    const after = recordSnapshot(before, localDate(now()), words);
    if (after !== before) {
      await fs.mkdir(joinPath(dir, PROJECT_DIR), { recursive: true });
      await writeFileAtomic(progressPath(dir, manuscript), JSON.stringify(after, null, 2) + '\n');
    }
    return { progress: after, total: words, manuscript };
  }

  // ---- operations -------------------------------------------------------------------------

  /**
   * Makes a project from a template: the folders, starter files and metadata are built in a hidden temporary folder and
   * renamed into place at the end, so a failure at any step leaves nothing behind. Returns its path and metadata.
   */
  async function createProject(root: string, name: string, template: ProjectTemplate, deps: Deps = {}): Promise<{ path: string; meta: ProjectMeta }> {
    const now = deps.now ?? (() => new Date());
    const step = async (s: string) => void (await deps.step?.(s));
    const clean = name.trim();
    const bad = projectNameError(clean, await childNames(root));
    if (bad) throw new Error(bad);
    await fs.mkdir(root, { recursive: true });
    const target = joinPath(root, clean);
    const tmp = joinPath(root, `.${clean}.creating-${tempToken()}-${Math.random().toString(36).slice(2, 8)}`);
    try {
      await fs.mkdir(tmp);
      await step('folders');
      for (const rel of flattenFolders(template.folders)) await fs.mkdir(joinParts(tmp, ...rel.split('/')), { recursive: true });
      await step('files');
      let starterWords = 0;
      for (const f of template.files) {
        const full = joinParts(tmp, ...f.path.split('/'));
        await fs.mkdir(dirname(full), { recursive: true });
        await fs.writeText(full, f.content, { exclusive: true });
      }
      await step('meta');
      const meta = newProjectMeta({ id: (deps.uuid ?? newUuid)(), name: clean, template, now: now(), app: deps.app });
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
  async function renameProject(dir: string, newName: string): Promise<string> {
    const root = dirname(dir);
    const clean = newName.trim();
    const siblings = (await childNames(root)).filter((n) => n.toLowerCase() !== basename(dir).toLowerCase());
    const bad = projectNameError(clean, siblings);
    if (bad) throw new Error(bad);
    const to = joinPath(root, clean);
    if (to !== dir) await fs.rename(dir, to);
    await updateMeta(to, { name: clean }).catch(() => undefined);
    return to;
  }

  /** Copies a project (files, structure, goal and settings; not its writing history) under a new name. */
  async function duplicateProject(dir: string, newName: string, deps: Deps = {}): Promise<{ path: string; meta: ProjectMeta }> {
    const now = deps.now ?? (() => new Date());
    const root = dirname(dir);
    const clean = newName.trim();
    const bad = projectNameError(clean, await childNames(root));
    if (bad) throw new Error(bad);
    const target = joinPath(root, clean);
    const tmp = joinPath(root, `.${clean}.copying-${tempToken()}-${Math.random().toString(36).slice(2, 8)}`);
    try {
      await fs.copy(dir, tmp);
      const meta = await readMeta(tmp, now);
      if (!meta) throw new Error('That folder is not a project.');
      const copy: ProjectMeta = { ...meta, id: (deps.uuid ?? newUuid)(), name: clean, createdAt: now().toISOString() };
      await writeMeta(tmp, copy);
      for (const f of (await fs.readdir(joinPath(tmp, PROJECT_DIR)).catch(() => [])).map((e) => e.name)) {
        if (/^progress.*\.json(\.bak)?$/.test(f)) await fs.rm(joinParts(tmp, PROJECT_DIR, f), { force: true });
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
  async function deleteProject(dir: string, trash: (p: string) => Promise<void>): Promise<void> {
    if (!(await isProject(dir))) throw new Error('That folder is not a project.');
    await trash(dir);
  }

  /** Turns an ordinary folder into a project (adds only the hidden marker; nothing else changes). */
  async function convertToProject(dir: string, deps: Deps = {}): Promise<ProjectMeta> {
    if (await isProject(dir)) throw new Error('That folder is already a project.');
    const now = deps.now ?? (() => new Date());
    const blank = defaultTemplates().find((t) => t.id === 'blank')!;
    const meta = newProjectMeta({ id: (deps.uuid ?? newUuid)(), name: basename(dir), template: blank, now: now() });
    await writeMeta(dir, meta);
    const { words } = await countProject(dir, []);
    await fs.mkdir(joinPath(dir, PROJECT_DIR), { recursive: true });
    await writeFileAtomic(progressPath(dir), JSON.stringify(recordSnapshot(sanitizeProgress(null), localDate(now()), words), null, 2) + '\n');
    return meta;
  }

  /** Adds any template folders (and missing starter files) that a project lacks. Returns what was added. */
  async function addMissingTemplateParts(dir: string, template: ProjectTemplate): Promise<string[]> {
    const added: string[] = [];
    for (const rel of flattenFolders(template.folders)) {
      const full = joinParts(dir, ...rel.split('/'));
      if (!(await exists(full))) {
        await fs.mkdir(full, { recursive: true });
        added.push(rel);
      }
    }
    for (const f of template.files) {
      const full = joinParts(dir, ...f.path.split('/'));
      if (!(await exists(full))) {
        await fs.mkdir(dirname(full), { recursive: true });
        await fs.writeText(full, f.content, { exclusive: true });
        added.push(f.path);
      }
    }
    return added;
  }

  /** Moves every project (and nothing else) from one Root Folder to another. Reports what could not be moved. */
  async function moveProjects(oldRoot: string, newRoot: string): Promise<{ moved: string[]; failed: { name: string; error: string }[] }> {
    const moved: string[] = [];
    const failed: { name: string; error: string }[] = [];
    if (samePath(oldRoot, newRoot)) return { moved, failed };
    await fs.mkdir(newRoot, { recursive: true });
    const { projects } = await listProjects(oldRoot);
    for (const p of projects) {
      const to = joinPath(newRoot, p.name);
      try {
        if (await exists(to)) throw new Error(`“${p.name}” already exists in the new Root Folder.`);
        try {
          await fs.rename(p.path, to);
        } catch (e) {
          if (errorCode(e) !== 'EXDEV') throw e;
          await fs.copy(p.path, to); // another drive: copy, then remove the original
          await fs.rm(p.path, { recursive: true, force: true });
        }
        moved.push(p.name);
      } catch (e) {
        failed.push({ name: p.name, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { moved, failed };
  }

  return { isProject, readMeta, writeMeta, updateMeta, countProject, listProjects, readProgress, recordProgress, createProject, renameProject, duplicateProject, deleteProject, convertToProject, addMissingTemplateParts, moveProjects };
}
