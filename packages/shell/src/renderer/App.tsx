import { useCallback, useEffect, useState } from 'react';
import type { Overview, Page, WindowInfo } from '../shared/api';
import { shellCss } from '../shared/theme';
import { Dashboard } from './Dashboard';
import { Home } from './Home';
import { Notes } from './Notes';
import { Profile } from './Profile';
import { Projects } from './Projects';
import { Rail } from './Rail';
import { Settings } from './Settings';
import { useStudio } from './useStudio';

const api = window.cadrel;
const TITLES: Record<Page, string> = { home: 'Home', projects: 'Projects', notes: 'Notes', dashboard: 'Dashboard', write: 'Write', market: 'Market', profile: 'Profile', settings: 'Settings' };
/** Pages the shell draws itself (the rest are modules in their own views). */
const OWN = new Set<Page>(['home', 'projects', 'notes', 'dashboard', 'profile', 'settings']);
const NEEDS_OVERVIEW = new Set<Page>(['home', 'projects', 'dashboard']);
const NEEDS_STUDIO = new Set<Page>(['home', 'projects', 'notes', 'dashboard']);

/** Puts the app's colours on this page: the shipped ones with the user's changes on top, for both schemes. */
function usePaint() {
  useEffect(() => {
    const el = document.createElement('style');
    el.id = 'cadrel-theme';
    document.head.appendChild(el);
    const paint = (custom: Parameters<typeof shellCss>[0]) => (el.textContent = shellCss(custom));
    paint(undefined);
    void api.theme.get().then((t) => paint(t.custom));
    const off = api.theme.onChange((t) => paint(t.custom));
    return () => (off(), el.remove());
  }, []);
}

export function App() {
  usePaint();
  const [page, setPage] = useState<Page>('home');
  const [win, setWin] = useState<WindowInfo | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [selected, setSelected] = useState<string | null>(() => {
    try {
      return localStorage.getItem('cadrel.project');
    } catch {
      return null;
    }
  });
  const studio = useStudio(NEEDS_STUDIO.has(page));

  useEffect(() => {
    void api.current().then(setPage);
    void api.windowInfo().then(setWin);
    const offPage = api.onPage(setPage);
    const offWin = api.onWindowState(setWin);
    return () => {
      offPage();
      offWin();
    };
  }, []);

  const select = useCallback((id: string | null) => {
    setSelected(id);
    try {
      if (id) localStorage.setItem('cadrel.project', id);
      else localStorage.removeItem('cadrel.project');
    } catch {
      /* the choice just is not remembered */
    }
  }, []);

  const refresh = useCallback(() => void api.overview().then(setOverview, () => undefined), []);
  // These pages show live data: load on arrival, on focus, and every so often while they are the page.
  useEffect(() => {
    if (!NEEDS_OVERVIEW.has(page)) return;
    refresh();
    const timer = setInterval(refresh, 15_000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [page, refresh]);

  const go = (p: Page) => void api.navigate(p);
  const own = OWN.has(page);

  return (
    <div className="shell">
      <Rail page={page} onGo={go} />
      <main className={`content${own ? '' : ' hidden'}`} aria-label={TITLES[page]}>
        {/* Windows draws the window buttons over the top-right corner; keep clear of them. */}
        <header className={`strip${win?.overlay ? ' overlay' : ''}`}>
          <h1 className="strip-title">{TITLES[page]}</h1>
        </header>
        <div className={`page page-${page}`}>
          {page === 'home' && <Home overview={overview} studio={studio.state} onGo={go} onProject={(id) => (select(id), go('projects'))} />}
          {page === 'projects' && (
            <Projects studio={studio.state} overview={overview} error={studio.error} clearError={studio.clearError} act={studio.act} onGo={go} selected={selected} onSelect={select} />
          )}
          {page === 'notes' && <Notes studio={studio.state} error={studio.error} act={studio.act} onGo={go} />}
          {page === 'dashboard' && <Dashboard overview={overview} studio={studio.state} onGo={go} onProject={(id) => (select(id), go('projects'))} />}
          {page === 'profile' && <Profile />}
          {page === 'settings' && <Settings />}
        </div>
      </main>
    </div>
  );
}
