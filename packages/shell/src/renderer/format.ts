/** Small, pure formatters for the Home and Dashboard pages. */

export const formatWords = (n: number): string => n.toLocaleString('en-US');

/** A project's word count for display: "no active manuscript" rather than a misleading 0 when none is chosen. */
export const wordsLabel = (n: number | null): string => (n === null ? 'no active manuscript' : `${formatWords(n)} words`);

export { ago } from '@cadrel/ui';

/** 0–100, or null when there is no goal. Capped at 100 so a finished project does not overflow its bar. */
export function percent(words: number | null, goal: number | null): number | null {
  if (words === null || !goal || goal <= 0) return null;
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

/** "1.4 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
