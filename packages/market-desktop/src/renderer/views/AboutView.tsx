import { useEffect, useRef, useState } from 'react';
import type { AppInfo, TokenStatus, UpdateState } from '../../shared/api.js';

const api = window.cadrelMarket;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function TokenBox({ onChange }: { onChange: () => void }) {
  const [st, setSt] = useState<TokenStatus | null>(null);
  const [value, setValue] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { void api.githubTokenStatus().then(setSt); }, []);
  if (!st) return null;
  const run = async (f: () => Promise<TokenStatus>, ok: string) => {
    try { setSt(await f()); setValue(''); setMsg(ok); onChange(); } catch (e) { setMsg(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
  };
  return (
    <div className="card" aria-label="GitHub access">
      <h2 style={{ marginTop: 0 }}>GitHub access</h2>
      <p className="muted">
        Cadrel Market’s releases are in a private GitHub repository, so checking for updates needs a read-only token. Create a fine-grained personal access token for the
        Cadrel Market repository with the single permission <b>Contents: read</b>. The token is stored encrypted by your operating system and is sent only to github.com.
      </p>
      <div className="row">
        <input type="password" autoComplete="off" placeholder={st.saved ? 'A token is saved' : 'Paste token'} value={value} onChange={(e) => setValue(e.target.value)} aria-label="GitHub token" style={{ width: 320 }} disabled={!st.canSave} />
        <button disabled={!value || !st.canSave} onClick={() => run(() => api.setGithubToken(value), 'Token saved')}>Save token</button>
        <button disabled={!st.saved} onClick={() => run(() => api.setGithubToken(null), 'Token removed')}>Remove token</button>
        <span role="status" className="muted">{msg}</span>
      </div>
      {st.fromEnvironment && <div className="muted">A token from the CADREL_MARKET_GITHUB_TOKEN environment variable is in use.</div>}
      {!st.canSave && <div className="err">This computer cannot encrypt the token, so Cadrel Market will not store it. Set the CADREL_MARKET_GITHUB_TOKEN environment variable instead.</div>}
    </div>
  );
}

export function AboutView() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [u, setU] = useState<UpdateState | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => { if (timer.current) clearInterval(timer.current); timer.current = null; };
  useEffect(() => { void api.appInfo().then(setInfo); void api.updateState().then(setU); return stopPolling; }, []);

  const check = async () => { setU(await api.checkForUpdates()); };
  const install = async () => {
    timer.current = setInterval(() => { void api.updateState().then(setU); }, 400); // download progress
    try { setU(await api.installUpdate()); } finally { stopPolling(); }
  };

  const busy = u?.phase === 'checking' || u?.phase === 'downloading' || u?.phase === 'launching';
  const i = u?.info;
  return (
    <>
      <h1>About Cadrel Market</h1>
      <div className="card">
        {info && (
          <table style={{ width: 'auto', border: 'none' }}>
            <tbody>
              <tr><th>Version</th><td data-testid="version">{info.version}</td></tr>
              <tr><th>Runs on</th><td>{info.platform}{info.electron ? `, Electron ${info.electron}` : ''}</td></tr>
              <tr><th>Library</th><td><code>{info.libraryRoot ?? 'none chosen'}</code></td></tr>
              <tr><th>Settings and logs</th><td><code>{info.dataFolder}</code></td></tr>
              <tr><th>Releases</th><td><code>github.com/{info.repo}</code></td></tr>
            </tbody>
          </table>
        )}
      </div>

      <div className="card" aria-label="Updates">
        <h2 style={{ marginTop: 0 }}>Updates</h2>
        <div className="row">
          <button className="primary" onClick={check} disabled={busy}>{u?.phase === 'checking' ? 'Checking…' : 'Check for updates'}</button>
          {u?.phase === 'current' && i && <span role="status">You have the latest version ({i.current}). Checked {new Date(i.checkedAt).toLocaleTimeString()}.</span>}
          {u?.phase === 'available' && i && <span role="status"><b>Version {i.latest} is available</b> (you have {i.current}).</span>}
        </div>
        {u?.phase === 'error' && u.error && <div className="err" role="alert">{u.error}</div>}
        {i?.updateAvailable && (
          <>
            {i.notes && <details open style={{ marginBottom: 8 }}><summary>What’s new in {i.tag}</summary><pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: '6px 0' }}>{i.notes}</pre></details>}
            <div className="row">
              {i.installer && info?.canInstall && <button className="primary" onClick={install} disabled={busy}>Update now</button>}
              <button onClick={() => void api.openReleasePage()}>View release on GitHub</button>
            </div>
            {i.installer && info?.canInstall && <div className="muted">Downloads {i.installer.name} ({mb(i.installer.size)}), checks it, then starts the installer and closes Cadrel Market. Your library and settings are kept.</div>}
            {i.installer && info && !info.canInstall && <div className="muted">Installing from inside the app works in the installed Windows app only; open the release to download the installer.</div>}
            {!i.installer && <div className="muted">This release has no Windows installer attached.</div>}
          </>
        )}
        {u?.phase === 'downloading' && u.progress && (
          <div role="status" aria-label="Download progress">
            <progress value={u.progress.done} max={u.progress.total || 1} style={{ width: 320 }} /> {mb(u.progress.done)} of {mb(u.progress.total)}
          </div>
        )}
        {u?.phase === 'launching' && <div role="status">Installer started. Cadrel Market will close so it can be replaced.</div>}
      </div>

      <TokenBox onChange={() => setU((s) => (s?.phase === 'error' ? { ...s, phase: 'idle', error: null } : s))} />
    </>
  );
}
