import { useEffect, useState } from 'react';
import type { ScopeView } from '../shared/api';

const api = window.cadrel.scope;

/** The Project and Book the app is showing (null until the first answer). It follows changes made anywhere: another page, a project archived. */
export function useScope(): ScopeView | null {
  const [scope, setScope] = useState<ScopeView | null>(null);
  useEffect(() => {
    let live = true;
    void api.get().then((s) => live && setScope(s), () => undefined);
    const off = api.onChange((s) => live && setScope(s));
    return () => {
      live = false;
      off();
    };
  }, []);
  return scope;
}
