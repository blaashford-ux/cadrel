/** "3 days ago", "just now", or "not started" when there is no time. `now` is passed in so the result is reproducible. */
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
