import { useCallback, useEffect, useState } from 'react';
import type { Status } from '../shared/api.js';
import { QueueView } from './views/QueueView.js';
import { AnalysisView } from './views/AnalysisView.js';
import { KeywordsView } from './views/KeywordsView.js';
import { LibraryView } from './views/LibraryView.js';
import { IssuesView } from './views/IssuesView.js';
import { SettingsView } from './views/SettingsView.js';
import { AboutView } from './views/AboutView.js';

const api = window.cadrelMarket;
type Tab = 'queue' | 'library' | 'analysis' | 'keywords' | 'issues' | 'settings' | 'about';
/** About is opened from the application menu, beside Window, so it has no tab. */
const TABS: [Tab, string][] = [['queue', 'Queue'], ['library', 'Library'], ['analysis', 'Analysis'], ['keywords', 'Keywords'], ['issues', 'Parser health'], ['settings', 'Settings']];

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [tab, setTab] = useState<Tab>('queue');
  /** A book another page asked to be shown (My Books in the shell): the Library opens it. */
  const [show, setShow] = useState<{ asin: string } | null>(null);
  /** Bumped whenever a capture arrives so views reload. */
  const [version, setVersion] = useState(0);

  const refresh = useCallback(async () => setStatus(await api.status()), []);
  useEffect(() => {
    void refresh();
    const offCapture = api.onCapture(() => setVersion((v) => v + 1));
    const offNavigate = api.onNavigate((page) => { if (page === 'about') setTab('about'); const m = /^book:([A-Z0-9]{10})$/.exec(page); if (m) { setTab('library'); setShow({ asin: m[1]! }); } });
    return () => { offCapture(); offNavigate(); };
  }, [refresh]);

  if (!status) return null;

  if (!status.libraryRoot) {
    return (
      <div className="welcome">
        <h1>Welcome to Cadrel Market</h1>
        <p className="muted">
          Pick a folder for your library. Every page you capture, every cover and the index are kept there. You can change it later in Settings.
        </p>
        <button className="primary" onClick={async () => { if (await api.chooseLibrary()) await refresh(); }}>
          Choose library folder…
        </button>
      </div>
    );
  }

  return (
    <>
      <header className="tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" className="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
        ))}
        <span className="spacer" />
        <span className={`dot ${status.serverRunning ? 'on' : 'off'}`} title={status.serverError ?? ''}>
          {status.serverRunning ? `Listening on port ${status.port}` : status.serverError ?? 'Not listening'}
        </span>
        {!status.serverRunning && <button className="tab" onClick={() => setTab('settings')}>Fix…</button>}
      </header>
      <main>
        {tab === 'queue' && <QueueView version={version} />}
        {tab === 'library' && <LibraryView version={version} show={show} />}
        {tab === 'analysis' && <AnalysisView version={version} />}
        {tab === 'keywords' && <KeywordsView version={version} />}
        {tab === 'issues' && <IssuesView version={version} />}
        {tab === 'settings' && <SettingsView status={status} onChange={refresh} />}
        {tab === 'about' && <AboutView />}
      </main>
    </>
  );
}
