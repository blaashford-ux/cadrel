import { useEffect, useState } from 'react';
import type { ScopeView } from '../shared/api';

const api = window.cadrel.scope;

/** The last scope heard, kept for the whole window, so a page that mounts later starts from it instead of flashing everything while it asks. */
let last: ScopeView | null = null;
const listeners = new Set<(s: ScopeView) => void>();
let started = false;
function start(): void {
  if (started) return;
  started = true;
  const heard = (s: ScopeView) => {
    last = s;
    for (const l of listeners) l(s);
  };
  void api.get().then(heard, () => undefined);
  api.onChange(heard);
}

/** The Project and Book the app is showing (null until the first answer). It follows changes made anywhere: another page, a project archived. */
export function useScope(): ScopeView | null {
  start();
  const [scope, setScope] = useState<ScopeView | null>(last);
  useEffect(() => {
    listeners.add(setScope);
    if (last) setScope(last);
    return () => void listeners.delete(setScope);
  }, []);
  return scope;
}
