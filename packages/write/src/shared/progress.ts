/**
 * Writing progress for a project: a day-by-day history of its word count, plus the maths for goals
 * (words per day needed, 3- and 5-day averages, estimated completion, burn-down). Pure and date-string
 * based ("YYYY-MM-DD" in the user's local time), so it is easy to test and has no time-zone surprises.
 */

export interface DayRecord {
  /** The project's word total when the day was first seen (the previous day's end when there is one). */
  start: number;
  /** The latest total seen that day. */
  end: number;
}

export interface Progress {
  version: 1;
  days: Record<string, DayRecord>;
}

export interface Goal {
  targetWords: number;
  /** When the goal began (counting from this day's starting total). */
  startDate: string;
  /** Optional deadline. */
  targetDate: string | null;
}

export const emptyProgress = (): Progress => ({ version: 1, days: {} });

// ---- dates -----------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (s: unknown): s is string => typeof s === 'string' && DATE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

/** Local calendar date of `d` as YYYY-MM-DD. */
export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const toUtc = (date: string) => Date.parse(date + 'T00:00:00Z');
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (date: string, n: number): string => fromUtc(toUtc(date) + n * 86_400_000);
/** Whole days from `a` to `b` (negative when b is before a). */
export const daysBetween = (a: string, b: string): number => Math.round((toUtc(b) - toUtc(a)) / 86_400_000);

/** Every date from `from` to `to` inclusive (empty when `to` is before `from`; at most 3660 days). */
export function dateRange(from: string, to: string): string[] {
  const n = Math.min(daysBetween(from, to), 3660);
  return n < 0 ? [] : Array.from({ length: n + 1 }, (_, i) => addDays(from, i));
}

// ---- history -----------------------------------------------------------------------------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Defensive parse of the history file. */
export function sanitizeProgress(raw: unknown): Progress {
  const out = emptyProgress();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const days = (raw as { days?: unknown }).days;
  if (!days || typeof days !== 'object' || Array.isArray(days)) return out;
  for (const [date, rec] of Object.entries(days as Record<string, unknown>)) {
    if (!isDate(date) || !rec || typeof rec !== 'object') continue;
    const { start, end } = rec as { start?: unknown; end?: unknown };
    if (isNum(start) && isNum(end)) out.days[date] = { start: Math.max(0, Math.round(start)), end: Math.max(0, Math.round(end)) };
  }
  return out;
}

/** The latest record on or before `date`. */
function lastBefore(p: Progress, date: string): DayRecord | undefined {
  let best: string | undefined;
  for (const d of Object.keys(p.days)) if (d < date && (!best || d > best)) best = d;
  return best ? p.days[best] : undefined;
}

/**
 * Notes the project's word total on `date`. The first sighting of a day starts from the previous recorded day's
 * end (so edits made while the app was closed count on the day they are first seen); the very first sighting
 * ever is the baseline (nothing "written"). Later sightings update the day's end. Returns a new object.
 */
export function recordSnapshot(p: Progress, date: string, total: number): Progress {
  const t = Math.max(0, Math.round(total));
  const existing = p.days[date];
  if (existing) {
    if (existing.end === t) return p;
    return { ...p, days: { ...p.days, [date]: { start: existing.start, end: t } } };
  }
  const prev = lastBefore(p, date);
  return { ...p, days: { ...p.days, [date]: { start: prev ? prev.end : t, end: t } } };
}

/** Words written on a day (net: deletions subtract). Zero for days with no record. */
export const writtenOn = (p: Progress, date: string): number => {
  const r = p.days[date];
  return r ? r.end - r.start : 0;
};

/** Average words written per calendar day over the `n` days ending on `today` (inclusive), zero days counted. */
export function averageWritten(p: Progress, today: string, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += writtenOn(p, addDays(today, -i));
  return sum / n;
}

/** The total at the end of `date`, carried forward from the last recorded day; null before any record. */
export function totalOn(p: Progress, date: string): number | null {
  const exact = p.days[date];
  if (exact) return exact.end;
  const prev = lastBefore(p, date);
  return prev ? prev.end : null;
}

export interface DayPoint {
  date: string;
  written: number;
  /** Words in the project at the end of the day (null before tracking began and after `today`). */
  total: number | null;
}

/** One entry per day from `from` to `to`, for the chart. */
export function dailySeries(p: Progress, from: string, to: string, today: string): DayPoint[] {
  return dateRange(from, to).map((date) => ({
    date,
    written: writtenOn(p, date),
    total: date > today ? null : totalOn(p, date)
  }));
}

/** The first day with a record, if any. */
export function firstDay(p: Progress): string | null {
  const keys = Object.keys(p.days).sort();
  return keys[0] ?? null;
}

// ---- goals -------------------------------------------------------------------------------

export const wordsRemaining = (goal: Goal, total: number) => Math.max(0, goal.targetWords - total);

/** Days from `today` through the target date, counting both ends (1 on the deadline itself); null without a deadline. */
export function daysLeft(goal: Goal, today: string): number | null {
  return goal.targetDate ? daysBetween(today, goal.targetDate) + 1 : null;
}

/**
 * Words per day needed from today to finish by the deadline (today counts as a day). Null without a deadline;
 * 0 when the goal is met; the whole remainder if the deadline has passed.
 */
export function requiredPerDay(goal: Goal, total: number, today: string): number | null {
  const left = daysLeft(goal, today);
  if (left === null) return null;
  const rem = wordsRemaining(goal, total);
  if (rem === 0) return 0;
  return Math.ceil(rem / Math.max(1, left));
}

export interface Projection {
  /** Whole days from today until the goal at this pace (0 = already done); null when there is no positive pace. */
  days: number | null;
  /** The estimated completion date; null when there is no positive pace. */
  date: string | null;
  /** Days ahead (+) or behind (−) the deadline; null without a deadline or an estimate. */
  vsDeadline: number | null;
}

/** When the goal would be reached at `perDay` words a day starting today. */
export function projectCompletion(goal: Goal, total: number, perDay: number, today: string): Projection {
  const rem = wordsRemaining(goal, total);
  if (rem === 0) return { days: 0, date: today, vsDeadline: goal.targetDate ? daysBetween(today, goal.targetDate) : null };
  if (!(perDay > 0)) return { days: null, date: null, vsDeadline: null };
  const days = Math.ceil(rem / perDay);
  const date = addDays(today, days);
  return { days, date, vsDeadline: goal.targetDate ? daysBetween(date, goal.targetDate) : null };
}

export interface BurnPoint {
  date: string;
  /** Words remaining at the end of the day (null before tracking and after today). */
  remaining: number | null;
  /** Where a steady pace from the start total to the deadline would be (null without a deadline). */
  ideal: number | null;
}

/** The burn-down: words remaining by day against the ideal straight line from the goal's start to its deadline. */
export function burnDown(p: Progress, goal: Goal, from: string, to: string, today: string): BurnPoint[] {
  const startTotal = totalOn(p, addDays(goal.startDate, -1)) ?? p.days[goal.startDate]?.start ?? totalOn(p, goal.startDate) ?? 0;
  const startRemaining = Math.max(0, goal.targetWords - startTotal);
  const span = goal.targetDate ? Math.max(1, daysBetween(goal.startDate, goal.targetDate) + 1) : 0;
  return dateRange(from, to).map((date) => {
    const total = date > today ? null : totalOn(p, date);
    let ideal: number | null = null;
    if (goal.targetDate) {
      const elapsed = daysBetween(goal.startDate, date) + 1;
      ideal = elapsed <= 0 ? startRemaining : Math.max(0, Math.round(startRemaining * (1 - elapsed / span)));
    }
    return { date, remaining: total === null ? null : wordsRemaining(goal, total), ideal };
  });
}

/** Everything the Progress panel shows, in one place. */
export interface Summary {
  total: number;
  writtenToday: number;
  remaining: number;
  percent: number;
  daysLeft: number | null;
  requiredPerDay: number | null;
  avg3: number;
  avg5: number;
  eta3: Projection;
  eta5: Projection;
  /** True once the goal has been reached. */
  done: boolean;
}

export function summarize(p: Progress, goal: Goal, total: number, today: string): Summary {
  const avg3 = averageWritten(p, today, 3);
  const avg5 = averageWritten(p, today, 5);
  return {
    total,
    writtenToday: writtenOn(p, today),
    remaining: wordsRemaining(goal, total),
    percent: goal.targetWords > 0 ? Math.min(100, Math.round((total / goal.targetWords) * 100)) : 0,
    daysLeft: daysLeft(goal, today),
    requiredPerDay: requiredPerDay(goal, total, today),
    avg3,
    avg5,
    eta3: projectCompletion(goal, total, avg3, today),
    eta5: projectCompletion(goal, total, avg5, today),
    done: total >= goal.targetWords
  };
}

/** A tidy goal from user input (positive target, valid dates, deadline not before the start). */
export function sanitizeGoal(raw: unknown, today: string): Goal | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Record<string, unknown>;
  if (!isNum(g.targetWords) || g.targetWords < 1) return null;
  const startDate = isDate(g.startDate) ? g.startDate : today;
  const targetDate = isDate(g.targetDate) && g.targetDate >= startDate ? g.targetDate : null;
  return { targetWords: Math.min(10_000_000, Math.round(g.targetWords)), startDate, targetDate };
}
