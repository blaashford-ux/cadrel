import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileLock, FileLockApi } from '../shared/api';

/** How often the locks on the open files are looked at again while the window is up. */
const LOCK_LOOK_MS = 60_000;

/**
 * How each open file stands for this person (checked in, checked out by them, checked out by someone else), asked of the host, so the editor can be
 * read-only until a file is checked out. Without a host that keeps files in a vault there is nothing to ask and every file is writable as usual.
 */
export function useFileLocks(api: FileLockApi | undefined, files: string[]): {
  lock(file: string): FileLock | undefined;
  /** Runs a check-out or check-in for a file and shows its new state. Throws the host's words if it is refused. */
  act(file: string, job: () => Promise<FileLock>): Promise<FileLock>;
  refresh(file?: string): Promise<void>;
} {
  const [locks, setLocks] = useState<Map<string, FileLock>>(new Map());
  const wanted = useRef<string[]>([]);
  wanted.current = files;

  const ask = useCallback(
    async (list: string[]) => {
      if (!api || list.length === 0) return;
      const next = await Promise.all(list.map(async (f) => [f, await api.state(f).catch(() => ({ kind: 'unmanaged' }) as FileLock)] as const));
      setLocks((cur) => {
        const m = new Map(cur);
        let changed = false;
        for (const [f, l] of next) {
          if (JSON.stringify(cur.get(f)) !== JSON.stringify(l)) changed = true;
          m.set(f, l);
        }
        return changed ? m : cur;
      });
    },
    [api]
  );

  const key = files.join('\n');
  useEffect(() => {
    void ask(wanted.current);
  }, [ask, key]);

  // Someone may check a file in or out elsewhere: look again now and then, and when the window comes back. Every look is a request to the
  // Studio's server that reads its whole vault, so not often, and not at all while nobody can see the window.
  useEffect(() => {
    if (!api) return;
    const id = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) void ask(wanted.current);
    }, LOCK_LOOK_MS);
    const onFocus = () => void ask(wanted.current);
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [api, ask]);

  return {
    lock: (file) => locks.get(file),
    act: async (file, job) => {
      const l = await job();
      setLocks((cur) => new Map(cur).set(file, l));
      return l;
    },
    refresh: (file) => ask(file ? [file] : wanted.current)
  };
}
