import { useCallback, useEffect, useState } from 'react';
import type { StudioState } from '../shared/api';

const api = window.cadrel.studio;

/** The studio's projects and notes, kept fresh while a page that shows them is open. `act` runs a change and reports a refused one as text. */
export function useStudio(active: boolean) {
  const [state, setState] = useState<StudioState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => api.state().then(setState, (e) => setError(String(e?.message ?? e))), []);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [active, refresh]);

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
