/**
 * The project's non-manuscript files, for the authoring skills (premise, outline, characters, blurb, keywords, trackers):
 * list them with a guessed kind, read them, and write them. Plain functions over `FsPort`, like tools.ts.
 *
 * What keeps this safe: a path can't leave the project (every step is looked up in its folder listing, so `..` and symlinks
 * can't get through), a manuscript or exports folder is never written, an existing file is never replaced unless the caller
 * says so, and whatever a replace or edit overwrites is kept under `<project>/.cadrel/previous/` (the newest few copies).
 */
import type { FsEntry } from '../fsPort';
import { AgentError, badName, child, join, projectDir, serial, type AgentContext } from './tools';

/** Files these tools will list, read and write. */
export const TEXT_FILE = /\.(md|markdown|txt|json|html|csv)$/i;
const MARKDOWN_FILE = /\.(md|markdown)$/i;

export const FILE_LIMITS = {
  files: 600,
  /** Characters returned by one `read_project_file` call, by default and at most. */
  readDefault: 40000,
  readMax: 120000,
  /** Characters accepted by one write, and the size a file may grow to. */
  writeCall: 400000,
  fileMax: 2000000,
  /** Copies of an overwritten file kept per file. */
  keepPrevious: 5,
} as const;

const PREVIOUS_DIR = '.cadrel/previous';

/** What a file probably is, from where it sits and what it is called: a guess, the same kind of one the app makes. */
export function fileKind(rel: string): string {
  const parts = rel.split('/');
  const name = parts[parts.length - 1];
  const folders = parts.slice(0, -1).map((s) => s.toLowerCase());
  const any = (re: RegExp) => folders.some((f) => re.test(f));
  if (any(/^manuscripts?$/)) return 'manuscript';
  if (any(/^exports?$/)) return 'export';
  if (any(/^characters?$/)) return 'character';
  if (any(/^world(building)?$|^locations?$/)) return 'world';
  if (any(/^research$/)) return 'research';
  if (any(/^tracking$/)) return /\.html$/i.test(name) ? 'view' : 'tracker';
  if (any(/^marketing$/)) return 'copy';
  if (any(/^series bible$/)) return 'bible';
  if (/premise/i.test(name)) return 'premise';
  if (/outline/i.test(name)) return 'outline';
  if (/bible/i.test(name)) return 'bible';
  if (/blurb|keywords/i.test(name)) return 'copy';
  if (/style|voice/i.test(name)) return 'style';
  return 'other';
}

/** The folders no tool of ours writes into: the manuscript itself and what is built from it. */
const PROTECTED_FOLDER = /^(manuscripts?|exports?)$/i;

async function resolve(ctx: AgentContext, project: string, file: string, mode: 'read' | 'write'): Promise<{ dir: string; abs: string; rel: string; exists: boolean }> {
  const dir = await projectDir(ctx, project);
  const parts = typeof file === 'string' ? file.split('/') : [];
  if (!parts.length || parts.some(badName) || !TEXT_FILE.test(parts[parts.length - 1])) {
    throw new AgentError(`"${file}" is not a path this tool can use. Give a path inside the project, like "Characters/Mira.md" (Markdown, text, JSON, HTML or CSV files only; no folders starting with a dot).`);
  }
  const rel = parts.join('/');
  if (mode === 'write' && parts.slice(0, -1).some((p) => PROTECTED_FOLDER.test(p))) {
    throw new AgentError(`"${rel}" is in a manuscript or exports folder. These tools never write there: the author's manuscript is changed only by the author. Save it somewhere else in the project.`);
  }
  let abs = dir;
  const real: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    // Exact name first; failing that a name that differs only in case, so "outline.md" doesn't become a second "Outline.md" (or a second "characters" folder).
    const e = (await child(ctx.fs, abs, parts[i])) ?? (await ctx.fs.readdir(abs).catch(() => [] as FsEntry[])).find((x) => !x.isSymbolicLink && x.name.toLowerCase() === parts[i].toLowerCase());
    if (!e) {
      if (mode === 'read') throw new AgentError(`"${rel}" does not exist in "${project}". Use list_project_files to see the paths.`);
      // Not there yet: the rest is new, and is checked by name only.
      return { dir, abs: [abs, ...parts.slice(i)].join('/'), rel: [...real, ...parts.slice(i)].join('/'), exists: false };
    }
    if (last ? !e.isFile : !e.isDirectory) throw new AgentError(`"${rel}" ${last ? 'is a folder, not a file' : `goes through "${parts[i]}", which is a file`}.`);
    abs = join(abs, e.name);
    real.push(e.name);
  }
  return { dir, abs, rel: real.join('/'), exists: true };
}

async function ensureParent(ctx: AgentContext, abs: string): Promise<void> {
  await ctx.fs.mkdir(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
}

/** Writes through a temporary file, so a crash can't leave half a file where a good one was. */
async function atomicWrite(ctx: AgentContext, abs: string, content: string): Promise<void> {
  await ensureParent(ctx, abs);
  const tmp = `${abs}.${Math.floor(Math.random() * 1e9)}.tmp`;
  try {
    await ctx.fs.writeText(tmp, content);
    await ctx.fs.rename(tmp, abs);
  } catch (e) {
    await ctx.fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

async function keepPrevious(ctx: AgentContext, dir: string, rel: string, text: string): Promise<void> {
  const base = rel.replace(/\//g, '~');
  const stamp = (ctx.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
  await ctx.fs.mkdir(`${dir}/${PREVIOUS_DIR}`, { recursive: true });
  await ctx.fs.writeText(`${dir}/${PREVIOUS_DIR}/${base}.${stamp}`, text);
  const mine = (await ctx.fs.readdir(`${dir}/${PREVIOUS_DIR}`).catch(() => [] as FsEntry[])).filter((e) => e.isFile && e.name.startsWith(`${base}.`)).map((e) => e.name).sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - FILE_LIMITS.keepPrevious))) await ctx.fs.rm(`${dir}/${PREVIOUS_DIR}/${old}`, { force: true }).catch(() => undefined);
}

// ---- listing and reading ---------------------------------------------------------------------

export interface ProjectFileInfo {
  file: string;
  kind: string;
  /** Characters of text, a little under the byte size for text with accents. */
  size: number;
}

/** The text files in a project (any folder but the hidden ones), with a guessed kind. `folder` narrows to one folder. */
export async function listProjectFiles(ctx: AgentContext, project: string, folder?: string): Promise<{ files: ProjectFileInfo[]; truncated: boolean }> {
  const dir = await projectDir(ctx, project);
  const prefix = (folder ?? '').replace(/^\/+|\/+$/g, '');
  if (prefix && prefix.split('/').some(badName)) throw new AgentError(`"${folder}" is not a folder in the project.`);
  const files: ProjectFileInfo[] = [];
  let truncated = false;
  const walk = async (rel: string): Promise<void> => {
    const entries = (await ctx.fs.readdir(rel ? `${dir}/${rel}` : dir).catch(() => [] as FsEntry[])).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.isSymbolicLink || e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) await walk(r);
      else if (e.isFile && TEXT_FILE.test(e.name) && (!prefix || r === prefix || r.startsWith(`${prefix}/`))) {
        if (files.length >= FILE_LIMITS.files) {
          truncated = true;
          return;
        }
        files.push({ file: r, kind: fileKind(r), size: e.size ?? (await ctx.fs.stat(`${dir}/${r}`))?.size ?? 0 });
      }
    }
  };
  await walk('');
  return { files, truncated };
}

export interface ProjectFileText {
  file: string;
  kind: string;
  totalChars: number;
  start: number;
  end: number;
  truncated: boolean;
  /** Where to continue from when the file was cut short. */
  nextStart?: number;
  text: string;
}

/** A file's text, in parts when it is long (`start` continues from `nextStart` of the part before). */
export async function readProjectFile(ctx: AgentContext, project: string, file: string, opts: { start?: number; maxChars?: number } = {}): Promise<ProjectFileText> {
  const { abs, rel } = await resolve(ctx, project, file, 'read');
  const text = await ctx.fs.readText(abs);
  const start = Math.min(Math.max(Math.floor(opts.start ?? 0), 0), text.length);
  const max = Math.min(Math.max(Math.floor(opts.maxChars ?? FILE_LIMITS.readDefault), 1), FILE_LIMITS.readMax);
  let end = Math.min(start + max, text.length);
  // Cut at a line break when it costs little, so the next part starts on a whole line.
  if (end < text.length) {
    const nl = text.lastIndexOf('\n', end);
    if (nl > start + max * 0.8) end = nl + 1;
  }
  return { file: rel, kind: fileKind(rel), totalChars: text.length, start, end, truncated: end < text.length, ...(end < text.length ? { nextStart: end } : {}), text: text.slice(start, end) };
}

// ---- writing ---------------------------------------------------------------------------------

export type WriteMode = 'create' | 'replace' | 'append';

function checkContent(rel: string, content: unknown): string {
  if (typeof content !== 'string') throw new AgentError('content must be text.');
  if (content.length > FILE_LIMITS.writeCall) throw new AgentError(`content is too long for one call (${content.length} characters; the limit is ${FILE_LIMITS.writeCall}). Save it in parts: create the file with the first part, then add the rest with mode "append".`);
  if (/\.json$/i.test(rel)) {
    try {
      JSON.parse(content);
    } catch {
      throw new AgentError(`"${rel}" is a JSON file, but the content is not valid JSON.`);
    }
  }
  return content;
}

/**
 * Saves a file. `create` (the default) refuses to overwrite; `replace` overwrites and keeps the old version; `append` adds to
 * the end (a Markdown or text file only), which is how a long document is saved in parts.
 */
export function writeProjectFile(ctx: AgentContext, project: string, file: string, content: string, mode: WriteMode = 'create'): Promise<{ file: string; kind: string; mode: WriteMode; created: boolean; size: number; previous?: string }> {
  if (mode !== 'create' && mode !== 'replace' && mode !== 'append') throw new AgentError('mode must be "create", "replace" or "append".');
  return serial(`${ctx.root}/${project}`, async () => {
    const { dir, abs, rel, exists } = await resolve(ctx, project, file, 'write');
    if (mode === 'append' && /\.json$/i.test(rel)) throw new AgentError('A JSON file can’t be appended to; write the whole file with mode "replace".');
    const text = checkContent(rel, content);
    if (exists && mode === 'create') throw new AgentError(`"${rel}" already exists. Read it first. To overwrite it use mode "replace" (the old version is kept), to add to the end use "append", or save under another name.`);
    let out = text;
    let previous: string | undefined;
    if (exists) {
      const old = await ctx.fs.readText(abs);
      if (mode === 'append') out = old + (old === '' || old.endsWith('\n') ? '' : '\n') + text;
      else if (old !== text) {
        await keepPrevious(ctx, dir, rel, old);
        previous = PREVIOUS_DIR;
      }
    }
    if (out.length > FILE_LIMITS.fileMax) throw new AgentError(`"${rel}" would be larger than ${FILE_LIMITS.fileMax} characters. Split it into several files.`);
    await atomicWrite(ctx, abs, out);
    return { file: rel, kind: fileKind(rel), mode, created: !exists, size: out.length, ...(previous ? { previous: `${previous}/ (the version before this one is kept there)` } : {}) };
  });
}

/** Changes one exact piece of text in a file, like a find and replace that must find it exactly once (unless `replaceAll`). */
export function editProjectFile(ctx: AgentContext, project: string, file: string, oldText: string, newText: string, replaceAll = false): Promise<{ file: string; replaced: number; size: number }> {
  if (typeof oldText !== 'string' || oldText === '') throw new AgentError('old_text is required: the exact text to change, copied from read_project_file.');
  if (typeof newText !== 'string') throw new AgentError('new_text is required (it can be empty to delete the old text).');
  return serial(`${ctx.root}/${project}`, async () => {
    const { dir, abs, rel } = await resolve(ctx, project, file, 'write').then(async (r) => {
      if (!r.exists) throw new AgentError(`"${r.rel}" does not exist in "${project}". Use list_project_files to see the paths, or write_project_file to create it.`);
      return r;
    });
    const old = await ctx.fs.readText(abs);
    let count = 0;
    for (let i = old.indexOf(oldText); i !== -1; i = old.indexOf(oldText, i + oldText.length)) count++;
    if (count === 0) throw new AgentError('old_text was not found. Copy it exactly from read_project_file, including punctuation and line breaks.');
    if (count > 1 && !replaceAll) throw new AgentError(`old_text appears ${count} times. Include more of the text around it so it is unique, or set replace_all to change every one.`);
    const next = replaceAll ? old.split(oldText).join(newText) : old.replace(oldText, () => newText);
    checkContent(rel, next);
    if (next.length > FILE_LIMITS.fileMax) throw new AgentError(`"${rel}" would be larger than ${FILE_LIMITS.fileMax} characters.`);
    await keepPrevious(ctx, dir, rel, old);
    await atomicWrite(ctx, abs, next);
    return { file: rel, replaced: replaceAll ? count : 1, size: next.length };
  });
}

// ---- for the trackers ------------------------------------------------------------------------

/** A JSON file of the project's, or null when it isn't there. A file that is there but damaged is an error, not "empty". */
export async function readJsonFile<T>(ctx: AgentContext, dir: string, rel: string): Promise<T | null> {
  let text: string;
  try {
    text = await ctx.fs.readText(`${dir}/${rel}`);
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AgentError(`"${rel}" is damaged (not valid JSON). Read it with read_project_file to see what is wrong; the earlier versions are in .cadrel/previous/.`);
  }
}

/** Saves a tracker file or a view the tools build (inside the project, never in a manuscript folder), keeping the version it replaces. */
export async function saveToolFile(ctx: AgentContext, dir: string, rel: string, content: string): Promise<void> {
  const abs = `${dir}/${rel}`;
  const old = await ctx.fs.readText(abs).catch(() => null);
  if (old !== null && old !== content) await keepPrevious(ctx, dir, rel, old);
  await atomicWrite(ctx, abs, content);
}
