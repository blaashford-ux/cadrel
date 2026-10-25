import { useEffect, useState } from 'react';
import { AppearanceForm } from '@cadrel/write/src/renderer/AppearanceForm';
import type { ThemeCustom } from '@cadrel/write/src/shared/theme';
import type { AppFolders, FolderKey, ShellInfo, ThemeState, UpdateStatus } from '../shared/api';
import type { ThemeSource } from '../shared/theme';

const api = window.cadrel;

const MODES: { id: ThemeSource; label: string }[] = [
  { id: 'system', label: 'Follow Windows' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' }
];

const FOLDER_ROWS: { key: FolderKey; label: string; hint: string }[] = [
  { key: 'cadrel', label: 'Cadrel folder', hint: 'Holds a folder for each Studio. Moving it moves every Studio’s folder, at the next start.' },
  { key: 'projects', label: 'Projects', hint: 'A folder for each project, made from a template on the Projects page. Write opens them from here.' },
  { key: 'write', label: 'Write', hint: 'Write’s own folder.' },
  { key: 'market', label: 'Market', hint: 'Market’s library of books and research.' }
];

function locate(f: AppFolders, key: FolderKey): { path: string; isDefault: boolean } {
  switch (key) {
    case 'cadrel': return { path: f.cadrelFolder, isDefault: f.cadrelFolderIsDefault };
    case 'projects': return { path: f.projectsFolder, isDefault: !f.projectsIsCustom };
    case 'write': return { path: f.writeFolder, isDefault: !f.writeIsCustom };
    case 'market': return { path: f.marketLibrary ?? '…', isDefault: !f.marketIsCustom };
  }
}

const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;

/** Looks for a newer version of Cadrel and installs it. A development build follows development releases only. */
function UpdateCard({ info }: { info: ShellInfo | null }) {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.update.last().then((s) => s && setSt(s));
    const a = api.update.onAvailable(setSt);
    const b = api.update.onProgress(setProgress);
    return () => (a(), b());
  }, []);

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      setSt(await api.update.check());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.update.install();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="s-update">
      <h3 id="s-update">Updates</h3>
      <p>
        You have <strong>{info?.version ?? '…'}</strong> <span className="muted small">· {(st?.channel ?? (info?.version.includes('-dev') ? 'dev' : 'stable')) === 'dev' ? 'development build: updates come from development releases only' : 'stable build: updates come from stable releases'}</span>
      </p>
      <div className="row">
        <button type="button" disabled={busy} onClick={() => void check()}>Check for updates</button>
        {st?.available && st.canInstall && <button type="button" className="primary" disabled={busy} onClick={() => void install()}>Update to {st.latest}</button>}
      </div>
      {st?.available && (
        <div className="banner info" role="status">
          <strong>Version {st.latest} is available.</strong>{' '}
          {st.canInstall ? 'Updating closes Cadrel (after asking about unsaved changes), installs, and you start it again.' : <>Download it from <code>{st.pageUrl}</code>.</>}
          {st.notes && <details><summary>What changed</summary><pre className="snippet">{st.notes}</pre></details>}
        </div>
      )}
      {st && !st.available && !st.error && <p className="muted" role="status">Cadrel is up to date{st.latest ? ` (latest: ${st.latest})` : ''}.</p>}
      {st?.error && <p className="muted" role="status">Could not check: {st.error}</p>}
      {busy && progress && progress.total > 0 && <p role="status" className="muted">Downloading {mb(progress.received)} of {mb(progress.total)}…</p>}
      {error && <div className="banner error" role="alert">{error}</div>}
    </section>
  );
}

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
        <p className="muted small">Everything you work with lives in one Cadrel folder, in your home folder unless you move it. Each part is ready to use inside it: nothing to set up. Move any of them wherever suits you; moving the Cadrel folder takes along every part you have not placed yourself.</p>
        {error && <div className="banner error" role="alert">{error}</div>}
        {folders?.moveError && <div className="banner error" role="alert">{folders.moveError}</div>}
        {folders?.pendingCadrelMove && (
          <div className="banner info" role="status">
            The Cadrel folder will move to <code className="path">{folders.pendingCadrelMove}</code> when Cadrel restarts, because nothing can be open while it moves.{' '}
            <button type="button" className="primary" onClick={() => void api.prefs.restart()}>Restart now</button>
          </div>
        )}
        <dl className="kv">
          <dt>This Studio</dt>
          <dd><strong>{folders?.studioName}</strong> <code className="path">{folders?.studioFolder}</code><div className="muted small">Each Studio keeps its own Projects, Write and Market folders in a folder named for it. Nothing is shared between Studios.</div></dd>
          {FOLDER_ROWS.map(({ key, label, hint }) => {
            const f = folders && locate(folders, key);
            return (
              <div key={key} style={{ display: 'contents' }}>
                <dt>{label}</dt>
                <dd>
                  <code className="path" title={hint}>{f?.path ?? '…'}</code> {f && !f.isDefault && <span className="chip">{key === 'cadrel' ? 'moved' : 'chosen separately'}</span>}
                  <div className="muted small">{hint}</div>
                  <div className="row">
                    <button type="button" disabled={moving} aria-label={`Change ${label}`} onClick={() => void act(() => api.prefs.choose(key))}>Change…</button>
                    {f && !f.isDefault && <button type="button" disabled={moving} aria-label={`Use the default for ${label}`} onClick={() => void act(() => api.prefs.reset(key))}>Use the default</button>}
                  </div>
                </dd>
              </div>
            );
          })}
          <dt>Projects and notes data</dt>
          <dd>{folders?.studioFile}</dd>
          <dt>App settings</dt>
          <dd>{folders?.settingsFolder}</dd>
        </dl>
        {moving && <p role="status" className="muted">Moving…</p>}
      </section>

      <UpdateCard info={info} />

      <section className="card" aria-labelledby="s-about">
        <h3 id="s-about">About</h3>
        <p>Cadrel {info?.version} <span className="muted small">· Electron {info?.electron}</span></p>
        <p className="muted small">Connecting an AI app, and everything to download for it, is on the AI Assistants page.</p>
      </section>
    </div>
  );
}
