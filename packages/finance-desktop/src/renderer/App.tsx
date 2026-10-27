import { useCallback, useEffect, useState } from 'react';
import { BooksTab } from './views/BooksTab.js';
import { MoneyAnalysis } from './views/MoneyAnalysis.js';
import { MoneyMonth } from './views/MoneyMonth.js';
import { Payments } from './views/Payments.js';
import { Payouts } from './views/Payouts.js';
import { Royalties } from './views/Royalties.js';
import { SalesCalibration } from './views/SalesCalibration.js';

const api = window.cadrelFinance;
type Tab = 'books' | 'analysis' | 'month' | 'royalties' | 'payments' | 'payouts' | 'estimates';
const TABS: [Tab, string][] = [['books', 'Reports'], ['analysis', 'Charts and analysis'], ['month', 'Month'], ['royalties', 'Royalties and splits'], ['payments', 'Payments'], ['payouts', 'Pay authors'], ['estimates', 'Sales estimates']];

export function App() {
  const [ready, setReady] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>('books');
  /** Bumped when data changes (an import here, a capture in Market) so every view reloads. */
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    void api.ready().then(setReady, () => setReady(false));
    return api.onChange(() => {
      bump();
      void api.ready().then(setReady, () => setReady(false));
    });
  }, [bump]);

  if (ready === null) return null;
  if (!ready) {
    return (
      <div className="welcome">
        <h1>Cadrel Finance</h1>
        <p className="muted">Finance keeps its figures in the same library as Market, and that library is not set up yet. Open Market once and choose where the library goes, then come back.</p>
      </div>
    );
  }

  return (
    <>
      <header className="tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" className="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
        ))}
      </header>
      <main>
        {tab === 'books' && <BooksTab version={version} onImported={bump} />}
        {tab === 'analysis' && <MoneyAnalysis version={version} />}
        {tab === 'month' && <MoneyMonth version={version} />}
        {tab === 'royalties' && <Royalties version={version} />}
        {tab === 'payments' && <Payments version={version} onImported={bump} />}
        {tab === 'payouts' && <Payouts version={version} onChanged={bump} />}
        {tab === 'estimates' && <SalesCalibration />}
      </main>
    </>
  );
}
