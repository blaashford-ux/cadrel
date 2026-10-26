import { useEffect, useState } from 'react';
import type { StudiosView } from '../shared/api';

const api = window.cadrel.studios;

/** Which Studio is active and which Studios this computer knows about, kept in step with changes made anywhere in the app. */
export function useStudios(): StudiosView | null {
  const [view, setView] = useState<StudiosView | null>(null);
  useEffect(() => {
    void api.get().then(setView, () => undefined);
    return api.onChange(setView);
  }, []);
  return view;
}
