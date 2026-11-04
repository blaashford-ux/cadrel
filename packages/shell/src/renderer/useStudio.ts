import { useCallback, useEffect, useState } from 'react';
import type { StudioState } from '../shared/api';
import { SLOW_REFRESH_MS } from '../shared/refresh';

const api = window.cadrel.studio;

/** The studio's projects and notes, kept fresh while a page that shows them is open. `act` runs a change and reports a refused one as text. */
/** `page` changes when the person moves to another page: arriving at one asks again, so what was made elsewhere (in Write, in Market) is there. */
export function useStudio(active: boolean, page?: string) {
  const [state, setState] = useState<StudioState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => api.state().then(setState, (e) => setError(String(e?.message ?? e))), []);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, SLOW_REFRESH_MS); // on demand otherwise; nobody is looking while the window is hidden
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [active, page, refresh]);

  /** Runs a change; true when it went through. A refusal ("already exists") is shown, not thrown. */
  const act = useCallback(
    async <T,>(job: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => {
      setError(null);
      try {
        const value = await job();
        await refresh();
        return { ok: true, value };
      } catch (e) {
        setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
        return { ok: false };
      }
    },
    [refresh]
  );

  return { state, error, clearError: () => setError(null), act, refresh };
}
