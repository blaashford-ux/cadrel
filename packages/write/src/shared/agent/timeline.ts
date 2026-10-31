/**
 * The timeline ledger: which in-story day each chapter happens on, every elapsed-time and calendar statement the text makes
 * (with the exact quote), and the contradictions between them. Day is the primary unit; a chapter is a pointer to days.
 *
 * Pure functions over plain data; the file and tool plumbing is in trackers.ts. This ledger holds no XP, levels or stats.
 */
import { replay, type CharacterState, type LitrpgLedger } from './litrpg';
import { AgentError } from './tools';

export const MODES = ['full_scene', 'summarized', 'off_page'] as const;
export type Mode = (typeof MODES)[number];
export const TIMELINE_FLAG_TYPES = ['overlapping_days', 'day_of_week_contradiction', 'duration_mismatch', 'untracked_gap', 'compression_imbalance'] as const;
export type TimelineFlagType = (typeof TIMELINE_FLAG_TYPES)[number];

export interface ChapterRef {
  chapter: number;
  mode: Mode;
  /** The chapter shows this day out of order (a flashback), so it doesn't count against chapter order. */
  flashback?: boolean;
}
export interface ElapsedClaim {
  quote: string;
  source_chapter: number;
  /** How many days the claim says have passed, and since which day: lets the day numbers be checked against it. */
  days?: number | null;
  since_day?: string | null;
}
export interface CalendarClaim {
  quote: string;
  source_chapter: number;
}

export interface DayEntry {
  chapters: ChapterRef[];
  locations: string[];
  characters_present: string[];
  pov_character: string | null;
  major_events: string[];
  elapsed_time_claims: ElapsedClaim[];
  calendar_claims: CalendarClaim[];
  /** A pointer only (names or a short tag), never XP numbers. */
  daily_quests_completed: string[];
  time_of_day_markers: string[];
  /** The day of the week, only when the text states it. */
  weekday: string | null;
  /** "weekday" or "weekend", only when the text says (a "school night", "the weekend"). */
  day_type: 'weekday' | 'weekend' | null;
  day_confidence: 'confirmed' | 'uncertain';
  day_range_if_uncertain: [number, number] | null;
}

export interface TimelineFlag {
  id: string;
  type: TimelineFlagType;
  days_involved: string[];
  chapters_involved: number[];
  description: string;
  quotes: { quote: string; chapter: number }[];
  status: 'open' | 'resolved';
}

export interface TimelineLedger {
  meta: { project: string; last_updated_chapter: number; schema_version: string };
  days: Record<string, DayEntry>;
  timeline_flags: TimelineFlag[];
}

export const emptyDay = (): DayEntry => ({
  chapters: [],
  locations: [],
  characters_present: [],
  pov_character: null,
  major_events: [],
  elapsed_time_claims: [],
  calendar_claims: [],
  daily_quests_completed: [],
  time_of_day_markers: [],
  weekday: null,
  day_type: null,
  day_confidence: 'confirmed',
  day_range_if_uncertain: null,
});
export const emptyTimeline = (project: string): TimelineLedger => ({ meta: { project, last_updated_chapter: 0, schema_version: '1.0' }, days: {}, timeline_flags: [] });

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const weekdayIndex = (w: string | null): number => (w ? WEEKDAYS.indexOf(w.trim().toLowerCase()) : -1);
const dayNumber = (key: string): number | null => (/^-?\d+$/.test(key) ? Number(key) : null);

export function normalizeTimeline(raw: unknown, project: string): TimelineLedger {
  const base = emptyTimeline(project);
  if (!isObj(raw)) return base;
  const out: TimelineLedger = {
    meta: { ...base.meta, ...(isObj(raw.meta) ? (raw.meta as Partial<TimelineLedger['meta']>) : {}) },
    days: {},
    timeline_flags: [],
  };
  if (isObj(raw.days)) for (const [k, v] of Object.entries(raw.days)) out.days[k] = { ...emptyDay(), ...(isObj(v) ? (v as Partial<DayEntry>) : {}) };
  if (Array.isArray(raw.timeline_flags)) out.timeline_flags = (raw.timeline_flags as TimelineFlag[]).map((f, i) => ({ ...f, id: f.id ?? `t${i + 1}`, status: f.status === 'resolved' ? 'resolved' : 'open' }));
  return out;
}

/** The day keys in story order: numbers first, ascending, then "uncertain" and anything else. */
export const orderedDays = (t: TimelineLedger): string[] =>
  Object.keys(t.days).sort((a, b) => {
    const x = dayNumber(a);
    const y = dayNumber(b);
    return x !== null && y !== null ? x - y : x !== null ? -1 : y !== null ? 1 : a.localeCompare(b);
  });

// ---- logging ---------------------------------------------------------------------------------

export interface DayInput {
  day: string | number;
  chapters?: { chapter: number; mode?: string; flashback?: boolean }[];
  locations?: string[];
  characters_present?: string[];
  pov_character?: string | null;
  major_events?: string[];
  elapsed_time_claims?: { quote: string; source_chapter: number; days?: number | null; since_day?: string | number | null }[];
  calendar_claims?: { quote: string; source_chapter: number }[];
  daily_quests_completed?: string[];
  time_of_day_markers?: string[];
  weekday?: string | null;
  day_type?: string | null;
  day_confidence?: string;
  day_range_if_uncertain?: number[] | null;
}

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];

/** Merges what the text says about a day into the ledger. Lists grow (duplicates are ignored); single values are replaced when given. */
export function mergeDay(t: TimelineLedger, input: DayInput): string {
  const key = String(input.day).trim();
  if (!key) throw new AgentError('Each day needs a "day": the day number, or "uncertain" when the text does not pin it down.');
  if (key !== 'uncertain' && dayNumber(key) === null) throw new AgentError(`Day "${key}" is not a day number. Use a whole number, or "uncertain" with a best-guess day_range_if_uncertain.`);
  const d = t.days[key] ?? (t.days[key] = emptyDay());
  for (const c of input.chapters ?? []) {
    if (typeof c.chapter !== 'number' || !Number.isInteger(c.chapter) || c.chapter < 0) throw new AgentError(`Day ${key}: chapter must be a whole number (Chapter 1 is 1).`);
    const mode: Mode = (MODES as readonly string[]).includes(c.mode ?? '') ? (c.mode as Mode) : 'full_scene';
    const ref: ChapterRef = { chapter: c.chapter, mode, ...(c.flashback ? { flashback: true } : {}) };
    const i = d.chapters.findIndex((x) => x.chapter === c.chapter);
    if (i >= 0) d.chapters[i] = ref;
    else d.chapters.push(ref);
  }
  d.chapters.sort((a, b) => a.chapter - b.chapter);
  d.locations = union(d.locations, strings(input.locations));
  d.characters_present = union(d.characters_present, strings(input.characters_present));
  d.major_events = union(d.major_events, strings(input.major_events));
  d.daily_quests_completed = union(d.daily_quests_completed, strings(input.daily_quests_completed));
  d.time_of_day_markers = union(d.time_of_day_markers, strings(input.time_of_day_markers));
  if (input.pov_character !== undefined) d.pov_character = input.pov_character;
  for (const c of input.elapsed_time_claims ?? []) {
    if (!c.quote || typeof c.source_chapter !== 'number') throw new AgentError(`Day ${key}: an elapsed-time claim needs the exact quote and its source_chapter.`);
    if (!d.elapsed_time_claims.some((x) => x.quote === c.quote && x.source_chapter === c.source_chapter)) {
      d.elapsed_time_claims.push({ quote: c.quote, source_chapter: c.source_chapter, ...(typeof c.days === 'number' ? { days: c.days } : {}), ...(c.since_day !== undefined && c.since_day !== null ? { since_day: String(c.since_day) } : {}) });
    }
  }
  for (const c of input.calendar_claims ?? []) {
    if (!c.quote || typeof c.source_chapter !== 'number') throw new AgentError(`Day ${key}: a calendar claim needs the exact quote and its source_chapter.`);
    if (!d.calendar_claims.some((x) => x.quote === c.quote && x.source_chapter === c.source_chapter)) d.calendar_claims.push({ quote: c.quote, source_chapter: c.source_chapter });
  }
  if (input.weekday !== undefined) {
    if (input.weekday !== null && weekdayIndex(input.weekday) < 0) throw new AgentError(`Day ${key}: weekday must be a day name like "Tuesday".`);
    d.weekday = input.weekday === null ? null : WEEKDAYS[weekdayIndex(input.weekday)].replace(/^./, (c) => c.toUpperCase());
  }
  if (input.day_type !== undefined) d.day_type = input.day_type === 'weekday' || input.day_type === 'weekend' ? input.day_type : null;
  if (key === 'uncertain') {
    d.day_confidence = 'uncertain';
    if (Array.isArray(input.day_range_if_uncertain) && input.day_range_if_uncertain.length === 2) d.day_range_if_uncertain = [input.day_range_if_uncertain[0], input.day_range_if_uncertain[1]];
  } else if (input.day_confidence === 'uncertain') {
    d.day_confidence = 'uncertain';
    if (Array.isArray(input.day_range_if_uncertain) && input.day_range_if_uncertain.length === 2) d.day_range_if_uncertain = [input.day_range_if_uncertain[0], input.day_range_if_uncertain[1]];
  } else if (input.day_confidence === 'confirmed') {
    d.day_confidence = 'confirmed';
    d.day_range_if_uncertain = null;
  }
  return key;
}

// ---- consistency checks ---------------------------------------------------------------------

type NewFlag = Omit<TimelineFlag, 'id' | 'status'>;

/** The checks that can be done by arithmetic: chapter order, stated durations, the days of the week, and unbridged gaps. */
export function runTimelineChecks(t: TimelineLedger): NewFlag[] {
  const flags: NewFlag[] = [];
  const keys = orderedDays(t).filter((k) => dayNumber(k) !== null && t.days[k].day_confidence !== 'uncertain');

  // Chapters must run forward through the days (a flashback is allowed to go back).
  const span = new Map<number, { min: number; max: number }>();
  for (const k of keys) {
    for (const c of t.days[k].chapters) {
      if (c.flashback) continue;
      const n = dayNumber(k)!;
      const s = span.get(c.chapter);
      span.set(c.chapter, s ? { min: Math.min(s.min, n), max: Math.max(s.max, n) } : { min: n, max: n });
    }
  }
  const chapters = [...span.keys()].sort((a, b) => a - b);
  for (let i = 1; i < chapters.length; i++) {
    const a = span.get(chapters[i - 1])!;
    const b = span.get(chapters[i])!;
    if (b.min < a.max) {
      flags.push({
        type: 'overlapping_days',
        days_involved: [String(b.min), String(a.max)],
        chapters_involved: [chapters[i - 1], chapters[i]],
        description: `Chapter ${chapters[i]} starts on day ${b.min}, but the chapter before it (${chapters[i - 1]}) already reaches day ${a.max}. If chapter ${chapters[i]} is a flashback, mark it so.`,
        quotes: [],
      });
    }
  }

  // A stated number of days against the day numbers it sits between.
  for (const k of keys) {
    for (const c of t.days[k].elapsed_time_claims) {
      const since = c.since_day !== undefined && c.since_day !== null ? dayNumber(String(c.since_day)) : null;
      if (typeof c.days === 'number' && since !== null && dayNumber(k)! - since !== c.days) {
        flags.push({
          type: 'overlapping_days',
          days_involved: [String(since), k],
          chapters_involved: [c.source_chapter],
          description: `Chapter ${c.source_chapter} says ${c.days} day(s) have passed since day ${since}, but the ledger puts this at day ${k}, which is ${dayNumber(k)! - since} day(s) later.`,
          quotes: [{ quote: c.quote, chapter: c.source_chapter }],
        });
      }
    }
  }

  // Days of the week must agree with each other, and with "school night" or "weekend" statements.
  const anchored = keys.filter((k) => weekdayIndex(t.days[k].weekday) >= 0);
  const anchor = anchored[0];
  const claimQuotes = (k: string) => t.days[k].calendar_claims.map((c) => ({ quote: c.quote, chapter: c.source_chapter }));
  if (anchor !== undefined) {
    const a = dayNumber(anchor)!;
    const base = weekdayIndex(t.days[anchor].weekday);
    for (const k of keys) {
      const n = dayNumber(k)!;
      const expected = (((base + (n - a)) % 7) + 7) % 7;
      const stated = weekdayIndex(t.days[k].weekday);
      if (k !== anchor && stated >= 0 && stated !== expected) {
        flags.push({
          type: 'day_of_week_contradiction',
          days_involved: [anchor, k],
          chapters_involved: [...new Set([...t.days[anchor].chapters, ...t.days[k].chapters].map((c) => c.chapter))].sort((x, y) => x - y),
          description: `Day ${anchor} is a ${t.days[anchor].weekday}, so day ${k} should be a ${WEEKDAYS[expected].replace(/^./, (c) => c.toUpperCase())}, but the text makes it a ${t.days[k].weekday}.`,
          quotes: [...claimQuotes(anchor), ...claimQuotes(k)],
        });
      }
      const type = t.days[k].day_type;
      if (type && (expected >= 5) !== (type === 'weekend') && !(stated >= 0 && stated !== expected)) {
        flags.push({
          type: 'day_of_week_contradiction',
          days_involved: [anchor, k],
          chapters_involved: t.days[k].chapters.map((c) => c.chapter),
          description: `Day ${k} is described as ${type === 'weekend' ? 'a weekend day' : 'a weekday'}, but counting from day ${anchor} (a ${t.days[anchor].weekday}) it falls on a ${WEEKDAYS[expected].replace(/^./, (c) => c.toUpperCase())}.`,
          quotes: [...claimQuotes(anchor), ...claimQuotes(k)],
        });
      }
    }
  }

  // A jump with nothing to bridge it.
  for (let i = 1; i < keys.length; i++) {
    const from = dayNumber(keys[i - 1])!;
    const to = dayNumber(keys[i])!;
    if (to - from > 1 && t.days[keys[i]].elapsed_time_claims.length === 0 && t.days[keys[i]].calendar_claims.length === 0) {
      flags.push({
        type: 'untracked_gap',
        days_involved: [keys[i - 1], keys[i]],
        chapters_involved: [...new Set([...t.days[keys[i - 1]].chapters, ...t.days[keys[i]].chapters].map((c) => c.chapter))].sort((x, y) => x - y),
        description: `The ledger jumps from day ${from} to day ${to} (${to - from} days) and nothing in the text on day ${to} says how much time passed. It may be fine; it is a place a reader could get lost.`,
        quotes: [],
      });
    }
  }
  return flags;
}

const flagKey = (f: { type: string; days_involved: string[]; chapters_involved: number[]; description: string }) => `${f.type}|${f.days_involved.join(',')}|${f.chapters_involved.join(',')}|${f.description}`;

export function mergeTimelineFlags(t: TimelineLedger, found: NewFlag[]): TimelineFlag[] {
  const have = new Set(t.timeline_flags.map(flagKey));
  let n = t.timeline_flags.reduce((m, f) => Math.max(m, Number(/^t(\d+)$/.exec(f.id)?.[1] ?? 0)), 0);
  const added: TimelineFlag[] = [];
  for (const f of found) {
    if (have.has(flagKey(f))) continue;
    have.add(flagKey(f));
    const full: TimelineFlag = { ...f, id: `t${++n}`, status: 'open' };
    t.timeline_flags.push(full);
    added.push(full);
  }
  return added;
}

// ---- a series: what happened in earlier Books ------------------------------------------------

const mergeLists = <T>(a: T[], b: T[], same: (x: T, y: T) => boolean): T[] => {
  const out = [...a];
  for (const x of b) if (!out.some((y) => same(x, y))) out.push(x);
  return out;
};

/**
 * This Book's timeline with the days of the Books before it in front. A series has one chronology: day numbers carry on from the last Book,
 * and a day the earlier Book already has (the Books overlap, or a flashback revisits it) is joined, not repeated. Everything the earlier
 * Books say sits at "chapter 0" of this one, so the checks see a Book that starts before the last one ended, a weekday that disagrees across
 * the Books, or a jump with nothing to bridge it, while the chapters stay this Book's own. Nothing here is saved: it is for reading.
 */
export function carryTimeline(own: TimelineLedger, earlier: TimelineLedger[]): TimelineLedger {
  const days: Record<string, DayEntry> = {};
  const join = (key: string, d: DayEntry, carried: boolean) => {
    const at = days[key];
    const chapters: ChapterRef[] = carried ? (d.chapters.length ? [{ chapter: 0, mode: d.chapters[0]!.mode, ...(d.chapters.every((c) => c.flashback) ? { flashback: true } : {}) }] : []) : d.chapters;
    const claim = <C extends { source_chapter: number }>(c: C): C => (carried ? { ...c, source_chapter: 0 } : c);
    const elapsed = d.elapsed_time_claims.map(claim);
    const calendar = d.calendar_claims.map(claim);
    if (!at) {
      days[key] = { ...d, chapters: [...chapters], elapsed_time_claims: elapsed, calendar_claims: calendar };
      return;
    }
    at.chapters = mergeLists(at.chapters, chapters, (x, y) => x.chapter === y.chapter).sort((x, y) => x.chapter - y.chapter);
    at.locations = union(at.locations, d.locations);
    at.characters_present = union(at.characters_present, d.characters_present);
    at.major_events = union(at.major_events, d.major_events);
    at.daily_quests_completed = union(at.daily_quests_completed, d.daily_quests_completed);
    at.time_of_day_markers = union(at.time_of_day_markers, d.time_of_day_markers);
    at.elapsed_time_claims = mergeLists(at.elapsed_time_claims, elapsed, (x, y) => x.quote === y.quote && x.source_chapter === y.source_chapter);
    at.calendar_claims = mergeLists(at.calendar_claims, calendar, (x, y) => x.quote === y.quote && x.source_chapter === y.source_chapter);
    at.pov_character = d.pov_character ?? at.pov_character;
    at.weekday = d.weekday ?? at.weekday;
    at.day_type = d.day_type ?? at.day_type;
    if (d.day_confidence === 'confirmed') {
      at.day_confidence = 'confirmed';
      at.day_range_if_uncertain = null;
    }
  };
  for (const l of earlier) for (const [k, d] of Object.entries(l.days)) join(k, d, true);
  for (const [k, d] of Object.entries(own.days)) join(k, d, false);
  return { meta: { ...own.meta }, days, timeline_flags: own.timeline_flags.map((f) => ({ ...f })) };
}

// ---- day to chapter, and the cross-reference -------------------------------------------------

/** The highest chapter narrated as of a day: every confirmed day up to and including it, flashbacks aside. */
export function chapterAsOfDay(t: TimelineLedger, day: string | number): number {
  const target = dayNumber(String(day));
  if (target === null) throw new AgentError(`Day "${day}" is not a day number.`);
  if (!t.days[String(day)]) throw new AgentError(`Day ${day} is not in the timeline ledger.`);
  let max = 0;
  for (const [k, entry] of Object.entries(t.days)) {
    const n = dayNumber(k);
    if (n === null || n > target || entry.day_confidence === 'uncertain') continue;
    for (const c of entry.chapters) if (!c.flashback) max = Math.max(max, c.chapter);
  }
  return max;
}

export interface TimelineModel {
  project: string;
  last_updated_chapter: number;
  days: (DayEntry & { key: string; n: number | null })[];
  flags: (Omit<TimelineFlag, 'status'> & { status: string })[];
  /** Level and XP by day for each character, when the project also has a mechanics ledger. */
  series: { character: string; points: { day: number; level: number | null; xp_total: number | null }[] }[];
}

export function timelineModel(t: TimelineLedger, mechanics: LitrpgLedger | null): TimelineModel {
  const keys = orderedDays(t);
  const series: TimelineModel['series'] = [];
  if (mechanics) {
    for (const [name, c] of Object.entries(mechanics.characters)) {
      const points: TimelineModel['series'][number]['points'] = [];
      for (const k of keys) {
        const n = dayNumber(k);
        if (n === null || t.days[k].day_confidence === 'uncertain') continue;
        const chapter = chapterAsOfDay(t, k);
        if (chapter === 0) continue;
        const s: CharacterState = replay(c.event_log, chapter);
        if (s.level !== null || s.xp_total !== null) points.push({ day: n, level: s.level, xp_total: s.xp_total });
      }
      if (points.length) series.push({ character: name, points });
    }
  }
  return {
    project: t.meta.project,
    last_updated_chapter: t.meta.last_updated_chapter,
    days: keys.map((k) => ({ ...t.days[k], key: k, n: dayNumber(k) })),
    flags: t.timeline_flags,
    series,
  };
}
