import { useCallback, useEffect, useState } from 'react';
import type { Status } from '../shared/api.js';
import { QueueView } from './views/QueueView.js';
import { AnalysisView } from './views/AnalysisView.js';
import { KeywordsView } from './views/KeywordsView.js';
import { LibraryView } from './views/LibraryView.js';
import { IssuesView } from './views/IssuesView.js';
import { SettingsView } from './views/SettingsView.js';
import { AboutView } from './views/AboutView.js';
import { ScopeProvider, useMarketScope } from './scope.js';

const api = window.cadrelMarket;
type Tab = 'queue' | 'library' | 'analysis' | 'keywords' | 'issues' | 'settings' | 'about';
/** About is opened from the application menu, beside Window, so it has no tab. */
const TABS: [Tab, string][] = [['queue', 'Queue'], ['library', 'Library'], ['analysis', 'Analysis'], ['keywords', 'Keywords'], ['issues', 'Parser health'], ['settings', 'Settings']];

export function App() {
  return (
    <ScopeProvider>
      <Pages />
    </ScopeProvider>
  );
}

const SCOPED_TABS: Tab[] = ['queue', 'library', 'analysis', 'keywords'];

function Pages() {
  const scoped = useMarketScope();
  const [status, setStatus] = useState<Status | null>(null);
  const [tab, setTab] = useState<Tab>('queue');
  /** A book another page asked to be shown (My Books in the shell): the Library opens it. */
  const [show, setShow] = useState<{ asin: string } | null>(null);
  /** Bumped whenever a capture arrives so views reload. */
  const [version, setVersion] = useState(0);
  /** Bumped when the scope changes, so the pages start again on the categories now in scope. */
  const [scopeTick, setScopeTick] = useState(0);
  useEffect(() => setScopeTick((n) => n + 1), [scoped.token]);
  const viewVersion = version + scopeTick;
  /** The Project has no Market category assigned: these pages say so instead of showing nothing. */
  const noneInScope = !!scoped.keys && scoped.keys.length === 0 && SCOPED_TABS.includes(tab);

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
        {scoped.available && (
          <span className="seg" role="group" aria-label="Which categories">
            <button type="button" className="tab" aria-pressed={scoped.mode === 'project'} onClick={() => scoped.setMode('project')} title="Only the categories assigned to this project">{scoped.title}</button>
            <button type="button" className="tab" aria-pressed={scoped.mode === 'all'} onClick={() => scoped.setMode('all')} title="Every category in the library">All</button>
          </span>
        )}
        <span className={`dot ${status.serverRunning ? 'on' : 'off'}`} title={status.serverError ?? ''}>
          {status.serverRunning ? `Listening on port ${status.port}` : status.serverError ?? 'Not listening'}
        </span>
        {!status.serverRunning && <button className="tab" onClick={() => setTab('settings')}>Fix…</button>}
      </header>
      <main>
        {noneInScope && (
          <div className="empty">
            <h1>No categories are assigned to {scoped.title}</h1>
            <p className="muted">Assign a Market category to this project on Cadrel’s Projects page and it appears here.</p>
            <button type="button" className="primary" onClick={() => scoped.setMode('all')}>Show all categories</button>
          </div>
        )}
        {!noneInScope && tab === 'queue' && <QueueView version={viewVersion} />}
        {!noneInScope && tab === 'library' && <LibraryView version={viewVersion} show={show} />}
        {!noneInScope && tab === 'analysis' && <AnalysisView version={viewVersion} />}
        {!noneInScope && tab === 'keywords' && <KeywordsView version={viewVersion} />}
        {tab === 'issues' && <IssuesView version={version} />}
        {tab === 'settings' && <SettingsView status={status} onChange={refresh} />}
        {tab === 'about' && <AboutView />}
      </main>
    </>
  );
}
