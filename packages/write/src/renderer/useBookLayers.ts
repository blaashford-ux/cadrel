import { useEffect, useMemo, useState } from 'react';
import type { BookDetailsResult } from '../shared/api';
import { pickOverrides } from '../shared/export/layers';
import { layerEditor, type LayerEditor, type LayerState } from './layerEditor';

/** A book's saved settings as layers (the book's own over the project's over the app's), with unsaved edits. */
export function useBookLayers(file: string, reloadKey?: unknown) {
  const [loaded, setLoaded] = useState<BookDetailsResult | null>(null);
  const [state, setState] = useState<LayerState | null>(null);
  const [initial, setInitial] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoaded(null);
    setState(null);
    window.mdedit
      .getBookDetails(file)
      .then((r) => {
        if (!live) return;
        const s: LayerState = { overrides: pickOverrides(r.details, r.overrides), identity: { title: r.details.title, subtitle: r.details.subtitle, marked: r.details.marked } };
        setLoaded(r);
        setState(s);
        setInitial(JSON.stringify(s));
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [file, reloadKey]);

  const layer: LayerEditor | null = useMemo(
    () => (loaded && state ? layerEditor({ inherited: loaded.inherited, origins: loaded.origins, state, scope: 'book', onChange: setState }) : null),
    [loaded, state]
  );
  const dirty = state !== null && JSON.stringify(state) !== initial;

  /** Writes the book's settings; its own fields are exactly those that were set or changed here. */
  const save = async () => {
    if (!layer || !state) return;
    await window.mdedit.saveBookDetails(file, layer.details, Object.keys(state.overrides));
    setInitial(JSON.stringify(state));
  };

  return { loaded, layer, dirty, error, save };
}
