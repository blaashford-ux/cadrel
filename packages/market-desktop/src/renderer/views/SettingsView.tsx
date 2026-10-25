import { useEffect, useState } from 'react';
import { SalesCalibration } from './SalesCalibration.js';
import type { AppSettings, CategorySummary, IndexStatus, MaintenanceStatus, McpSnippets, Status, VerifyReport } from '../../shared/api.js';

const api = window.cadrelMarket;

function PairCard() {
  const [c, setC] = useState<{ code: string; expiresAt: number } | null>(null);
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!c) return;
    const t = setInterval(() => {
      const s = Math.max(0, Math.round((c.expiresAt - Date.now()) / 1000));
      setLeft(s);
      if (!s) setC(null);
    }, 500);
    return () => clearInterval(t);
  }, [c]);
  return (
    <div className="card" aria-label="Pair the extension">
      <h2>Pair the browser extension</h2>
      <p className="muted">Load the extension in Chrome (chrome://extensions, Developer mode, Load unpacked), click its icon, and type the code shown here. The code works once and expires after two minutes.</p>
      <div className="row">
        <button className="primary" onClick={() => { void api.pairingCode().then((r) => { setC(r); setLeft(120); }); }}>Show a pairing code</button>
        {c && <code style={{ fontSize: 22, letterSpacing: 4 }} aria-label="Pairing code">{c.code}</code>}
        {c && <span className="muted">{left}s left</span>}
        <button onClick={() => void api.openExtensionFolder()}>Open the extension folder</button>
      </div>
    </div>
  );
}

function HealthCard({ onChange }: { onChange: () => Promise<void> }) {
  const [m, setM] = useState<MaintenanceStatus | null>(null);
  const [v, setV] = useState<VerifyReport | null>(null);
  const [st, setSt] = useState<AppSettings | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    const load = () => void api.maintenanceStatus().then(setM);
    load();
    void api.settings().then(setSt);
    return api.onMaintenance(load);
  }, []);
  const run = async (f: () => Promise<unknown>) => {
    setErr('');
    try { await f(); } catch (e) { setErr(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    await onChange();
  };
  const busy = !!m?.kind;
  const mb = (n: number) => `${(n / 1048576).toFixed(n > 1e8 ? 0 : 1)} MB`;
  return (
    <div className="card" aria-label="Library care">
      <h2>Library care</h2>
      <div className="row">
        <button disabled={busy} onClick={() => run(async () => setV(await api.verifyLibrary()))}>Check the library</button>
        <button disabled={busy} onClick={() => run(() => api.backupLibrary())}>Back up…</button>
        <button disabled={busy} onClick={() => run(() => api.moveLibrary())}>Move to another folder…</button>
        <button onClick={() => void api.openLogs()}>Show the log file</button>
      </div>
      {m?.kind && <div role="status">{m.kind === 'rebuild' ? 'Re-reading pages' : m.kind === 'backup' ? 'Backing up' : m.kind === 'export' ? 'Exporting' : m.kind === 'import' ? 'Importing' : 'Moving'}… {m.done.toLocaleString()} of {m.total.toLocaleString()}</div>}
      {m?.message && !m.kind && <div role="status" className="muted">{m.message}</div>}
      {(m?.error || err) && <div className="err" role="alert">{err || m?.error}</div>}
      {v && (
        <div role="status" style={{ marginTop: 8 }}>
          <strong>{v.ok ? 'The library is healthy.' : 'Problems found.'}</strong>{' '}
          {v.counts.books.toLocaleString()} books, {v.counts.snapshots.toLocaleString()} book pages, {v.counts.listCaptures.toLocaleString()} list pages, {mb(v.sizeBytes)}.
          {!v.ok && (
            <ul>
              {v.integrity !== 'ok' && <li className="err">Database check: {v.integrity}. Use "Rebuild index".</li>}
              {v.notIndexed.length > 0 && <li>{v.notIndexed.length} capture folder(s) are not in the index. Use "Rebuild index".</li>}
              {v.missingFiles.length > 0 && <li className="err">{v.missingFiles.length} page file(s) are missing from disk (the index still lists them).</li>}
              {v.missingAssets.length > 0 && <li className="err">{v.missingAssets.length} cover file(s) are missing.</li>}
            </ul>
          )}
        </div>
      )}
      {st && (
        <div style={{ marginTop: 10 }}>
          <label><input type="checkbox" checked={st.keepRunningInTray} onChange={(e) => void api.setSettings({ keepRunningInTray: e.target.checked }).then(setSt)} /> Keep running in the system tray when the window is closed (so the extension can still send pages)</label><br />
          <label><input type="checkbox" checked={st.startWithWindows} onChange={(e) => void api.setSettings({ startWithWindows: e.target.checked }).then(setSt)} /> Start with Windows</label>
          <h3 style={{ marginTop: 16 }}>Keyword sources</h3>
          <div className="muted">The Keywords tab asks these autocomplete services what people type, from this computer, only when you press Look up. Switch off any you do not want contacted.</div>
          <label><input type="checkbox" checked={st.suggestAmazon} onChange={(e) => void api.setSettings({ suggestAmazon: e.target.checked }).then(setSt)} /> Amazon (Kindle Store search box)</label><br />
          <label><input type="checkbox" checked={st.suggestGoogle} onChange={(e) => void api.setSettings({ suggestGoogle: e.target.checked }).then(setSt)} /> Google</label><br />
          <label><input type="checkbox" checked={st.suggestBing} onChange={(e) => void api.setSettings({ suggestBing: e.target.checked }).then(setSt)} /> Bing</label>
        </div>
      )}
    </div>
  );
}

function DataPackCard({ onChange }: { onChange: () => Promise<void> }) {
  const [cats, setCats] = useState<CategorySummary[]>([]);
  const [all, setAll] = useState(true);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [m, setM] = useState<MaintenanceStatus | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    void api.categories().then(setCats);
    const load = () => void api.maintenanceStatus().then(setM);
    load();
    return api.onMaintenance(load);
  }, []);
  const busy = !!m?.kind;
  const run = async (f: () => Promise<unknown>) => {
    setErr('');
    try { await f(); } catch (e) { setErr(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    setCats(await api.categories());
    await onChange();
  };
  const toggle = (k: string) => setChosen((c) => { const n = new Set(c); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  return (
    <div className="card" aria-label="Data packs">
      <h2>Share data</h2>
      <p className="muted">
        A data pack sets up another copy of Cadrel Market to analyse the same categories: the saved Amazon pages (book pages, bestseller lists, covers
        and the searches whose results are those books), the linked subreddits with their stored text, the keyword research filed under the category, and the books you
        removed from a category. Book text, samples, your notes, queue, My Books and sales figures are never included. The search index is rebuilt after import.
      </p>
      <label><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Everything (all categories, searches, subreddits and keyword research)</label>
      {!all && (
        <div role="group" aria-label="Categories to export" style={{ maxHeight: 180, overflow: 'auto', margin: '6px 0' }}>
          {cats.length === 0 && <div className="muted">No categories captured yet.</div>}
          {cats.map((c) => (
            <div key={c.key}><label><input type="checkbox" checked={chosen.has(c.key)} onChange={() => toggle(c.key)} /> {c.name ?? c.key} <span className="muted">({c.listedBooks.toLocaleString()} books)</span></label></div>
          ))}
        </div>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <button disabled={busy || (!all && chosen.size === 0)} onClick={() => run(() => api.exportData(all ? null : [...chosen]))}>Export a data pack…</button>
        <button disabled={busy} onClick={() => run(() => api.importData())}>Import a data pack…</button>
      </div>
      <p className="muted">Importing adds to your library and never replaces pages you already have.</p>
      {err && <div className="err" role="alert">{err}</div>}
    </div>
  );
}

function SearchIndexCard() {
  const [st, setSt] = useState<IndexStatus | null>(null);
  useEffect(() => {
    const load = () => void api.indexStatus().then(setSt);
    load();
    return api.onIndex(load);
  }, []);
  if (!st) return null;
  const pct = st.progress ? Math.round((st.progress.done / Math.max(st.progress.total, 1)) * 100) : null;
  const neural = st.model?.startsWith('minilm');
  return (
    <div className="card" aria-label="Search index">
      <h2>Search index</h2>
      <p className="muted">
        Lets Claude or GPT search blurbs, reviews and bios by meaning, not just keywords. It runs on this computer; nothing is sent anywhere.
      </p>
      <div>
        {st.chunks.toLocaleString()} text chunks · {st.embedded.toLocaleString()} indexed
        {st.model ? <> · model <code>{st.model}</code>{neural ? '' : ' (basic)'}</> : ' · not built yet'}
      </div>
      {!st.vectorSearch && <div className="err">Vector search is unavailable on this computer; keyword search still works.</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" disabled={st.running || !st.vectorSearch} onClick={() => void api.buildIndex('neural')}>
          {st.modelDownloaded ? 'Build index' : 'Download model and build index'}
        </button>
        <button disabled={st.running || !st.vectorSearch} onClick={() => void api.buildIndex('basic')} title="No download; weaker matching">
          Build basic index (no download)
        </button>
        {st.progress && (
          <span role="status">
            {st.progress.phase === 'download' ? 'Downloading model' : 'Indexing'} {pct}%
          </span>
        )}
      </div>
      {st.error && <div className="err" role="alert">{st.error}</div>}
      {!st.modelDownloaded && <div className="muted">The model is about 25 MB and downloads once, from huggingface.co.</div>}
    </div>
  );
}

function ConnectCard() {
  const [m, setM] = useState<McpSnippets | null>(null);
  const [which, setWhich] = useState<'claudeDesktop' | 'claudeCode' | 'codex'>('claudeDesktop');
  const [copied, setCopied] = useState('');
  const [ext, setExt] = useState('');
  const [extFile, setExtFile] = useState('');
  useEffect(() => { void api.mcpConfig().then(setM); }, []);
  if (!m) return null;
  const labels = { claudeDesktop: 'Claude Desktop', claudeCode: 'Claude Code', codex: 'Codex' } as const;
  const where = {
    claudeDesktop: 'Add this to claude_desktop_config.json (Settings → Developer → Edit Config), then restart Claude Desktop.',
    claudeCode: 'Run this in a terminal.',
    codex: 'Add this to ~/.codex/config.toml.',
  } as const;
  return (
    <div className="card" aria-label="Connect an AI">
      <h2>Connect Claude or GPT</h2>
      <p className="muted">Cadrel Market offers your library to AI apps on this computer through MCP.</p>
      <div className="row">
        <button className="primary" onClick={async () => {
          try {
            const r = await api.installClaudeExtension();
            setExtFile(r.file);
            setExt(`Created Cadrel Market.mcpb and showed it in its folder (${r.file}).`);
          } catch (e) { setExt((e as Error).message); setExtFile(''); }
        }}>Install in Claude Desktop</button>
        <span role="status" className="muted">{ext}</span>
      </div>
      {extFile && (
        <ol className="muted" aria-label="How to install the extension">
          <li>In Claude Desktop open <b>Settings → Extensions</b> and drag <b>Cadrel Market.mcpb</b> into the window (or use <b>Advanced settings → Install Extension…</b> and choose it; menu names vary between versions).</li>
          <li>Click <b>Install</b> in the dialog it shows, then restart Claude Desktop.</li>
          <li>Do not open the file with “Claude” from a list of programs: that attaches it to a chat instead of installing it.</li>
          <li>If it will not start, the extension writes what happened to <code>logs\mcp-launcher.log</code> in Cadrel Market's settings folder (<button className="link" onClick={() => void api.openLogs()}>open the logs folder</button>).</li>
        </ol>
      )}
      <p className="muted">Or set it up by hand: pick your app and copy the setting.</p>
      <div className="row">
        {(Object.keys(labels) as (keyof typeof labels)[]).map((k) => (
          <button key={k} className="tab" aria-selected={which === k} onClick={() => setWhich(k)}>{labels[k]}</button>
        ))}
      </div>
      <div className="muted">{where[which]}</div>
      <pre style={{ overflow: 'auto', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 6, padding: 8 }}><code>{m[which]}</code></pre>
      <button onClick={() => navigator.clipboard.writeText(m[which]).then(() => setCopied(labels[which]))}>Copy</button>
      <span role="status" className="muted"> {copied && `Copied ${copied} setting`}</span>
    </div>
  );
}

export function SettingsView({ status, onChange }: { status: Status; onChange: () => Promise<void> }) {
  const [token, setToken] = useState('');
  const [show, setShow] = useState(false);
  const [port, setPort] = useState(String(status.port));
  const [msg, setMsg] = useState('');

  useEffect(() => { void api.token().then(setToken); }, [status.serverRunning]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try { await fn(); setMsg(label); } catch (e) { setMsg(String((e as Error).message ?? e)); }
    await onChange();
  };

  return (
    <>
      <h1>Settings</h1>
      <div className="card">
        <h2>Library</h2>
        <code>{status.libraryRoot}</code>
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={() => run('Library changed', async () => { await api.chooseLibrary(); })}>Choose a different folder…</button>
          <button onClick={() => run('Index rebuilt', async () => { const r = await api.rebuild(); setMsg(`Rebuilt from ${r.detail} book, ${r.list} list and ${r.search} search captures`); })}>Rebuild index</button>
        </div>
        <div className="muted">Switching points Cadrel Market at another folder; it does not move files. Copy the old folder across first to carry your captures over.</div>
      </div>
      <div className="card">
        <h2>Browser extension</h2>
        <p className="muted">Paste this token into the Cadrel Market extension's popup. Only this computer can reach the app, and only with the token.</p>
        <div className="row">
          <code aria-label="Pairing token">{show ? token : '•'.repeat(24)}</code>
          <button onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button>
          <button onClick={() => navigator.clipboard.writeText(token).then(() => setMsg('Copied'))}>Copy</button>
          <button onClick={() => run('New token created; re-pair the extension', async () => setToken(await api.rotateToken()))}>Regenerate</button>
        </div>
        <div className="row">
          <label>Port <input type="number" value={port} min={1024} max={65535} onChange={(e) => setPort(e.target.value)} style={{ width: 90 }} /></label>
          <button onClick={() => run('Port changed; update it in the extension too', () => api.setPort(Number(port)))}>Apply</button>
        </div>
      </div>
      <PairCard />
      <HealthCard onChange={onChange} />
      <DataPackCard onChange={onChange} />
      <SearchIndexCard />
      <SalesCalibration />
      <ConnectCard />
      <div role="status">{msg}</div>
    </>
  );
}
