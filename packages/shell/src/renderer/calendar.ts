/** Dates for the planner. Everything is a plain calendar date (2026-11-30) and is worked out in UTC, so no time zone moves a task to another day. */

export const iso = (d: Date): string => d.toISOString().slice(0, 10);
const at = (date: string): Date => new Date(`${date}T00:00:00Z`);

/** The weeks (Monday first) that show a month, each seven dates, including the days of the neighbouring months that fill the first and last week. */
export function monthGrid(year: number, month0: number): string[][] {
  const first = new Date(Date.UTC(year, month0, 1));
  const lead = (first.getUTCDay() + 6) % 7; // days since Monday
  const start = new Date(Date.UTC(year, month0, 1 - lead));
  const days = Math.ceil((lead + new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate()) / 7) * 7;
  const out: string[][] = [];
  for (let i = 0; i < days; i += 7) out.push(Array.from({ length: 7 }, (_, j) => iso(new Date(start.getTime() + (i + j) * 86400000))));
  return out;
}

/** The month `by` months from year/month (0-based), wrapping the year. */
export function shiftMonth(year: number, month0: number, by: number): { year: number; month0: number } {
  const d = new Date(Date.UTC(year, month0 + by, 1));
  return { year: d.getUTCFullYear(), month0: d.getUTCMonth() };
}

export const monthTitle = (year: number, month0: number): string => new Date(Date.UTC(year, month0, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

interface Dated { due: string | null; state: string; kind: string; title: string }

/** Tasks by the date they fall on, deadlines first within a day. Undated tasks are not in the map. */
export function byDate<T extends Dated>(tasks: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const t of tasks) if (t.due) m.set(t.due, [...(m.get(t.due) ?? []), t]);
  for (const list of m.values()) list.sort((a, b) => Number(b.kind === 'deadline') - Number(a.kind === 'deadline') || a.title.localeCompare(b.title));
  return m;
}

/** Open work whose date has passed, oldest first. */
export const lateTasks = <T extends Dated>(tasks: T[], today: string): T[] => tasks.filter((t) => t.state === 'open' && t.due && t.due < today).sort((a, b) => a.due!.localeCompare(b.due!));

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string): number => Math.round((at(to).getTime() - at(from).getTime()) / 86400000);

/** "today", "tomorrow", "in 5 days", "3 days ago". */
export function relativeDay(date: string, today: string): string {
  const n = daysBetween(today, date);
  return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n > 0 ? `in ${n} days` : `${-n} days ago`;
}
