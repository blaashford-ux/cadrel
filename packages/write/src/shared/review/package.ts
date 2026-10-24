import { joinChapters, splitChapters, type MarkdownDoc } from '../chapters';
import type { FsPort } from '../fsPort';
import { classify } from '../sync/rules';

/** A snapshot of a project's text that a reviewer downloads: one JSON file with every manuscript file in it. */
export interface ReviewPackage {
  version: 1;
  project: string;
  publishedAt: string;
  files: { path: string; text: string }[];
  /** Collaboration copies only: the heading level that splits the manuscript into chapters, so both sides merge by the same chapters. */
  chapterLevel?: number;
}

const MAX_FILES = 600;

/** The chapters of a manuscript a reviewer may see, by key (see `chapterKeys`), and the heading level that splits it. */
export interface ChapterSelection {
  keys: string[];
  level: number;
}

/** Key of the text before the first chapter heading. */
export const PREAMBLE_KEY = '\u0000front';

/**
 * A stable key for each chapter: its title, with " (2)", " (3)" … for a title that repeats. Moving a chapter keeps its key;
 * renaming it makes it a new chapter.
 */
export function chapterKeys(doc: MarkdownDoc): { key: string; title: string }[] {
  const seen = new Map<string, number>();
  return doc.chapters.map((c) => {
    if (c.isPreamble) return { key: PREAMBLE_KEY, title: '' };
    const n = (seen.get(c.title) ?? 0) + 1;
    seen.set(c.title, n);
    return { key: n === 1 ? c.title : `${c.title} (${n})`, title: c.title };
  });
}

/** The manuscript text reduced to the selected chapters (in their original order). */
export function selectChapters(text: string, sel: ChapterSelection): string {
  const doc = splitChapters(text, sel.level);
  const want = new Set(sel.keys);
  const keys = chapterKeys(doc);
  return joinChapters({ ...doc, chapters: doc.chapters.filter((_, i) => want.has(keys[i].key)) });
}

async function walkProse(fs: FsPort, dir: string, keep: (rel: string) => boolean, read: (rel: string, text: string) => string = (_r, t) => t): Promise<{ path: string; text: string }[]> {
  const files: { path: string; text: string }[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = (await fs.readdir(rel ? `${dir}/${rel}` : dir)).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.isSymbolicLink) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) {
        if (!e.name.startsWith('.')) await walk(r);
      } else if (e.isFile && files.length < MAX_FILES && keep(r)) {
        files.push({ path: r, text: read(r, await fs.readText(`${dir}/${r}`)) });
      }
    }
  };
  await walk('');
  return files;
}

/** Every prose file in the project folder (Markdown only; settings, exports and hidden folders are left out), or just `only`. */
export async function buildPackage(fs: FsPort, dir: string, project: string, now: () => Date = () => new Date(), only?: string, chapters?: ChapterSelection): Promise<ReviewPackage> {
  const files = await walkProse(fs, dir, (r) => classify(r) === 'prose' && (only === undefined || r === only), (_r, t) => (chapters && only !== undefined ? selectChapters(t, chapters) : t));
  return { version: 1, project, publishedAt: now().toISOString(), files };
}

/** Whether a path inside a project is a manuscript file that collaborators may share (Markdown outside hidden folders and Exports). */
export const isSharedProse = (rel: string): boolean => !rel.split('/').some((s) => s.startsWith('.')) && classify(`p/${rel}`) === 'prose';

/** Every Markdown file of the project (the notes, outlines and other books too), which is what collaborators work on together. */
export function readProseFiles(fs: FsPort, dir: string): Promise<{ path: string; text: string }[]> {
  return walkProse(fs, dir, isSharedProse);
}

export function parsePackage(raw: string): ReviewPackage | null {
  try {
    const d = JSON.parse(raw) as Partial<ReviewPackage>;
    if (d.version !== 1 || typeof d.project !== 'string' || !Array.isArray(d.files)) return null;
    const files = d.files.filter(
      (f): f is { path: string; text: string } =>
        !!f && typeof f.path === 'string' && typeof f.text === 'string' && !f.path.split('/').some((s) => s === '..' || s === '') && !/^[A-Za-z]:|^[\\/]/.test(f.path) && !f.path.includes('\\')
    );
    return { version: 1, project: d.project, publishedAt: String(d.publishedAt ?? ''), files, ...(typeof d.chapterLevel === 'number' ? { chapterLevel: d.chapterLevel } : {}) };
  } catch {
    return null;
  }
}

/** Marker file in a shared project's folder: where it came from and what it contained. */
export const SHARED_MARKER = '.mdedit/shared.json';

export interface SharedMarker {
  packageId: string;
  commentsId: string;
  reviewerId: string;
  project: string;
  packageMd5: string | null;
  /** Files the last download wrote, so a later download can remove the ones the owner deleted. */
  files: string[];
  /** 'edit' when this person was invited to work on the text, not just to comment on it. */
  role?: 'edit';
}

/** Where a collaborator's copy remembers the text both sides last agreed on, by file path (the starting point of the next merge). */
export const COLLAB_BASE = '.mdedit/collab-base.json';

export async function readCollabBase(fs: FsPort, dir: string): Promise<Record<string, string> | null> {
  try {
    const b = JSON.parse(await fs.readText(`${dir}/${COLLAB_BASE}`)) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(b)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return null;
  }
}

export async function writeCollabBase(fs: FsPort, dir: string, base: Record<string, string>): Promise<void> {
  await fs.mkdir(`${dir}/.mdedit`, { recursive: true });
  await fs.writeText(`${dir}/${COLLAB_BASE}`, JSON.stringify(base));
}

export async function readMarker(fs: FsPort, dir: string): Promise<SharedMarker | null> {
  try {
    const m = JSON.parse(await fs.readText(`${dir}/${SHARED_MARKER}`)) as Partial<SharedMarker>;
    if (typeof m.packageId !== 'string' || typeof m.commentsId !== 'string' || typeof m.reviewerId !== 'string') return null;
    return { packageId: m.packageId, commentsId: m.commentsId, reviewerId: m.reviewerId, project: String(m.project ?? ''), packageMd5: m.packageMd5 ?? null, files: Array.isArray(m.files) ? m.files.map(String) : [], ...(m.role === 'edit' ? { role: 'edit' as const } : {}) };
  } catch {
    return null;
  }
}

export async function writeMarker(fs: FsPort, dir: string, m: SharedMarker): Promise<void> {
  await fs.mkdir(`${dir}/.mdedit`, { recursive: true });
  await fs.writeText(`${dir}/${SHARED_MARKER}`, JSON.stringify(m, null, 2));
}

/** Writes the package's files into `dir` and removes files an earlier download wrote that are gone now. */
export async function writePackage(fs: FsPort, dir: string, pkg: ReviewPackage, previous: string[]): Promise<string[]> {
  await fs.mkdir(dir, { recursive: true });
  const keep = new Set(pkg.files.map((f) => f.path));
  for (const old of previous) if (!keep.has(old)) await fs.rm(`${dir}/${old}`, { force: true }).catch(() => undefined);
  for (const f of pkg.files) {
    const slash = f.path.lastIndexOf('/');
    if (slash > 0) await fs.mkdir(`${dir}/${f.path.slice(0, slash)}`, { recursive: true });
    await fs.writeText(`${dir}/${f.path}`, f.text);
  }
  return pkg.files.map((f) => f.path);
}
