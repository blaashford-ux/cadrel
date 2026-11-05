/**
 * How the app keeps up with a Studio whose records live on its server. It does not poll on a short timer: every request is a database read
 * the Studio's owner pays for (and a free account has a daily allowance), and most of the time nothing has changed. Instead a page asks
 *   - when it opens, when the window gets focus, after a change made here, and when the person presses Refresh, and
 *   - every SLOW_REFRESH_MS while the window is open and visible, so a teammate's lock or task still turns up without anyone clicking.
 * Each of those asks is first answered by the Studio's change counter (see StudioClient), so a quiet Studio costs a couple of rows.
 */
export const SLOW_REFRESH_MS = 3 * 60_000;
/** Focus events closer together than this are one: switching between windows must not become polling. */
export const MIN_REFRESH_GAP_MS = 15_000;
