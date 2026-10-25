import { useEffect, useState } from 'react';
import { AppearanceForm } from '@cadrel/write/src/renderer/AppearanceForm';
import type { ThemeCustom } from '@cadrel/write/src/shared/theme';
import type { AppFolders, ShellInfo, ThemeState } from '../shared/api';
import type { ThemeSource } from '../shared/theme';

const api = window.cadrel;

const MODES: { id: ThemeSource; label: string }[] = [
  { id: 'system', label: 'Follow Windows' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' }
];

/** What belongs to the whole app rather than to Write or Market: how it looks, who you are in notes, where things are kept. */
export function Settings() {
  const [theme, setTheme] = useState<ThemeState | null>(null);
  const [folders, setFolders] = useState<AppFolders | null>(null);
  const [info, setInfo] = useState<ShellInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  /** Runs a folder change, shows a refusal as text, and refreshes what is shown. */
  const act = async (job: () => Promise<AppFolders | null>) => {
    setError(null);
    setMoving(true);
    try {
      const r = await job();
      if (r) setFolders(r);
    } catch (e) {
      setError(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setMoving(false);
    }
  };

  useEffect(() => {
    void api.theme.get().then(setTheme);
    void api.prefs.folders().then(setFolders);
    void api.info().then(setInfo);
    return api.theme.onChange(setTheme);
  }, []);

  const changeColours = (next: ThemeCustom | undefined) => void api.theme.set({ custom: next ?? null }).then(setTheme);

  return (
    <div className="settings">
      <section className="card" aria-labelledby="s-look">
        <h3 id="s-look">Appearance</h3>
        <p className="muted small">One setting for the whole app: Home, Projects, Write and Market change together.</p>
        <div className="subtabs" role="radiogroup" aria-label="Light or dark">
          {MODES.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={theme?.source === m.id} className={theme?.source === m.id ? 'active' : ''} onClick={() => void api.theme.set({ source: m.id }).then(setTheme)}>
              {m.label}
            </button>
          ))}
        </div>
        {theme && <AppearanceForm custom={theme.custom} onChange={changeColours} />}
      </section>

      <section className="card" aria-labelledby="s-where">
        <h3 id="s-where">Where things are kept</h3>
        <p className="muted small">Everything you work with lives in one Cadrel folder, in your home folder unless you move it. Write’s projects and Market’s library are inside it, ready to use: nothing to set up.</p>
        <dl className="kv">
          <dt>Cadrel folder</dt>
          <dd>
            {folders?.cadrelFolder}
            <div className="row">
              <button type="button" onClick={() => void act(() => api.prefs.chooseCadrelFolder())}>Change…</button>
              {folders && !folders.cadrelFolderIsDefault && <button type="button" onClick={() => void act(() => api.prefs.resetCadrelFolder())}>Use the default</button>}
              {moving && <span role="status" className="muted">Moving…</span>}
            </div>
            {error && <div className="banner error" role="alert">{error}</div>}
          </dd>
          <dt>Projects (Write)</dt>
          <dd>{folders?.writeRoot} {folders?.writeIsCustom && <span className="chip">chosen separately</span>}</dd>
          <dt>Library (Market)</dt>
          <dd>{folders?.marketLibrary ?? '…'} {folders?.marketIsCustom && <span className="chip">chosen separately</span>}</dd>
          <dt>Projects and notes</dt>
          <dd>{folders?.studioFile}</dd>
          <dt>App settings</dt>
          <dd>{folders?.settingsFolder}</dd>
        </dl>
        <p className="muted small">Moving the Cadrel folder moves Write’s projects and Market’s library with it. A folder you chose for Write or for Market on its own is left where it is.</p>
      </section>

      <section className="card" aria-labelledby="s-about">
        <h3 id="s-about">About</h3>
        <p>Cadrel {info?.version} <span className="muted small">· Electron {info?.electron}</span></p>
        <p className="muted small">One assistant connection serves the whole studio: in Write’s File → AI Kit, or Market’s Claude connection, you get the same single Cadrel extension.</p>
      </section>
    </div>
  );
}
