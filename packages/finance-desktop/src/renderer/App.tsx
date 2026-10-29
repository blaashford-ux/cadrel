import { useCallback, useEffect, useState } from 'react';
import { BookView } from './views/BookView.js';
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
  /** The book whose page is open (on any tab); the tabs stay in view. */
  const [asin, setAsin] = useState<string | null>(null);

  useEffect(() => {
    void api.ready().then(setReady, () => setReady(false));
    const offNavigate = api.onNavigate((page) => {
      const m = /^book:([A-Z0-9]{10})$/.exec(page);
      if (m) { setTab('books'); setAsin(m[1]!); }
    });
    const offChange = api.onChange(() => {
      bump();
      void api.ready().then(setReady, () => setReady(false));
    });
    return () => { offNavigate(); offChange(); };
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
          <button key={id} role="tab" className="tab" aria-selected={tab === id} onClick={() => { setTab(id); setAsin(null); }}>{label}</button>
        ))}
      </header>
      <main>
        {asin && <BookView asin={asin} version={version} onBack={() => setAsin(null)} onSplits={() => { setAsin(null); setTab('royalties'); }} onPayments={() => { setAsin(null); setTab('payments'); }} onPayAuthors={() => { setAsin(null); setTab('payouts'); }} />}
        {!asin && tab === 'books' && <BooksTab version={version} onImported={bump} onOpen={setAsin} />}
        {!asin && tab === 'analysis' && <MoneyAnalysis version={version} />}
        {!asin && tab === 'month' && <MoneyMonth version={version} />}
        {!asin && tab === 'royalties' && <Royalties version={version} />}
        {!asin && tab === 'payments' && <Payments version={version} onImported={bump} />}
        {!asin && tab === 'payouts' && <Payouts version={version} onChanged={bump} />}
        {!asin && tab === 'estimates' && <SalesCalibration />}
      </main>
    </>
  );
}
