import { useCallback, useEffect, useState } from 'react';
import type { Overview, Page, WindowInfo } from '../shared/api';
import { Dashboard } from './Dashboard';
import { Home } from './Home';
import { Rail } from './Rail';

const api = window.cadrel;
const TITLES: Record<Page, string> = { home: 'Home', dashboard: 'Dashboard', write: 'Write', market: 'Market' };

export function App() {
  const [page, setPage] = useState<Page>('home');
  const [win, setWin] = useState<WindowInfo | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);

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

  const refresh = useCallback(() => void api.overview().then(setOverview, () => undefined), []);
  // Home and Dashboard show live data: load on arrival, on focus, and every so often while they are the page.
  useEffect(() => {
    if (page !== 'home' && page !== 'dashboard') return;
    refresh();
    const timer = setInterval(refresh, 15_000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [page, refresh]);

  const go = (p: Page) => void api.navigate(p);

  return (
    <div className="shell">
      <Rail page={page} onGo={go} />
      <main className="content" aria-label={TITLES[page]}>
        {/* Windows draws the window buttons over the top-right corner; keep clear of them. */}
        <header className={`strip${win?.overlay ? ' overlay' : ''}`}>
          <h1 className="strip-title">{TITLES[page]}</h1>
        </header>
        <div className="page">
          {page === 'home' && <Home overview={overview} onGo={go} />}
          {page === 'dashboard' && <Dashboard overview={overview} onGo={go} />}
        </div>
      </main>
    </div>
  );
}
