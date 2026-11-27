/**
 * The Editing page's desk: an editor's view of a manuscript and its notes. It is Write's notes, not a copy of them: every note is in the
 * project's review files, a person's comment is written by the same code that `add_notes` uses for an AI, and what an AI leaves through MCP appears
 * here as it is written. The Editing Report and the Word files are kept in the project folder too.
 *
 * Electron-free (a file-system port in, plain data out) and tested in test/editingDesk.test.ts. The shell's main process gives it the real file
 * system, the person's name and the dialogs.
 */
import { makeReviews } from '@cadrel/write/src/shared/backend/reviews';
import { analyzeManuscript, type ChapterInput } from '@cadrel/write/src/shared/analysis/analyze';
import { NO_AI_ACCESS } from '@cadrel/write/src/shared/agent/access';
import {
  addNotesAs,
  createFile,
  listChapters,
  listFiles,
  listProjects,
  projectDir,
  readChapter,
  serial,
  type AgentContext,
  type NoteInput
} from '@cadrel/write/src/shared/agent/tools';
import type { FsPort } from '@cadrel/write/src/shared/fsPort';
import { splitChapters } from '@cadrel/write/src/shared/chapters';
import {
  locateAnchor,
  newReviewFile,
  normalizeCategory,
  normalizeEditType,
  normalizeRound,
  parseReviewFile,
  serializeReviewFile,
  type ItemStatus,
  type ReviewFile,
  type ReviewItem
} from '@cadrel/write/src/shared/review/comments';
import { buildReviewDocx } from '@cadrel/write/src/shared/review/exportDocx';
import {
  autoSummary,
  computeStats,
  embedReport,
  emptyReport,
  extractReport,
  renderReportHtml,
  renderReportMarkdown,
  REPORT_SECTIONS_MAX,
  REPORT_TEXT_MAX,
  summarizeAnalysis,
  type NoteStats,
  type ReportData,
  type ReportSection
} from '@cadrel/write/src/shared/review/editingReport';
import { importTracked } from '@cadrel/write/src/shared/trackedChanges';
import type { DeskChapter, DeskManuscript, DeskNote, DeskReport, DeskText, DeskImportResult, NewDeskNote, ReportPatch } from '../shared/api';

export class DeskError extends Error {}

/** A manuscript is a Markdown file in the project's Manuscript folder; analyses and reports kept beside it are not. */
const MANUSCRIPT = /^manuscripts?\//i;
const NOT_MANUSCRIPT = /( - analysis( \d+)?|editing report)\.md$/i;
export const isManuscript = (rel: string) => MANUSCRIPT.test(rel) && /\.(md|markdown)$/i.test(rel) && !NOT_MANUSCRIPT.test(rel);

/** Where the Editing Report of a manuscript is kept, and where an uploaded Word file is kept as it came. */
export const REPORT_DIR = 'Editing';
export const ORIGINALS_DIR = 'Editing/Originals';
const stem = (rel: string) => rel.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
export const reportPathOf = (rel: string) => `${REPORT_DIR}/${stem(rel)} - Editing Report.md`;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'editor';

export interface DeskOptions {
  fs: FsPort;
  /** The folder the Write projects are in. */
  root: string;
  /** The person at the desk: their review file is `editor-<slug>`, and notes are signed with their name. */
  editor: () => string;
  now?: () => Date;
  newId?: () => string;
  /** Keeps an uploaded file as it came (a binary write, which the text-only file port cannot do). */
  keep?: (abs: string, bytes: Uint8Array) => Promise<void>;
}

export class EditingDesk {
  constructor(private readonly o: DeskOptions) {}

  private get ctx(): AgentContext {
    return {
      fs: this.o.fs,
      root: this.o.root,
      agent: 'editor',
      agentName: this.o.editor(),
      access: async () => ({ ...NO_AI_ACCESS, createFiles: true }), // a person is making the file, not an assistant
      ...(this.o.now ? { now: this.o.now } : {}),
      ...(this.o.newId ? { newId: this.o.newId } : {})
    };
  }
  private now = () => (this.o.now?.() ?? new Date()).toISOString();
  private reviewer() {
    const name = this.o.editor() || 'Editor';
    return { id: `editor-${slug(name)}`, name };
  }

  // ---- choosing a manuscript -------------------------------------------------------------------------------------------------

  /**
   * The manuscripts, and only manuscripts, of the projects in `folders` (the Write folders of the Project and Book on screen); every project when
   * `folders` is absent. Each with how many notes are on it and how many are still open.
   */
  async manuscripts(folders?: readonly string[]): Promise<DeskManuscript[]> {
    const ctx = this.ctx;
    const only = folders ? new Set(folders.map((f) => f.toLowerCase())) : null;
    const out: DeskManuscript[] = [];
    for (const { project } of await listProjects(ctx).catch(() => [])) {
      if (only && !only.has(project.toLowerCase())) continue;
      let files: Awaited<ReturnType<typeof listFiles>> = [];
      try {
        files = (await listFiles(ctx, project)).filter((f) => isManuscript(f.file));
      } catch {
        continue;
      }
      if (!files.length) continue;
      const items = await this.items(project);
      for (const f of files) {
        const mine = items.filter((i) => i.file === f.file && i.status !== 'deleted');
        out.push({ project, file: f.file, name: stem(f.file), words: f.words, chapters: f.chapters, notes: mine.length, open: mine.filter((i) => i.status === 'open').length });
      }
    }
    return out;
  }

  private async items(project: string): Promise<ReviewItem[]> {
    const dir = await projectDir(this.ctx, project);
    const out: ReviewItem[] = [];
    for (const { text } of await makeReviews(this.o.fs).list(dir)) {
      const f = parseReviewFile(text);
      if (f) out.push(...f.items.map((i) => ({ ...i, author: i.author || f.reviewer.name })));
    }
    return out;
  }

  private async assertManuscript(project: string, file: string): Promise<void> {
    if (!isManuscript(file)) throw new DeskError('Only a manuscript can be edited here: a Markdown file in the project’s Manuscript folder.');
    await projectDir(this.ctx, project); // refuses a project that is not there
  }

  // ---- reading ---------------------------------------------------------------------------------------------------------------

  /** The manuscript chapter by chapter, with its notes placed in them. */
  async read(project: string, file: string): Promise<DeskText> {
    await this.assertManuscript(project, file);
    const ctx = this.ctx;
    const list = await listChapters(ctx, project, file);
    const chapters: { index: number; key: string; title: string; text: string; words: number }[] = [];
    for (const c of list.chapters) {
      const r = await readChapter(ctx, project, file, c.index);
      chapters.push({ index: c.index, key: c.key, title: c.title, text: r.text, words: c.words });
    }
    const items = (await this.items(project)).filter((i) => i.file === file && i.status !== 'deleted');
    const placed = new Map<string, { chapter: number; start: number; end: number; state: DeskNote['state'] }>();
    for (const i of items) {
      const home = this.home(chapters, i);
      if (home) placed.set(i.id, home);
    }
    const notes: DeskNote[] = items
      .map((i): DeskNote => {
        const at = placed.get(i.id);
        return {
          id: i.id,
          kind: i.kind,
          status: i.status as Exclude<ItemStatus, 'deleted'>,
          chapter: at?.chapter ?? -1,
          start: at?.start ?? -1,
          end: at?.end ?? -1,
          state: at?.state ?? 'gone',
          quote: i.anchor.quote,
          body: i.body,
          ...(i.replacement !== undefined ? { replacement: i.replacement } : {}),
          ...(i.category ? { category: i.category } : {}),
          ...(i.editType ? { editType: i.editType } : {}),
          ...(i.round ? { round: i.round } : {}),
          origin: i.origin ?? 'human',
          author: i.author,
          createdAt: i.createdAt,
          replies: i.replies.map((r) => ({ author: r.author, body: r.body, createdAt: r.createdAt }))
        };
      })
      .sort((a, b) => (a.chapter < 0 ? 1e9 : a.chapter) - (b.chapter < 0 ? 1e9 : b.chapter) || a.start - b.start);
    const rounds = [...new Set(items.map((i) => i.round).filter((r): r is string => !!r))].sort();
    return { project, file, name: stem(file), chapters: chapters.map((c): DeskChapter => c), notes, rounds, me: this.reviewer().name };
  }

  /**
   * Where a note is now: in the chapter it says it is in (a note with a place), and there where its text is; for an old note, the first
   * chapter that has its text (the apps give old notes a place when they open the file, after which this finds them in their own chapter).
   */
  private home(chapters: { index: number; key: string; text: string }[], i: ReviewItem) {
    if (i.anchor.gone) return null;
    const own = i.anchor.v === 2 && i.anchor.chapter !== undefined && chapters.some((c) => c.key === i.anchor.chapter);
    for (const c of own ? chapters.filter((x) => x.key === i.anchor.chapter) : chapters) {
      const at = locateAnchor(c.text, i.anchor);
      if (at) return { chapter: c.index, start: at.start, end: at.end, state: (at.start === i.anchor.start ? 'same' : 'moved') as DeskNote['state'] };
    }
    return null;
  }

  // ---- notes: the same path as Write and MCP ----------------------------------------------------------------------------------

  /** Adds comments and suggestions the way `add_notes` does; each is checked on its own and the failures come back with the reason. */
  async addNotes(project: string, file: string, notes: NewDeskNote[]): Promise<{ added: number; errors: string[] }> {
    await this.assertManuscript(project, file);
    const inputs: NoteInput[] = notes.map((n) => ({
      file,
      kind: n.kind,
      quote: n.quote,
      body: n.body,
      ...(n.replacement !== undefined ? { replacement: n.replacement } : {}),
      ...(n.category ? { category: n.category } : {}),
      ...(n.editType ? { editType: n.editType } : {}),
      ...(n.round ? { round: n.round } : {}),
      ...(n.before ? { before: n.before } : {}),
      ...(n.after ? { after: n.after } : {}),
      ...(n.chapter !== undefined ? { chapter: n.chapter } : {})
    }));
    const results = await addNotesAs(this.ctx, project, this.reviewer(), inputs);
    return { added: results.filter((r) => r.ok).length, errors: results.flatMap((r) => (r.ok ? [] : [r.error])) };
  }

  /** Edits the file a note is in. */
  private async change(project: string, id: string, f: (item: ReviewItem, file: ReviewFile) => ReviewItem): Promise<void> {
    await serial(`${this.o.root}/${project}`, async () => {
      const dir = await projectDir(this.ctx, project);
      const reviews = makeReviews(this.o.fs);
      for (const { id: fileId, text } of await reviews.list(dir)) {
        const file = parseReviewFile(text);
        const item = file?.items.find((i) => i.id === id && i.status !== 'deleted');
        if (!file || !item) continue;
        const next = { ...f(item, file), updatedAt: this.now() };
        await reviews.save(dir, fileId, serializeReviewFile({ ...file, items: file.items.map((i) => (i.id === id ? next : i)) }));
        return;
      }
      throw new DeskError('That note is no longer there.');
    });
  }

  /** Sets a note open, resolved, accepted or rejected. Accepting a suggestion only marks the decision: the text is the author’s to change. */
  setStatus(project: string, id: string, status: 'open' | 'resolved' | 'accepted' | 'rejected') {
    return this.change(project, id, (i) => ({ ...i, status }));
  }

  /** Changes how a note is tagged: its edit type, round and topic. */
  tag(project: string, id: string, tags: { editType?: string | null; round?: string | null; category?: string | null }) {
    return this.change(project, id, (i) => {
      const next: ReviewItem = { ...i };
      if (tags.editType !== undefined) {
        const t = normalizeEditType(tags.editType);
        if (t) next.editType = t;
        else delete next.editType;
      }
      if (tags.round !== undefined) {
        const r = normalizeRound(tags.round);
        if (r) next.round = r;
        else delete next.round;
      }
      if (tags.category !== undefined) {
        const c = normalizeCategory(tags.category);
        if (c) next.category = c;
        else delete next.category;
      }
      return next;
    });
  }

  async reply(project: string, id: string, body: string): Promise<void> {
    const r = this.reviewer();
    const text = (body ?? '').trim();
    if (!text) throw new DeskError('A reply needs some text.');
    await this.change(project, id, (i) => ({ ...i, replies: [...i.replies, { id: this.o.newId?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, author: r.name, createdAt: this.now(), body: text }] }));
  }

  /** Removes a note this person wrote (it stays in the file marked deleted, so the removal reaches the other side of a share). */
  async remove(project: string, id: string): Promise<void> {
    const me = this.reviewer().name;
    await this.change(project, id, (i) => {
      if (i.origin === 'ai' || i.author !== me) throw new DeskError('You can remove only your own notes. Resolve or reject the others.');
      return { ...i, status: 'deleted' };
    });
  }

  // ---- uploading a document that was edited elsewhere ---------------------------------------------------------------------

  /**
   * Brings a Word document into the project's Manuscript folder as Markdown. The tracked changes and comments in it become notes on that
   * manuscript (the text before the changes), signed by whoever made them in Word.
   */
  async importDocx(project: string, bytes: Uint8Array, fileName: string): Promise<DeskImportResult> {
    const ctx = this.ctx;
    const dir = await projectDir(ctx, project);
    const parsed = (() => {
      try {
        return importTracked(bytes);
      } catch (e) {
        throw new DeskError(e instanceof Error ? e.message : 'That file could not be read.');
      }
    })();
    if (!parsed.markdown.trim()) throw new DeskError('There is no text in that document.');
    const base = fileName.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '') || 'Uploaded manuscript';
    const taken = new Set((await this.o.fs.readdir(`${dir}/Manuscript`).catch(() => [])).map((e) => e.name.toLowerCase()));
    let name = `${base}.md`;
    for (let n = 2; taken.has(name.toLowerCase()) && n < 1000; n++) name = `${base} (${n}).md`;
    const created = await createFile(ctx, project, `Manuscript/${name}`, parsed.markdown);
    if (this.o.keep) {
      await this.o.fs.mkdir(`${dir}/${ORIGINALS_DIR}`, { recursive: true });
      await this.o.keep(`${dir}/${ORIGINALS_DIR}/${fileName.replace(/[\\/:*?"<>|]+/g, ' ')}`, bytes).catch(() => undefined);
    }
    // each person's changes go in their own review file, so who made what stays clear and each can be cleared on its own
    const byAuthor = new Map<string, typeof parsed.notes>();
    for (const n of parsed.notes) byAuthor.set(n.author || 'Outside editor', [...(byAuthor.get(n.author || 'Outside editor') ?? []), n]);
    let added = 0;
    const errors: string[] = [];
    for (const [author, notes] of byAuthor) {
      const results = await addNotesAs(
        ctx,
        project,
        { id: `word-${slug(author)}`, name: author },
        notes.map((n): NoteInput => ({
          file: created.file,
          kind: n.kind,
          quote: n.quote,
          body: n.body,
          ...(n.replacement !== undefined ? { replacement: n.replacement } : {}),
          before: n.before,
          after: n.after,
          round: 'Word import'
        })),
        undefined,
        'outside'
      );
      added += results.filter((r) => r.ok).length;
      errors.push(...results.flatMap((r, k) => (r.ok ? [] : [`“${notes[k]!.quote.slice(0, 40)}”: ${r.error}`])));
    }
    return { project, file: created.file, words: created.words, chapters: created.chapters, found: parsed.found, added, notPlaced: errors };
  }

  // ---- the Word file with the notes in it ---------------------------------------------------------------------------------

  /** The manuscript as a Word file with its open notes as comments and tracked changes. */
  async exportDocx(project: string, file: string): Promise<{ name: string; bytes: Uint8Array; placed: number; skipped: number }> {
    const text = await this.read(project, file);
    const dir = await projectDir(this.ctx, project);
    const raw = await this.o.fs.readText(`${dir}/${file}`);
    const split = splitChapters(raw, 1).chapters;
    const open = (await this.items(project)).filter((i) => i.file === file && i.status === 'open');
    const where = new Map(text.notes.filter((n) => n.chapter >= 0).map((n) => [n.id, n.chapter]));
    const r = await buildReviewDocx({
      title: text.name,
      chapters: split.map((c) => ({ title: c.title, markdown: c.raw })),
      notes: open.filter((i) => where.has(i.id)),
      chapterOf: where
    });
    return { name: `${text.name} - with notes.docx`, bytes: r.bytes, placed: r.placed, skipped: r.skipped + open.filter((i) => !where.has(i.id)).length };
  }

  // ---- the Editing Report ---------------------------------------------------------------------------------------------------

  private async loadReport(project: string, file: string): Promise<ReportData> {
    const dir = await projectDir(this.ctx, project);
    const found = extractReport(await this.o.fs.readText(`${dir}/${reportPathOf(file)}`).catch(() => ''));
    return found ?? emptyReport(stem(file), this.reviewer().name, this.now());
  }

  /** The numbers and the page, worked out now from the notes, with what the editor typed. */
  async report(project: string, file: string): Promise<DeskReport> {
    await this.assertManuscript(project, file);
    const data = await this.loadReport(project, file);
    const text = await this.read(project, file);
    const stats = await this.statsFor(project, file, text, data.round);
    return { project, file, data, stats, autoSummary: autoSummary(stats, data), saved: await this.exists(project, reportPathOf(file)) };
  }

  private async statsFor(project: string, file: string, text: DeskText, round?: string): Promise<NoteStats> {
    const items = (await this.items(project)).filter((i) => i.file === file);
    const chapterOf = new Map(text.notes.map((n) => [n.id, n.chapter]));
    return computeStats(items, text.chapters, chapterOf, round);
  }

  private async exists(project: string, rel: string) {
    return !!(await this.o.fs.stat(`${await projectDir(this.ctx, project)}/${rel}`).catch(() => null));
  }

  /** What the editor types into the report: the summary, the round, the editor's name and the sections. Nothing else of it can be set from outside. */
  async saveReport(project: string, file: string, patch: ReportPatch): Promise<DeskReport> {
    await this.assertManuscript(project, file);
    const data = await this.loadReport(project, file);
    const next: ReportData = { ...data, updatedAt: this.now() };
    const clean = (s: string) => s.replace(/\r\n?/g, '\n').slice(0, REPORT_TEXT_MAX);
    if (patch.summary !== undefined) {
      const t = clean(patch.summary).trim();
      if (t) next.summary = t;
      else delete next.summary; // emptied: back to the automatic summary
    }
    if (patch.round !== undefined) {
      const r = normalizeRound(patch.round);
      if (r) next.round = r;
      else delete next.round;
    }
    if (patch.editor !== undefined) next.editor = clean(patch.editor).replace(/\n/g, ' ').trim().slice(0, 120);
    if (patch.sections !== undefined) {
      if (patch.sections.length > REPORT_SECTIONS_MAX) throw new DeskError(`A report can have up to ${REPORT_SECTIONS_MAX} sections.`);
      const seen = new Set<string>();
      next.sections = patch.sections.map((s: ReportSection, k: number) => {
        let id = (s.id || '').replace(/[^\w-]/g, '').slice(0, 40) || `s${k + 1}`;
        while (seen.has(id)) id += 'x';
        seen.add(id);
        return { id, title: clean(s.title).replace(/\n/g, ' ').trim().slice(0, 120) || 'Untitled', body: clean(s.body) };
      });
    }
    if (patch.removeAnalysis) delete next.analysis;
    await this.writeReport(project, file, next);
    return this.report(project, file);
  }

  private async writeReport(project: string, file: string, data: ReportData): Promise<void> {
    const dir = await projectDir(this.ctx, project);
    await serial(`${this.o.root}/${project}`, async () => {
      await this.o.fs.mkdir(`${dir}/${REPORT_DIR}`, { recursive: true });
      const text = await this.read(project, file);
      const stats = await this.statsFor(project, file, text, data.round);
      const target = `${dir}/${reportPathOf(file)}`;
      const tmp = `${target}.${Math.floor(Math.random() * 1e9)}.tmp`;
      await this.o.fs.writeText(tmp, embedReport(renderReportMarkdown(data, stats), data));
      await this.o.fs.rename(tmp, target);
    });
  }

  /** Runs the text analysis on the manuscript and attaches what it found to the report (replacing an earlier one). */
  async attachAnalysis(project: string, file: string): Promise<DeskReport> {
    await this.assertManuscript(project, file);
    const dir = await projectDir(this.ctx, project);
    const raw = await this.o.fs.readText(`${dir}/${file}`);
    const inputs: ChapterInput[] = splitChapters(raw, 1)
      .chapters.map((c) => ({ title: c.title, isPreamble: c.isPreamble, raw: c.raw }))
      .filter((c) => !c.isPreamble || /\p{L}/u.test(c.raw.replace(/^\s*#.*$/gm, '')));
    const analysis = await analyzeManuscript(inputs);
    const data = await this.loadReport(project, file);
    await this.writeReport(project, file, { ...data, analysis: summarizeAnalysis(analysis, this.now().slice(0, 10)), updatedAt: this.now() });
    return this.report(project, file);
  }

  /** The report as the page that is printed to PDF (the shell prints it). Saves the report file first, so it is on disk as it is exported. */
  async reportPage(project: string, file: string): Promise<{ html: string; name: string }> {
    await this.assertManuscript(project, file);
    const data = await this.loadReport(project, file);
    await this.writeReport(project, file, data);
    const stats = await this.statsFor(project, file, await this.read(project, file), data.round);
    return { html: renderReportHtml(data, stats), name: `${stem(file)} - Editing Report.pdf` };
  }
}
