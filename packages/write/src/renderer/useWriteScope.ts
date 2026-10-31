import { useEffect, useState } from 'react';
import type { WriteScope } from '../shared/scope';

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
