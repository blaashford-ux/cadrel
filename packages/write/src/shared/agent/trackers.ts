/**
 * The tracker tools: the two ledgers (LitRPG mechanics, timeline) kept as JSON files in the project's Tracking folder, logged to
 * with validated events, checked, queried "as of" a chapter or day, and drawn as HTML views. Plain functions over `FsPort`.
 *
 * The ledgers are only ever changed through the log functions, which keep the earlier version under `.cadrel/previous/`.
 */
import {
  appendEvents,
  carryLedger,
  dashboardModel,
  flagsForThisBook,
  FLAG_TYPES,
  mergeFlags,
  normalizeLedger,
  parseEvent,
  refresh,
  replay,
  runChecks,
  sheetModel,
  type CharacterDelta,
  type CharacterState,
  type LedgerFlag,
  type LitrpgLedger,
} from './litrpg';
import { chapterRecordModel, chapterRecordPath, chaptersOf } from './chapterRecords';
import { readJsonFile, saveToolFile } from './projectFiles';
import {
  chapterAsOfDay,
  mergeDay,
  mergeTimelineFlags,
  normalizeTimeline,
  orderedDays,
  runTimelineChecks,
  timelineModel,
  TIMELINE_FLAG_TYPES,
  type DayInput,
  type TimelineFlag,
  type TimelineLedger,
} from './timeline';
import { renderView } from './views';
import { AgentError, projectDir, serial, type AgentContext } from './tools';

export const TRACKER_PATHS = {
  litrpg: 'Tracking/LitRPG Ledger.json',
  timeline: 'Tracking/Timeline Ledger.json',
  timelineView: 'Tracking/Timeline.html',
  dashboard: 'Tracking/LitRPG Dashboard.html',
  sheets: 'Tracking/Character Sheets',
} as const;

export const TRACKER_LIMITS = { charactersPerCall: 40, eventsPerCall: 300, daysPerCall: 100 } as const;

/** The HTML templates (assets of the tracker skills) the views are drawn from. */
export interface ViewTemplates {
  timeline: string;
  litrpg: string;
  sheet: string;
  /** The page for one chapter's permanent record (see chapterRecords.ts). */
  chapter: string;
}

const projectTitle = (ctx: AgentContext, project: string) => project.replace(/^Shared With Me\//, '');
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const safeFile = (s: string) => s.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Character';

async function loadLitrpg(ctx: AgentContext, dir: string, project: string): Promise<{ ledger: LitrpgLedger; existed: boolean }> {
  const raw = await readJsonFile<unknown>(ctx, dir, TRACKER_PATHS.litrpg);
  return { ledger: normalizeLedger(raw, projectTitle(ctx, project)), existed: raw !== null };
}
/** The ledgers of the Books before this one (their folders, in order), for reading this Book's ledger with theirs in front of it. */
async function loadEarlier(ctx: AgentContext, earlier: string[] | undefined): Promise<LitrpgLedger[]> {
  const out: LitrpgLedger[] = [];
  for (const folder of earlier ?? []) {
    const dir = await projectDir(ctx, folder).catch(() => null);
    if (!dir) continue;
    const raw = await readJsonFile<unknown>(ctx, dir, TRACKER_PATHS.litrpg);
    if (raw !== null) out.push(normalizeLedger(raw, projectTitle(ctx, folder)));
  }
  return out;
}
/**
 * Writes the permanent record of each of these chapters (`Tracking/Chapters/Chapter N.html`) from the ledgers as they now stand: what was
 * logged for the chapter and where each character stands after it (with the earlier Books in front), and the in-story days it narrates. A record
 * is only rewritten when it would change, and the version it replaces is kept (saveToolFile), so nothing once recorded is ever lost.
 * Returns the files written. Does nothing without the page template.
 */
async function writeChapterRecords(ctx: AgentContext, dir: string, project: string, chapters: number[], templates: ViewTemplates | undefined, earlier: string[] | undefined): Promise<string[]> {
  if (!templates?.chapter) return [];
  const own = await loadLitrpg(ctx, dir, project);
  const before = await loadEarlier(ctx, earlier);
  const litrpg = own.existed || before.length ? (before.length ? carryLedger(own.ledger, before) : own.ledger) : null;
  const tl = await loadTimeline(ctx, dir, project);
  const timeline = tl.existed ? tl.ledger : null;
  const title = projectTitle(ctx, project);
  const now = new Date().toISOString();
  const written: string[] = [];
  for (const chapter of [...new Set(chapters)].filter((c) => c > 0).sort((a, b) => a - b)) {
    const rel = chapterRecordPath(chapter);
    const old = await ctx.fs.readText(`${dir}/${rel}`).catch(() => null);
    const at = old ? /"recorded_at":"([^"]+)"/.exec(old)?.[1] : undefined;
    const draw = (stamp: string) => {
      const model = chapterRecordModel({ project: title, chapter, litrpg, timeline, now: stamp });
      return model ? renderView(templates.chapter, `${title} Chapter ${chapter} record`, model) : null;
    };
    const same = at ? draw(at) : null;
    if (same !== null && same === old) continue; // nothing about this chapter changed
    const html = draw(now);
    if (html === null) continue; // neither ledger says anything about it
    await saveToolFile(ctx, dir, rel, html);
    written.push(rel);
  }
  return written;
}

async function loadTimeline(ctx: AgentContext, dir: string, project: string): Promise<{ ledger: TimelineLedger; existed: boolean }> {
  const raw = await readJsonFile<unknown>(ctx, dir, TRACKER_PATHS.timeline);
  return { ledger: normalizeTimeline(raw, projectTitle(ctx, project)), existed: raw !== null };
}

const resolveFlags = <T extends { id: string; status: string }>(flags: T[], ids: unknown): string[] => {
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string')) throw new AgentError('resolve_flags must be a list of flag ids, such as ["f1", "f3"].');
  for (const id of ids as string[]) {
    const f = flags.find((x) => x.id === id);
    if (!f) throw new AgentError(`There is no flag "${id}". The ids are on the flags returned by check_tracker.`);
    f.status = 'resolved';
  }
  return ids as string[];
};

// ---- LitRPG --------------------------------------------------------------------------------

export interface LitrpgLogInput {
  characters?: { name: string; events: unknown[] }[];
  flags?: { type: string; character?: string; chapters_involved?: number[]; description: string }[];
  resolve_flags?: string[];
  last_updated_chapter?: number;
}

/**
 * Appends events to the mechanics ledger (creating it on first use), recomputes each character's state from the log, runs the
 * arithmetic checks, and reports only what changed. Nothing is saved if any event is invalid, so a batch is all or nothing.
 */
export function litrpgLog(ctx: AgentContext, project: string, input: LitrpgLogInput, opts: { templates?: ViewTemplates; earlier?: string[] } = {}) {
  const chars = input.characters ?? [];
  if (!Array.isArray(chars) || (chars.length === 0 && !input.flags?.length && !input.resolve_flags?.length)) throw new AgentError('Give characters: a list of { name, events }, where each event is { type, chapter, details }.');
  if (chars.length > TRACKER_LIMITS.charactersPerCall) throw new AgentError(`At most ${TRACKER_LIMITS.charactersPerCall} characters per call.`);
  const total = chars.reduce((n, c) => n + (Array.isArray(c.events) ? c.events.length : 0), 0);
  if (total > TRACKER_LIMITS.eventsPerCall) throw new AgentError(`At most ${TRACKER_LIMITS.eventsPerCall} events per call (you sent ${total}); send the rest in another call.`);
  return serial(`${ctx.root}/${project}`, async () => {
    const dir = await projectDir(ctx, project);
    const { ledger } = await loadLitrpg(ctx, dir, project);
    const entries = chars.map((c, i) => {
      if (!isObj(c) || typeof c.name !== 'string' || !c.name.trim()) throw new AgentError(`characters[${i}]: name is required.`);
      if (!Array.isArray(c.events)) throw new AgentError(`characters[${i}] (${c.name}): events must be a list.`);
      return { name: c.name.trim(), events: c.events.map((e, j) => parseEvent(e, `${c.name} event ${j + 1}`)) };
    });
    const deltas: CharacterDelta[] = appendEvents(ledger, entries);
    const resolved = resolveFlags(ledger.consistency_flags, input.resolve_flags);
    const mine: LedgerFlag[] = [];
    for (const [i, f] of (input.flags ?? []).entries()) {
      if (!FLAG_TYPES.includes(f.type as never)) throw new AgentError(`flags[${i}]: type must be one of ${FLAG_TYPES.join(', ')}.`);
      if (!f.description?.trim()) throw new AgentError(`flags[${i}]: describe the problem, naming the chapters.`);
      mine.push(...mergeFlags(ledger, [{ type: f.type as LedgerFlag['type'], character: f.character ?? '', chapters_involved: f.chapters_involved ?? [], description: f.description.trim() }]));
    }
    const found = mergeFlags(ledger, runChecks(ledger));
    const maxChapter = Math.max(0, ...entries.flatMap((e) => e.events.map((x) => x.chapter)));
    ledger.meta.last_updated_chapter = Math.max(ledger.meta.last_updated_chapter, maxChapter, input.last_updated_chapter ?? 0);
    refresh(ledger);
    await saveToolFile(ctx, dir, TRACKER_PATHS.litrpg, json(ledger));
    const records = await writeChapterRecords(ctx, dir, project, entries.flatMap((e) => e.events.map((x) => x.chapter)), opts.templates, opts.earlier);
    return {
      ledger: TRACKER_PATHS.litrpg,
      ...(records.length ? { chapter_records: records } : {}),
      last_updated_chapter: ledger.meta.last_updated_chapter,
      changes: deltas,
      new_flags: [...found, ...mine],
      resolved_flags: resolved,
      open_flags: ledger.consistency_flags.filter((f) => f.status === 'open').length,
    };
  });
}

/**
 * A character's state as of a chapter (or the end of the ledger), or as of an in-story day when the project has a timeline ledger. Given the
 * folders of the Books before this one, what happened in them comes first.
 */
export async function litrpgState(ctx: AgentContext, project: string, q: { character?: string; as_of_chapter?: number; as_of_day?: number | string }, earlier?: string[]) {
  const dir = await projectDir(ctx, project);
  const loaded = await loadLitrpg(ctx, dir, project);
  const before = await loadEarlier(ctx, earlier);
  // With earlier Books the ledger is read with theirs in front of it (a character starts this Book where the last one left them).
  const ledger = before.length ? carryLedger(loaded.ledger, before) : loaded.ledger;
  const existed = loaded.existed || before.length > 0;
  if (!existed || Object.keys(ledger.characters).length === 0) throw new AgentError(`There is no LitRPG ledger in "${project}" yet. Log the chapters with litrpg_log first.`);
  let chapter = q.as_of_chapter;
  let day: string | undefined;
  if (q.as_of_day !== undefined) {
    if (chapter !== undefined) throw new AgentError('Give as_of_chapter or as_of_day, not both.');
    const { ledger: timeline, existed: hasTimeline } = await loadTimeline(ctx, dir, project);
    if (!hasTimeline) throw new AgentError(`There is no timeline ledger in "${project}", so a day can't be turned into a chapter. Track the timeline first, or ask as of a chapter.`);
    day = String(q.as_of_day);
    chapter = chapterAsOfDay(timeline, day);
    if (chapter === 0) throw new AgentError(`No chapter has been narrated as of day ${day} in the timeline ledger.`);
  }
  const names = Object.keys(ledger.characters);
  const wanted = q.character ? names.filter((n) => n.toLowerCase() === q.character!.trim().toLowerCase()) : names;
  if (q.character && wanted.length === 0) throw new AgentError(`There is no character "${q.character}" in the ledger. It has: ${names.join(', ')}.`);
  return {
    as_of_chapter: chapter ?? null,
    ...(day !== undefined ? { as_of_day: day } : {}),
    ledger_covers_through_chapter: ledger.meta.last_updated_chapter,
    ...(chapter !== undefined && chapter > ledger.meta.last_updated_chapter ? { warning: `The ledger only covers through chapter ${ledger.meta.last_updated_chapter}, so this may be out of date. Log the later chapters first.` } : {}),
    characters: wanted.map((n) => ({ character: n, state: replay(ledger.characters[n].event_log, chapter) as CharacterState })),
  };
}

// ---- timeline ------------------------------------------------------------------------------

export interface TimelineLogInput {
  days?: DayInput[];
  flags?: { type: string; days_involved?: (string | number)[]; chapters_involved?: number[]; description: string; quotes?: { quote: string; chapter: number }[] }[];
  resolve_flags?: string[];
  last_updated_chapter?: number;
}

/** Merges what the text says about days into the timeline ledger (creating it on first use) and runs the checks. All or nothing. */
export function timelineLog(ctx: AgentContext, project: string, input: TimelineLogInput, opts: { templates?: ViewTemplates; earlier?: string[] } = {}) {
  const days = input.days ?? [];
  if (!Array.isArray(days) || (days.length === 0 && !input.flags?.length && !input.resolve_flags?.length)) throw new AgentError('Give days: a list of day entries, each with a "day" and the chapters, claims and events the text gives for it.');
  if (days.length > TRACKER_LIMITS.daysPerCall) throw new AgentError(`At most ${TRACKER_LIMITS.daysPerCall} days per call.`);
  return serial(`${ctx.root}/${project}`, async () => {
    const dir = await projectDir(ctx, project);
    const { ledger } = await loadTimeline(ctx, dir, project);
    const touched = days.map((d) => mergeDay(ledger, d));
    const resolved = resolveFlags(ledger.timeline_flags, input.resolve_flags);
    const mine: TimelineFlag[] = [];
    for (const [i, f] of (input.flags ?? []).entries()) {
      if (!TIMELINE_FLAG_TYPES.includes(f.type as never)) throw new AgentError(`flags[${i}]: type must be one of ${TIMELINE_FLAG_TYPES.join(', ')}.`);
      if (!f.description?.trim() || !f.quotes?.length) throw new AgentError(`flags[${i}]: a flag needs a description and both conflicting quotes with their chapters (quotes), or the author can't act on it.`);
      mine.push(...mergeTimelineFlags(ledger, [{ type: f.type as TimelineFlag['type'], days_involved: (f.days_involved ?? []).map(String), chapters_involved: f.chapters_involved ?? [], description: f.description.trim(), quotes: f.quotes }]));
    }
    const found = mergeTimelineFlags(ledger, runTimelineChecks(ledger));
    const maxChapter = Math.max(0, ...Object.values(ledger.days).flatMap((d) => d.chapters.map((c) => c.chapter)));
    ledger.meta.last_updated_chapter = Math.max(ledger.meta.last_updated_chapter, maxChapter, input.last_updated_chapter ?? 0);
    await saveToolFile(ctx, dir, TRACKER_PATHS.timeline, json(ledger));
    const records = await writeChapterRecords(ctx, dir, project, days.flatMap((d) => (d.chapters ?? []).map((c) => c.chapter)), opts.templates, opts.earlier);
    return {
      ledger: TRACKER_PATHS.timeline,
      ...(records.length ? { chapter_records: records } : {}),
      last_updated_chapter: ledger.meta.last_updated_chapter,
      days_updated: [...new Set(touched)],
      days_tracked: orderedDays(ledger).length,
      new_flags: [...found, ...mine],
      resolved_flags: resolved,
      open_flags: ledger.timeline_flags.filter((f) => f.status === 'open').length,
    };
  });
}

// ---- checking both ---------------------------------------------------------------------------

/** Runs the arithmetic checks over a whole ledger, saves any flag that is new, and lists every flag still open. */
export function checkTracker(ctx: AgentContext, project: string, tracker: 'litrpg' | 'timeline', earlier?: string[]) {
  if (tracker !== 'litrpg' && tracker !== 'timeline') throw new AgentError('tracker must be "litrpg" or "timeline".');
  return serial(`${ctx.root}/${project}`, async () => {
    const dir = await projectDir(ctx, project);
    if (tracker === 'litrpg') {
      const { ledger, existed } = await loadLitrpg(ctx, dir, project);
      if (!existed) throw new AgentError(`There is no LitRPG ledger in "${project}" yet.`);
      // With earlier Books the checks run over the joined ledger (so a jump between Books is found), and only what concerns this Book is kept.
      const before = await loadEarlier(ctx, earlier);
      const found = before.length ? flagsForThisBook(runChecks(carryLedger(ledger, before))) : runChecks(ledger);
      const added = mergeFlags(ledger, found);
      if (added.length) await saveToolFile(ctx, dir, TRACKER_PATHS.litrpg, json(ledger));
      return { tracker, new_flags: added, open_flags: ledger.consistency_flags.filter((f) => f.status === 'open'), covers_through_chapter: ledger.meta.last_updated_chapter };
    }
    const { ledger, existed } = await loadTimeline(ctx, dir, project);
    if (!existed) throw new AgentError(`There is no timeline ledger in "${project}" yet.`);
    const added = mergeTimelineFlags(ledger, runTimelineChecks(ledger));
    if (added.length) await saveToolFile(ctx, dir, TRACKER_PATHS.timeline, json(ledger));
    return { tracker, new_flags: added, open_flags: ledger.timeline_flags.filter((f) => f.status === 'open'), covers_through_chapter: ledger.meta.last_updated_chapter };
  });
}

// ---- views -----------------------------------------------------------------------------------

export interface BuildViewInput {
  view: 'timeline' | 'litrpg' | 'character_sheet' | 'chapters';
  character?: string;
  as_of_chapter?: number;
  return_html?: boolean;
}

/**
 * Draws a tracker as a self-contained HTML page, saves it in the project's Tracking folder, and (on request) returns the page
 * itself so it can be shown as an artifact. A character sheet shows only values the book has given, and no notes.
 */
export function buildTrackerView(ctx: AgentContext, project: string, input: BuildViewInput, templates: ViewTemplates, earlier?: string[]) {
  return serial(`${ctx.root}/${project}`, async () => {
    const dir = await projectDir(ctx, project);
    const done = async (file: string, html: string, extra: Record<string, unknown> = {}) => {
      await saveToolFile(ctx, dir, file, html);
      return { view: input.view, file, size: html.length, ...extra, ...(input.return_html ? { html } : {}) };
    };
    if (input.view === 'chapters') {
      // Writes (or brings up to date) the record of every chapter the ledgers cover, or just `as_of_chapter`. For ledgers logged before records existed.
      const own = await loadLitrpg(ctx, dir, project);
      const tl = await loadTimeline(ctx, dir, project);
      const all = chaptersOf(own.existed ? own.ledger : null, tl.existed ? tl.ledger : null);
      if (!all.length) throw new AgentError(`There is nothing to record in "${project}" yet. Log chapters with litrpg_log or timeline_log first.`);
      const wanted = input.as_of_chapter !== undefined ? [input.as_of_chapter] : all;
      const files = await writeChapterRecords(ctx, dir, project, wanted, templates, earlier);
      return { view: input.view, chapters_covered: all.length, written: files, unchanged: wanted.length - files.length };
    }
    if (input.view === 'timeline') {
      const { ledger, existed } = await loadTimeline(ctx, dir, project);
      if (!existed || orderedDays(ledger).length === 0) throw new AgentError(`There is no timeline to draw in "${project}" yet. Log days with timeline_log first.`);
      const mechanics = await loadLitrpg(ctx, dir, project);
      const before = await loadEarlier(ctx, earlier);
      const model = timelineModel(ledger, mechanics.existed || before.length ? (before.length ? carryLedger(mechanics.ledger, before) : mechanics.ledger) : null);
      return done(TRACKER_PATHS.timelineView, renderView(templates.timeline, `${model.project} Timeline`, model));
    }
    const own = await loadLitrpg(ctx, dir, project);
    const before = await loadEarlier(ctx, earlier);
    const ledger = before.length ? carryLedger(own.ledger, before) : own.ledger;
    const existed = own.existed || before.length > 0;
    const names = Object.keys(ledger.characters);
    if (!existed || names.length === 0) throw new AgentError(`There is no LitRPG ledger in "${project}" yet. Log the chapters with litrpg_log first.`);
    if (input.view === 'litrpg') {
      const model = dashboardModel(ledger);
      return done(TRACKER_PATHS.dashboard, renderView(templates.litrpg, `${model.project} LitRPG Tracker`, model));
    }
    if (input.view !== 'character_sheet') throw new AgentError('view must be "timeline", "litrpg" or "character_sheet".');
    const wanted = input.character?.trim();
    const all = wanted?.toLowerCase() === 'all';
    const chosen = all ? names : wanted ? names.filter((n) => n.toLowerCase() === wanted.toLowerCase()) : names.length === 1 ? names : [];
    if (chosen.length === 0) throw new AgentError(wanted ? `There is no character "${wanted}" in the ledger. It has: ${names.join(', ')}.` : `Say which character: ${names.join(', ')}, or "all".`);
    const asOf = input.as_of_chapter;
    const out: { character: string; file: string }[] = [];
    let last = '';
    for (const name of chosen) {
      const events = ledger.characters[name].event_log;
      const sheet = sheetModel(name, replay(events, asOf), asOf ?? Math.max(0, ...events.map((e) => e.chapter)));
      const html = renderView(templates.sheet, `${name} Character Sheet`, sheet);
      const file = `${TRACKER_PATHS.sheets}/${safeFile(name)}${asOf !== undefined ? ` (Chapter ${asOf})` : ''}.html`;
      await saveToolFile(ctx, dir, file, html);
      out.push({ character: name, file });
      last = html;
    }
    return { view: input.view, ...(out.length === 1 ? { file: out[0].file } : { files: out }), ...(input.return_html && out.length === 1 ? { html: last } : {}) };
  });
}
