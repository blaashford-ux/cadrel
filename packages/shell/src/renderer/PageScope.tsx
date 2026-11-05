import { useCallback, useState } from 'react';
import type { ScopeView } from '../shared/api';
import { useScope } from './useScope';

export type PageScopeMode = 'project' | 'all';

/**
 * What a page shows: the Project (and Book) the app is showing, or everything in the Studio. Each page remembers its own choice (docs/UI-MODEL.md),
 * and a Studio with no Project has nothing to scope to, so such a page shows everything and the switch is absent.
 */
export interface PageScope {
  /** The scope to filter by, when the page is showing only the Project; otherwise null. */
  scope: ScopeView | null;
  /** The Project is chosen (so `scope` is set). */
  on: boolean;
  /** A Project exists to switch to (so the switch is shown). */
  available: boolean;
  mode: PageScopeMode;
  setMode(m: PageScopeMode): void;
  /** The Project, or the Project and Book, as it reads on screen. */
  title: string;
}

const key = (page: string) => `cadrel.scope.mode.${page}`;
const read = (page: string): PageScopeMode => {
  try {
    return localStorage.getItem(key(page)) === 'all' ? 'all' : 'project';
  } catch {
    return 'project';
  }
};

export function usePageScope(page: string): PageScope {
  const current = useScope();
  const [mode, setModeState] = useState<PageScopeMode>(() => read(page));
  const setMode = useCallback(
    (m: PageScopeMode) => {
      setModeState(m);
      try {
        localStorage.setItem(key(page), m);
      } catch {
        /* the choice just is not remembered */
      }
    },
    [page]
  );
  const available = !!current?.project;
  const on = available && mode === 'project';
  const title = current?.projectName ? (current.bookName ? `${current.projectName}: ${current.bookName}` : current.projectName) : '';
  return { scope: on ? current : null, on, available, mode, setMode, title };
}

/** The switch between this Project and everything. Absent when there is no Project. */
export function ScopeToggle({ s, what = 'Everything' }: { s: PageScope; what?: string }) {
  if (!s.available) return null;
  return (
    <span className="seg" role="group" aria-label="What to show">
      <button type="button" aria-pressed={s.mode === 'project'} onClick={() => s.setMode('project')} title="Only this project">{s.title}</button>
      <button type="button" aria-pressed={s.mode === 'all'} onClick={() => s.setMode('all')} title="Everything in the studio">{what}</button>
    </span>
  );
}
