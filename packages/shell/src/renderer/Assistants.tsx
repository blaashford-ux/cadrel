import { useEffect, useState } from 'react';
import type { AssistantsView } from '../shared/api';

const api = window.cadrel;
type App = 'claudeDesktop' | 'claudeCode' | 'codex';
const APPS: { id: App; label: string; where: string }[] = [
  { id: 'claudeDesktop', label: 'Claude Desktop', where: 'Add this to claude_desktop_config.json (Settings → Developer → Edit Config), then restart Claude Desktop.' },
  { id: 'claudeCode', label: 'Claude Code', where: 'Run this in a terminal.' },
  { id: 'codex', label: 'Codex (GPT)', where: 'Add this to ~/.codex/config.toml.' }
];

/** One place for connecting AI apps to Cadrel: one server for Write and Market, with everything to download or copy. */
export function Assistants() {
  const [v, setV] = useState<AssistantsView | null>(null);
  const [which, setWhich] = useState<App>('claudeDesktop');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => void api.assistants.get().then(setV), []);

  const run = async (job: () => Promise<string | void>) => {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const r = await job();
      if (r) setNote(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = (text: string, what: string) => run(() => navigator.clipboard.writeText(text).then(() => `${what} copied.`, () => 'Could not copy to the clipboard.'));

  if (!v) return <p className="muted">Loading…</p>;
  if (!v.available) return <div className="settings"><section className="card"><h3>AI assistants</h3><p className="muted">This build of Cadrel does not include the AI connection.</p></section></div>;
  const remote = v.remote;
  const snippet = v[which];

  return (
    <div className="settings assistants">
      <section className="card" aria-labelledby="as-dl">
        <h3 id="as-dl">Download</h3>
        <p className="muted small">
          One connection serves the whole studio: a Claude or GPT app can read your manuscripts in <strong>{v.projectsFolder}</strong> and leave review notes in them (it never changes your text), and search your Market research.
        </p>
        <div className="row">
          <button type="button" className="primary" disabled={busy} onClick={() => void run(async () => `Saved to ${await api.assistants.saveKit()}. Open README.txt there for the steps.`)}>Download the AI Kit</button>
          <span className="muted small">The Claude extension, the editing skills, the server and the steps for Claude and GPT, in one folder in Downloads.</span>
        </div>
        <div className="row">
          <button type="button" disabled={busy} onClick={() => void run(async () => `Saved ${await api.assistants.saveExtension()}. In Claude Desktop open Settings → Extensions and drag it into the window.`)}>Download the Claude Desktop extension</button>
          <span className="muted small">Just Cadrel.mcpb.</span>
        </div>
        {note && <div className="banner info" role="status">{note}</div>}
        {error && <div className="banner error" role="alert">{error}</div>}
      </section>

      <section className="card" aria-labelledby="as-hand">
        <h3 id="as-hand">Set it up by hand</h3>
        <div className="subtabs" role="tablist">
          {APPS.map((a) => <button key={a.id} type="button" role="tab" aria-selected={which === a.id} className={which === a.id ? 'active' : ''} onClick={() => setWhich(a.id)}>{a.label}</button>)}
        </div>
        <p className="muted small">{APPS.find((a) => a.id === which)!.where}</p>
        <pre className="snippet"><code>{snippet}</code></pre>
        <button type="button" onClick={() => void copy(snippet, APPS.find((a) => a.id === which)!.label + ' setting')}>Copy</button>
      </section>

      {remote && (
        <section className="card" aria-labelledby="as-remote">
          <h3 id="as-remote">Online apps (ChatGPT, Custom GPTs): advanced</h3>
          <p className="muted small">
            These apps run on the internet, so they cannot start a program on your PC. Turn this on and Cadrel listens on this PC only, and every request needs the access token below. To let an online app reach it you must also make it
            available on the internet yourself, for example with a tunnel such as <code>cloudflared tunnel --url http://127.0.0.1:{remote.port}</code>. Anyone with the tunnel address <strong>and</strong> the token can read your chapters
            and add notes, so keep the token private and turn this off when you are not using it.
          </p>
          <div className="row">
            <button type="button" className={remote.enabled ? '' : 'primary'} onClick={() => void api.assistants.setRemote(!remote.enabled).then((r) => setV({ ...v, remote: r }), (e) => setError((e as Error).message))}>{remote.enabled ? 'Turn off' : 'Turn on'}</button>
            <span className={remote.running ? '' : 'muted'}>{remote.running ? 'On: listening on this PC' : 'Off'}</span>
          </div>
          {remote.error && <div className="banner error" role="alert">{remote.error}</div>}
          {remote.enabled && (
            <>
              <dl className="kv">
                {([['MCP address', remote.mcpUrl], ['REST address', remote.apiUrl], ['API description (for Custom GPT Actions)', remote.openApiUrl], ['Access token', remote.token]] as const).map(([label, value]) => (
                  <div key={label} style={{ display: 'contents' }}>
                    <dt>{label}</dt>
                    <dd><code>{value}</code> <button type="button" onClick={() => void copy(value, label)}>Copy</button></dd>
                  </div>
                ))}
              </dl>
              <button type="button" onClick={() => void api.assistants.resetRemoteToken().then((r) => setV({ ...v, remote: r }), (e) => setError((e as Error).message))}>Make a new token (locks out the old one)</button>
            </>
          )}
        </section>
      )}
    </div>
  );
}
