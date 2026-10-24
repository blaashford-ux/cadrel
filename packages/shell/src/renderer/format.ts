/** Small, pure formatters for the Home and Dashboard pages. */

export const formatWords = (n: number): string => n.toLocaleString('en-US');

/** "3 days ago", "just now", or "never" when there is no time. `now` is passed in so the result is reproducible. */
export function ago(ms: number | null, now: number): string {
  if (ms === null) return 'not started';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d} day${d === 1 ? '' : 's'} ago`;
  return `${Math.round(d / 30)} months ago`;
}

/** 0–100, or null when there is no goal. Capped at 100 so a finished project does not overflow its bar. */
export function percent(words: number, goal: number | null): number | null {
  if (!goal || goal <= 0) return null;
  return Math.min(100, Math.round((words / goal) * 100));
}

export function greeting(hour: number): string {
  if (hour < 5) return 'Working late';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export const STATUS_LABEL: Record<string, string> = {
  planning: 'Planning',
  drafting: 'Drafting',
  revising: 'Revising',
  editing: 'Editing',
  published: 'Published',
  paused: 'On hold'
};
