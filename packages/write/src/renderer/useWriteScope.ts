import { useEffect, useState } from 'react';
import type { WriteScope } from '../shared/scope';

const STORE = 'cadrel.write.scope';
const readAll = (): boolean => {
  try {
    return localStorage.getItem(STORE) === 'all';
  } catch {
    return false;
  }
};

/**
 * Whether Write shows every manuscript instead of only the Project's. Manuscripts that belong to no project (made before projects were linked,
 * or not linked yet) would otherwise be out of sight, so the choice is always one click away and is remembered.
 */
export function useShowAllManuscripts(): [boolean, (all: boolean) => void] {
  const [all, setAll] = useState(readAll);
  return [
    all,
    (v) => {
      setAll(v);
      try {
        localStorage.setItem(STORE, v ? 'all' : 'project');
      } catch {
        /* the choice just is not remembered */
      }
    }
  ];
}

/** The Project and Book Cadrel is showing, or null when Write is not inside Cadrel (or has not heard yet): Write then shows everything. */
export function useWriteScope(): WriteScope | null {
  const [scope, setScope] = useState<WriteScope | null>(null);
  useEffect(() => {
    const bridge = window.cadrelScope;
    if (!bridge) return;
    let live = true;
    void bridge.get().then((s) => live && setScope(s), () => undefined);
    const off = bridge.onChange((s) => live && setScope(s));
    return () => {
      live = false;
      off();
    };
  }, []);
  return scope;
}
