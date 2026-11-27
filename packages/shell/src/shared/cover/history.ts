/** Undo and redo for any value: a list of what it was, what it is, and what it was undone from. Continuous edits (a drag, a slider) join into one step. */
export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** Names the continuous edit the last commit belonged to, so the next with the same name replaces rather than adds a step. */
  key: string | null;
}
const LIMIT = 100;

export const startHistory = <T>(present: T): History<T> => ({ past: [], present, future: [], key: null });

export function commit<T>(h: History<T>, next: T, key: string | null = null): History<T> {
  if (Object.is(next, h.present)) return h;
  if (key !== null && key === h.key) return { ...h, present: next, future: [] };
  return { past: [...h.past, h.present].slice(-LIMIT), present: next, future: [], key };
}
export const canUndo = <T>(h: History<T>): boolean => h.past.length > 0;
export const canRedo = <T>(h: History<T>): boolean => h.future.length > 0;
export function undo<T>(h: History<T>): History<T> {
  if (!canUndo(h)) return h;
  const present = h.past[h.past.length - 1]!;
  return { past: h.past.slice(0, -1), present, future: [h.present, ...h.future], key: null };
}
export function redo<T>(h: History<T>): History<T> {
  if (!canRedo(h)) return h;
  return { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1), key: null };
}
/** Ends a continuous edit, so the next change starts a new step. */
export const settle = <T>(h: History<T>): History<T> => (h.key === null ? h : { ...h, key: null });
