/**
 * What an AI reviewer can do in a project: read chapters and leave comments and suggestions. Plain functions over `FsPort`
 * (no MCP, no Electron), so they are tested directly and any transport (MCP now, REST later) can wrap them.
 *
 * The one rule that matters: nothing here ever writes a manuscript file. The only files written are review files under
 * `<project>/.mdedit/review/`, one per agent and editing pass, which MDEdit shows beside everyone else's notes, and the
 * project's edited-chapter marks (`<project>/.mdedit/edited.json`), which `set_chapters_edited` can change.
 */
import { splitChapters } from '../chapters';
import type { FsEntry, FsPort } from '../fsPort';
import { makeReviews, REVIEW_DIR } from '../backend/reviews';
import {
  locateAnchor,
  makeAnchor,
  newReviewFile,
  normalizeCategory,
  parseReviewFile,
  serializeReviewFile,
  type ItemStatus,
  type ReviewFile,
  type ReviewItem,
} from '../review/comments';
import { applyMap, EDITED_FILE, emptyMarks, marksToMap, sanitizeMarks, type EditedMarks } from '../editedMarks';
import { chapterIds, withChapterEdited } from '../projects';
import { classify, SHARED_WITH_ME } from '../sync/rules';
import { countWords } from '../words';
import { flattenMarkdown } from './flatten';

/** Skills MDEdit ships; anything else a skill calls itself is used as given. */
const KNOWN_SKILLS: Record<string, string> = { developmental: 'Developmental edit', line: 'Line edit', copy: 'Copy edit' };

export const LIMITS = {
  notesPerCall: 50,
  /** Open notes one reviewer may have in a project; resolved, accepted, rejected and deleted notes don't count. */
  openNotesPerFile: 1000,
  commentQuote: 600,
  suggestionQuote: 300,
  body: 4000,
  replacement: 2000,
  files: 600,
  chaptersPerCall: 500,
  /** Words above which `read_chapter` warns that the chapter is long. */
  longChapter: 15000,
} as const;

export interface AgentContext {
  fs: FsPort;
  /** The Root Folder: every project is a folder directly inside it. */
  root: string;
  /** Short id of the AI, used in the review file name (`ai-<agent>-<pass>`), e.g. "claude" or "gpt". */
  agent: string;
  /** How the AI is shown in the Notes panel, e.g. "Claude". */
  agentName: string;
  now?: () => Date;
  newId?: () => string;
}

/** A mistake the caller (the model) can correct; the message says how. */
export class AgentError extends Error {}

const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
const uid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
const join = (a: string, b: string) => `${a.replace(/[\\/]+$/, '')}/${b}`;

/**
 * Who a note is signed as. With no skill it is just the AI ("Claude", file `ai-claude`); a skill adds its own tag
 * ("Claude · Line edit", file `ai-claude-line`), so each skill's notes can be filtered or cleared on their own.
 * "line", "line-editing" and "Line edit" all mean the shipped line-edit skill.
 */
export function reviewerFor(ctx: AgentContext, skill?: string): { id: string; name: string } {
  const base = `ai-${safe(ctx.agent) || 'ai'}`;
  const label = (skill ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!label) return { id: base, name: ctx.agentName };
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const short = slug.replace(/-(editing|edit)$/, '');
  const known = KNOWN_SKILLS[short];
  return { id: `${base}-${known ? short : slug || 'skill'}`, name: `${ctx.agentName} · ${known ?? label}` };
}

// ---- finding things on disk ------------------------------------------------------------------

async function child(fs: FsPort, dir: string, name: string): Promise<FsEntry | undefined> {
  const entries = await fs.readdir(dir).catch(() => [] as FsEntry[]);
  return entries.find((e) => e.name === name && !e.isSymbolicLink);
}

const badName = (s: string) => !s || s === '.' || s === '..' || s.startsWith('.') || /[\\/:]/.test(s);

/** Prefix of the names under which projects shared with this person for editing are listed. */
const SHARED_PREFIX = `${SHARED_WITH_ME}/`;

/** True when `dir` is a project this person was invited to edit (not just to review), by its marker file. */
async function isCollaboration(ctx: AgentContext, dir: string): Promise<boolean> {
  try {
    return (JSON.parse(await ctx.fs.readText(`${dir}/.mdedit/shared.json`)) as { role?: unknown }).role === 'edit';
  } catch {
    return false;
  }
}

/**
 * The project folder: a real folder directly inside the Root, or a project shared with this person for editing, which is named
 * "Shared With Me/<folder>". Projects shared for review only are never offered, since the author owns the notes on those.
 */
async function projectDir(ctx: AgentContext, project: string): Promise<string> {
  if (typeof project === 'string' && project.startsWith(SHARED_PREFIX)) {
    const name = project.slice(SHARED_PREFIX.length);
    const holder = await child(ctx.fs, ctx.root, SHARED_WITH_ME);
    const e = !badName(name) && holder?.isDirectory ? await child(ctx.fs, join(ctx.root, SHARED_WITH_ME), name) : undefined;
    const dir = join(join(ctx.root, SHARED_WITH_ME), name);
    if (e?.isDirectory && (await isCollaboration(ctx, dir))) return dir;
    throw new AgentError(`There is no project called "${project}". Use list_projects to see the names.`);
  }
  if (typeof project !== 'string' || badName(project)) throw new AgentError(`"${project}" is not a project name. Use a name from list_projects.`);
  const e = await child(ctx.fs, ctx.root, project);
  if (!e?.isDirectory) throw new AgentError(`There is no project called "${project}". Use list_projects to see the names.`);
  return join(ctx.root, project);
}

/** A manuscript file inside the project. Each step is looked up in its folder listing, so symlinks and `..` can't get through. */
async function manuscriptPath(ctx: AgentContext, project: string, file: string): Promise<{ abs: string; rel: string }> {
  const dir = await projectDir(ctx, project);
  const parts = typeof file === 'string' ? file.split('/') : [];
  if (!parts.length || parts.some(badName) || !/\.(md|markdown)$/i.test(parts[parts.length - 1])) {
    throw new AgentError(`"${file}" is not a manuscript file. Use a path from list_files, like "Manuscript/Chapter 1.md".`);
  }
  let abs = dir;
  for (let i = 0; i < parts.length; i++) {
    const e = await child(ctx.fs, abs, parts[i]);
    const last = i === parts.length - 1;
    if (!e || (last ? !e.isFile : !e.isDirectory)) throw new AgentError(`"${file}" does not exist in "${project}". Use list_files to see the paths.`);
    abs = join(abs, parts[i]);
  }
  return { abs, rel: parts.join('/') };
}

async function chapterLevel(ctx: AgentContext, dir: string): Promise<number> {
  try {
    const level = (JSON.parse(await ctx.fs.readText(`${dir}/.mdedit/project.json`)) as { chapterLevel?: unknown }).chapterLevel;
    if (typeof level === 'number' && level >= 1 && level <= 6) return level;
  } catch {
    /* no project file: use the default */
  }
  return 1;
}

interface Loaded {
  rel: string;
  chapters: { index: number; title: string; isPreamble: boolean; raw: string; flat: string }[];
}

async function load(ctx: AgentContext, project: string, file: string): Promise<Loaded> {
  const { abs, rel } = await manuscriptPath(ctx, project, file);
  const dir = await projectDir(ctx, project);
  const doc = splitChapters(await ctx.fs.readText(abs), await chapterLevel(ctx, dir));
  return { rel, chapters: doc.chapters.map((c, index) => ({ index, title: c.title, isPreamble: c.isPreamble, raw: c.raw, flat: flattenMarkdown(c.raw) })) };
}

// ---- reading ---------------------------------------------------------------------------------

export async function listProjects(ctx: AgentContext): Promise<{ project: string; status: string | null }[]> {
  const out: { project: string; status: string | null }[] = [];
  for (const e of (await ctx.fs.readdir(ctx.root).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory || e.isSymbolicLink || e.name.startsWith('.') || e.name === 'Shared With Me') continue;
    let status: string | null = null;
    try {
      const p = JSON.parse(await ctx.fs.readText(`${join(ctx.root, e.name)}/.mdedit/project.json`)) as { status?: unknown };
      status = typeof p.status === 'string' ? p.status : null;
    } catch {
      continue; // not a project (no project.json)
    }
    out.push({ project: e.name, status });
  }
  // Projects other authors invited this person to work on.
  const holder = join(ctx.root, SHARED_WITH_ME);
  for (const e of (await ctx.fs.readdir(holder).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory && !e.isSymbolicLink && !badName(e.name) && (await isCollaboration(ctx, join(holder, e.name)))) out.push({ project: `${SHARED_PREFIX}${e.name}`, status: null });
  }
  return out;
}

export async function listFiles(ctx: AgentContext, project: string): Promise<{ file: string; words: number; chapters: number }[]> {
  const dir = await projectDir(ctx, project);
  const out: { file: string; words: number; chapters: number }[] = [];
  const level = await chapterLevel(ctx, dir);
  const walk = async (rel: string): Promise<void> => {
    const entries = (await ctx.fs.readdir(rel ? `${dir}/${rel}` : dir)).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.isSymbolicLink || e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) await walk(r);
      else if (e.isFile && out.length < LIMITS.files && classify(`p/${r}`) === 'prose') {
        const text = await ctx.fs.readText(`${dir}/${r}`);
        out.push({ file: r, words: countWords(text), chapters: splitChapters(text, level).chapters.length });
      }
    }
  };
  await walk('');
  return out;
}

export async function listChapters(ctx: AgentContext, project: string, file: string) {
  const { rel, chapters } = await load(ctx, project, file);
  const ids = chapterIds(chapters);
  const edited = new Set(marksToMap(await readMarks(ctx, await projectDir(ctx, project)))[rel] ?? []);
  return { file: rel, chapters: chapters.map((c, i) => ({ index: c.index, title: c.title || '(before the first heading)', words: countWords(c.raw), edited: edited.has(ids[i]) })) };
}

// ---- edited marks ----------------------------------------------------------------------------

const marksFile = (dir: string) => `${dir}/.mdedit/${EDITED_FILE}`;

/** The project's edited-chapter marks (a damaged or missing file reads as no marks). */
async function readMarks(ctx: AgentContext, dir: string): Promise<EditedMarks> {
  try {
    return sanitizeMarks(JSON.parse(await ctx.fs.readText(marksFile(dir))));
  } catch {
    return emptyMarks();
  }
}

/**
 * Marks chapters of a file as edited, or unmarks them: the same marks as "Mark Edited" and "Unmark Edited" in the tree's
 * right-click menu. Name the chapters, or give `through` for every chapter from the first up to and including that one
 * ("Mark Edited to Here"). Marking a chapter that is already marked changes nothing.
 */
export function setChaptersEdited(ctx: AgentContext, project: string, file: string, sel: { chapters?: (number | string)[]; through?: number | string }, edited: boolean) {
  const hasList = Array.isArray(sel.chapters) && sel.chapters.length > 0;
  if (hasList === (sel.through !== undefined)) throw new AgentError('Give either chapters (a list of chapter numbers or headings) or through (one chapter number or heading), not both and not neither.');
  if (hasList && sel.chapters!.length > LIMITS.chaptersPerCall) throw new AgentError(`At most ${LIMITS.chaptersPerCall} chapters per call; use through to cover a run from the start.`);
  return serial(`${ctx.root}/${project}`, async () => {
    const l = await load(ctx, project, file);
    const dir = await projectDir(ctx, project);
    const ids = chapterIds(l.chapters);
    const targets = hasList ? sel.chapters!.map((c) => pickChapter(l, c).index) : Array.from({ length: pickChapter(l, sel.through!).index + 1 }, (_, i) => i);
    const before = await readMarks(ctx, dir);
    const was = new Set(marksToMap(before)[l.rel] ?? []);
    let map = marksToMap(before);
    const changed: number[] = [];
    for (const i of new Set(targets)) {
      if (was.has(ids[i]) === edited) continue;
      map = withChapterEdited(map, l.rel, ids[i], edited);
      changed.push(i);
    }
    if (changed.length) {
      const after = applyMap(before, map, (ctx.now?.() ?? new Date()).getTime());
      await ctx.fs.mkdir(`${dir}/.mdedit`, { recursive: true });
      const target = marksFile(dir);
      const tmp = `${target}.${Math.floor(Math.random() * 1e9)}.tmp`;
      try {
        await ctx.fs.writeText(tmp, JSON.stringify(after, null, 2) + '\n');
        await ctx.fs.rename(tmp, target);
      } catch (e) {
        await ctx.fs.rm(tmp, { force: true }).catch(() => undefined);
        throw e;
      }
    }
    return { file: l.rel, edited, changed: changed.map((i) => ({ index: i, title: l.chapters[i].title || '(before the first heading)' })), unchanged: new Set(targets).size - changed.length };
  });
}

function pickChapter(l: Loaded, chapter: number | string) {
  const hit = typeof chapter === 'number' ? l.chapters[chapter] : l.chapters.find((c) => c.title.trim().toLowerCase() === String(chapter).trim().toLowerCase());
  if (!hit) throw new AgentError(`No chapter "${chapter}" in ${l.rel}. Use list_chapters; chapters are numbered from 0.`);
  return hit;
}

export interface NoteView {
  id: string;
  file: string;
  kind: 'comment' | 'suggestion';
  status: ItemStatus;
  reviewer: string;
  category?: string;
  quote: string;
  body: string;
  replacement?: string;
  replies: { author: string; body: string }[];
  createdAt: string;
}

async function readAllReviews(ctx: AgentContext, project: string): Promise<Map<string, ReviewFile>> {
  const dir = await projectDir(ctx, project);
  const out = new Map<string, ReviewFile>();
  for (const { id, text } of await makeReviews(ctx.fs).list(dir)) {
    const f = parseReviewFile(text);
    if (f) out.set(id, f);
  }
  return out;
}

const view = (i: ReviewItem, reviewer: string): NoteView => ({
  id: i.id,
  file: i.file,
  kind: i.kind,
  status: i.status,
  reviewer,
  ...(i.category ? { category: i.category } : {}),
  quote: i.anchor.quote,
  body: i.body,
  ...(i.replacement !== undefined ? { replacement: i.replacement } : {}),
  replies: i.replies.map((r) => ({ author: r.author, body: r.body })),
  createdAt: i.createdAt,
});

export interface NoteFilter {
  file?: string;
  status?: ItemStatus;
  kind?: 'comment' | 'suggestion';
  /** Substring of the reviewer's name, e.g. "Line edit" or "Sam". */
  reviewer?: string;
  category?: string;
}

async function collect(ctx: AgentContext, project: string, f: NoteFilter): Promise<{ item: ReviewItem; reviewer: string }[]> {
  const out: { item: ReviewItem; reviewer: string }[] = [];
  for (const file of (await readAllReviews(ctx, project)).values()) {
    for (const i of file.items) {
      if (i.status === 'deleted') continue;
      if (f.file && i.file !== f.file) continue;
      if (f.status && i.status !== f.status) continue;
      if (f.kind && i.kind !== f.kind) continue;
      if (f.category && i.category !== f.category) continue;
      if (f.reviewer && !file.reviewer.name.toLowerCase().includes(f.reviewer.toLowerCase())) continue;
      out.push({ item: i, reviewer: file.reviewer.name });
    }
  }
  return out.sort((a, b) => a.item.createdAt.localeCompare(b.item.createdAt));
}

/** Notes in a project, deleted ones left out. */
export async function getNotes(ctx: AgentContext, project: string, f: NoteFilter = {}): Promise<NoteView[]> {
  return (await collect(ctx, project, f)).map((n) => view(n.item, n.reviewer));
}

/**
 * One chapter as plain text, which is also the text `add_notes` quotes must match: formatting marks are removed and each
 * paragraph is on its own line. Notes already on the chapter come with it, so they aren't repeated.
 */
export async function readChapter(ctx: AgentContext, project: string, file: string, chapter: number | string, opts: { markdown?: boolean } = {}) {
  const l = await load(ctx, project, file);
  const c = pickChapter(l, chapter);
  const words = countWords(c.raw);
  const notes = (await collect(ctx, project, { file: l.rel })).filter((n) => n.item.status !== 'rejected' && locateAnchor(c.flat, n.item.anchor)).map((n) => view(n.item, n.reviewer));
  return {
    file: l.rel,
    index: c.index,
    title: c.title,
    words,
    ...(words > LIMITS.longChapter ? { warning: `This chapter is long (${words} words). Work through it in sections and keep notes specific.` } : {}),
    text: c.flat,
    ...(opts.markdown ? { markdown: c.raw } : {}),
    notes,
  };
}

export interface SearchHit {
  file: string;
  chapter: number;
  chapterTitle: string;
  /** The matched text, and a little of what surrounds it. */
  match: string;
  snippet: string;
}

/**
 * Finds text across a project's manuscript files (in the same plain text `read_chapter` returns), for checking that a name,
 * term or spelling is used the same way everywhere. At most `limit` hits (default 30, at most 100).
 */
export async function searchText(
  ctx: AgentContext,
  project: string,
  query: string,
  opts: { file?: string; regex?: boolean; caseSensitive?: boolean; limit?: number } = {}
): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  if (typeof query !== 'string' || !query || query.length > 200) throw new AgentError('query must be 1 to 200 characters.');
  let re: RegExp;
  try {
    re = new RegExp(opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.caseSensitive ? 'g' : 'gi');
  } catch {
    throw new AgentError('That is not a valid regular expression.');
  }
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 30), 1), 100);
  const files = opts.file ? [opts.file] : (await listFiles(ctx, project)).map((f) => f.file);
  const hits: SearchHit[] = [];
  for (const f of files) {
    const l = await load(ctx, project, f);
    for (const c of l.chapters) {
      re.lastIndex = 0;
      for (let m = re.exec(c.flat); m; m = re.exec(c.flat)) {
        if (m[0] === '') {
          re.lastIndex += 1;
          continue;
        }
        if (hits.length >= limit) return { hits, truncated: true };
        hits.push({ file: l.rel, chapter: c.index, chapterTitle: c.title, match: m[0], snippet: c.flat.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).replace(/\n/g, ' ¶ ') });
      }
    }
  }
  return { hits, truncated: false };
}

// ---- writing notes ---------------------------------------------------------------------------

export interface NoteInput {
  file: string;
  kind: 'comment' | 'suggestion';
  /** Exact text from read_chapter that the note is about. */
  quote: string;
  /** Comments: the point. Suggestions: why (optional). */
  body?: string;
  /** Suggestions: the text that should replace the quote. */
  replacement?: string;
  category?: string;
  /** Text immediately before / after the quote, to pick one of several matches. */
  before?: string;
  after?: string;
  /** Limit the search to one chapter. */
  chapter?: number;
}

export type NoteResult = { ok: true; id: string; chapter: number; chapterTitle: string; context: string } | { ok: false; error: string };

// Same-length look-alikes, so a quote typed with straight quotes can be matched to the curly ones in the text.
const loose = (s: string) => s.replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"').replace(/[–—−]/g, '-').replace(/[  ]/g, ' ');

function occurrences(hay: string, needle: string): number[] {
  const at: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) at.push(i);
  return at;
}

function build(ctx: AgentContext, l: Loaded, input: NoteInput, reviewer: { id: string; name: string }, existing: ReviewItem[]): { item: ReviewItem; chapter: Loaded['chapters'][number]; start: number } {
  const kind = input.kind;
  if (kind !== 'comment' && kind !== 'suggestion') throw new AgentError('kind must be "comment" or "suggestion".');
  const quote = input.quote;
  if (typeof quote !== 'string' || !quote.trim()) throw new AgentError('quote is required: the exact text the note is about.');
  const maxQuote = kind === 'suggestion' ? LIMITS.suggestionQuote : LIMITS.commentQuote;
  if (quote.length > maxQuote) throw new AgentError(`quote is too long (${quote.length} characters; the limit is ${maxQuote}). Quote the smallest part that identifies the spot.`);
  const body = (input.body ?? '').trim();
  if (body.length > LIMITS.body) throw new AgentError(`body is too long (limit ${LIMITS.body} characters).`);
  if (kind === 'comment' && !body) throw new AgentError('A comment needs a body: the point you are making.');
  let replacement: string | undefined;
  if (kind === 'suggestion') {
    if (typeof input.replacement !== 'string') throw new AgentError('A suggestion needs a replacement (it can be empty to suggest deleting the quote).');
    replacement = input.replacement;
    if (replacement.length > LIMITS.replacement) throw new AgentError(`replacement is too long (limit ${LIMITS.replacement} characters).`);
    if (/[\r\n]/.test(quote) || /[\r\n]/.test(replacement)) throw new AgentError('A suggestion must sit inside one paragraph: quote and replacement can’t contain line breaks. Use a comment, or one suggestion per paragraph.');
    if (replacement === quote) throw new AgentError('The replacement is the same as the quote.');
  }

  const pool = input.chapter === undefined ? l.chapters : [pickChapter(l, input.chapter)];
  const hits: { chapter: Loaded['chapters'][number]; start: number }[] = [];
  for (const c of pool) {
    for (const start of occurrences(c.flat, quote)) {
      if (input.before && !c.flat.slice(0, start).endsWith(input.before)) continue;
      if (input.after && !c.flat.slice(start + quote.length).startsWith(input.after)) continue;
      hits.push({ chapter: c, start });
    }
  }
  if (hits.length === 0) {
    const near = pool.flatMap((c) => occurrences(loose(c.flat), loose(quote)).map((start) => c.flat.slice(start, start + quote.length)));
    throw new AgentError(
      near.length
        ? `The quote is not in the text exactly as written. Closest text: "${near[0]}". Copy the quote from read_chapter, including curly quotes and dashes.`
        : `The quote was not found${input.before || input.after ? ' with that before/after text' : ''}. Quote text exactly as read_chapter returned it (plain text, no Markdown marks).`
    );
  }
  if (hits.length > 1) {
    const where = [...new Set(hits.map((h) => h.chapter.index))].join(', ');
    throw new AgentError(`The quote appears ${hits.length} times (chapters ${where}). Add "before" or "after" (the words right next to it), a longer quote, or "chapter".`);
  }
  const { chapter, start } = hits[0];
  const now = (ctx.now?.() ?? new Date()).toISOString();
  const item: ReviewItem = {
    id: ctx.newId?.() ?? uid(),
    kind,
    file: l.rel,
    anchor: makeAnchor(chapter.flat, start, start + quote.length),
    body,
    ...(replacement !== undefined ? { replacement } : {}),
    status: 'open',
    ...(normalizeCategory(input.category) ? { category: normalizeCategory(input.category) } : {}),
    origin: 'ai',
    author: reviewer.name,
    createdAt: now,
    updatedAt: now,
    replies: [],
  };
  const dup = existing.find((i) => i.status !== 'deleted' && i.file === item.file && i.kind === kind && i.anchor.quote === quote && i.body === body && i.replacement === replacement);
  if (dup) throw new AgentError(`You already left this note (${dup.id}).`);
  return { item, chapter, start };
}

// Writes to one project's review files happen one at a time, so two calls can't overwrite each other.
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, job: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(job, job);
  queues.set(key, run.catch(() => undefined));
  return run;
}

async function readFile(ctx: AgentContext, dir: string, id: string): Promise<ReviewFile | null> {
  return parseReviewFile(await ctx.fs.readText(`${dir}/${REVIEW_DIR}/${id}.json`).catch(() => ''));
}

/** Adds up to 50 notes. Each is checked on its own: the good ones are saved and the rest come back with the reason. */
export function addNotes(ctx: AgentContext, project: string, skill: string | undefined, notes: NoteInput[]): Promise<NoteResult[]> {
  const reviewer = reviewerFor(ctx, skill);
  if (!Array.isArray(notes) || !notes.length) throw new AgentError('notes must be a list with at least one note.');
  if (notes.length > LIMITS.notesPerCall) throw new AgentError(`At most ${LIMITS.notesPerCall} notes per call; send the rest in another call.`);
  return serial(`${ctx.root}/${project}`, async () => {
    const dir = await projectDir(ctx, project);
    const file = (await readFile(ctx, dir, reviewer.id)) ?? newReviewFile(project, reviewer);
    const loaded = new Map<string, Loaded>();
    const results: NoteResult[] = [];
    const created: ReviewItem[] = [];
    for (const input of notes) {
      try {
        if (file.items.filter((i) => i.status === 'open').length + created.length >= LIMITS.openNotesPerFile) throw new AgentError(`This reviewer already has ${LIMITS.openNotesPerFile} open notes in the project. Ask the author to resolve or clear some first.`);
        const { rel } = await manuscriptPath(ctx, project, input.file);
        let l = loaded.get(rel);
        if (!l) loaded.set(rel, (l = await load(ctx, project, rel)));
        const { item, chapter, start } = build(ctx, l, input, reviewer, [...file.items, ...created]);
        created.push(item);
        results.push({ ok: true, id: item.id, chapter: chapter.index, chapterTitle: chapter.title, context: chapter.flat.slice(Math.max(0, start - 30), start + item.anchor.quote.length + 30) });
      } catch (e) {
        if (!(e instanceof AgentError)) throw e;
        results.push({ ok: false, error: e.message });
      }
    }
    if (created.length) await makeReviews(ctx.fs).save(dir, reviewer.id, serializeReviewFile({ ...file, items: [...file.items, ...created] }));
    return results;
  });
}

// ---- replies and withdrawing -----------------------------------------------------------------

async function findNote(ctx: AgentContext, project: string, id: string): Promise<{ fileId: string; file: ReviewFile; item: ReviewItem }> {
  for (const [fileId, file] of await readAllReviews(ctx, project)) {
    const item = file.items.find((i) => i.id === id && i.status !== 'deleted');
    if (item) return { fileId, file, item };
  }
  throw new AgentError(`There is no note with id "${id}". Use get_notes to find it.`);
}

/** Adds a reply to any note (for example to answer the author's reply). It changes nothing else about the note. */
export function replyToNote(ctx: AgentContext, project: string, skill: string | undefined, noteId: string, body: string): Promise<{ id: string }> {
  const reviewer = reviewerFor(ctx, skill);
  const text = (body ?? '').trim();
  if (!text || text.length > LIMITS.body) throw new AgentError(`A reply needs some text (up to ${LIMITS.body} characters).`);
  return serial(`${ctx.root}/${project}`, async () => {
    const dir = await projectDir(ctx, project);
    const { fileId, file, item } = await findNote(ctx, project, noteId);
    const now = (ctx.now?.() ?? new Date()).toISOString();
    const reply = { id: ctx.newId?.() ?? uid(), author: reviewer.name, createdAt: now, body: text };
    const next: ReviewFile = { ...file, items: file.items.map((i) => (i.id === item.id ? { ...i, replies: [...i.replies, reply], updatedAt: now } : i)) };
    await makeReviews(ctx.fs).save(dir, fileId, serializeReviewFile(next));
    return { id: reply.id };
  });
}

/** Removes one of the AI's own notes. Notes by people, and the AI's notes the author has already accepted, are left alone. */
export function withdrawNote(ctx: AgentContext, project: string, noteId: string): Promise<{ id: string }> {
  return serial(`${ctx.root}/${project}`, async () => {
    const dir = await projectDir(ctx, project);
    const { fileId, file, item } = await findNote(ctx, project, noteId);
    if (!fileId.startsWith('ai-') || item.origin !== 'ai') throw new AgentError('Only notes written by an AI reviewer can be withdrawn.');
    if (item.status === 'accepted') throw new AgentError('The author already accepted this suggestion, so it can’t be withdrawn.');
    const now = (ctx.now?.() ?? new Date()).toISOString();
    const next: ReviewFile = { ...file, items: file.items.map((i) => (i.id === item.id ? { ...i, status: 'deleted' as const, updatedAt: now } : i)) };
    await makeReviews(ctx.fs).save(dir, fileId, serializeReviewFile(next));
    return { id: item.id };
  });
}
