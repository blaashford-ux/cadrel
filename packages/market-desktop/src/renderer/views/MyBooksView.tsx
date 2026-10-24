import { useEffect, useState } from 'react';
import type { OwnBookRow } from '../../shared/api.js';
import { DataTable, type Column } from './DataTable.js';
import { KdpReportImport } from './KdpReportImport.js';
import { MoneyAnalysis } from './MoneyAnalysis.js';
import { MoneyMonth } from './MoneyMonth.js';
import { Payments } from './Payments.js';
import { Payouts } from './Payouts.js';
import { Royalties } from './Royalties.js';

const api = window.bookscout;
const n = (v: number | null) => (v === null ? '' : v.toLocaleString('en-US'));
const TEXT_LABEL = { manuscript: 'book', sample: 'sample' } as const;

/**
 * The user's own books. Importing KDP Orders / KENP Read reports creates them here (before any page is captured); each can then
 * be opened on Amazon and sent with the extension, which is also where the ranks used to calibrate sales estimates come from.
 */
export function MyBooksView({ version, onOpen }: { version: number; onOpen: (asin: string) => void }) {
  const [tab, setTab] = useState<'books' | 'analysis' | 'month' | 'royalties' | 'payments' | 'payouts'>('books');
  // an import on the Books tab changes what the other tabs show
  const [imports, setImports] = useState(0);
  return (
    <>
      <div className="subtabs" aria-label="My Books sections">
        {([['books', 'Books'], ['analysis', 'Charts and analysis'], ['month', 'Month'], ['royalties', 'Royalties and splits'], ['payments', 'Payments'], ['payouts', 'Pay authors']] as const).map(([id, label]) => (
          <button key={id} className="tab" aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === 'books' ? <BooksTab version={version} onOpen={onOpen} onImported={() => setImports((x) => x + 1)} />
        : tab === 'analysis' ? <MoneyAnalysis version={version + imports} />
        : tab === 'month' ? <MoneyMonth version={version + imports} />
        : tab === 'payments' ? <Payments version={version + imports} onImported={() => setImports((x) => x + 1)} />
        : tab === 'payouts' ? <Payouts version={version + imports} onChanged={() => setImports((x) => x + 1)} />
        : <Royalties version={version + imports} />}
    </>
  );
}

function BooksTab({ version, onOpen, onImported }: { version: number; onOpen: (asin: string) => void; onImported: () => void }) {
  const [books, setBooks] = useState<OwnBookRow[] | null>(null);
  const [asin, setAsin] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const load = () => api.ownBooks().then(setBooks, (e) => setErr(String(e.message ?? e)));
  useEffect(() => { void load(); }, [version]);

  const guard = async (fn: () => Promise<unknown>) => { setErr(''); setMsg(''); try { await fn(); await load(); } catch (e) { setErr((e as Error).message); } };

  const todo = (books ?? []).filter((b) => b.snapshots === 0);
  // the same columns as Library → All books (Mine is replaced by Pen Name), then the figures from the imported KDP reports
  const penNames = [...new Set((books ?? []).flatMap((b) => b.penNames))].sort((x, y) => x.localeCompare(y));
  const columns: Column<OwnBookRow>[] = [
    { key: 'title', label: 'Title', get: (b) => b.title ?? b.asin, render: (b) => <button className="link" onClick={() => onOpen(b.asin)}>{b.title ?? b.asin}</button>, title: (b) => b.asin },
    { key: 'author', label: 'Author', get: (b) => b.authorNames.join(', ') },
    { key: 'rank', label: 'Rank', num: true, get: (b) => b.listRank, render: (b) => n(b.listRank), title: (b) => (b.listCategory ? `Last recorded on the ${b.listCategory} list` : undefined) },
    { key: 'storeRank', label: 'Store rank', num: true, get: (b) => b.overallRank, render: (b) => n(b.overallRank), title: () => 'Rank in the whole Kindle Store, from the newest book page' },
    { key: 'rating', label: 'Rating', num: true, get: (b) => b.ratingValue },
    { key: 'ratings', label: 'Ratings', num: true, get: (b) => b.ratingCount, render: (b) => n(b.ratingCount) },
    { key: 'price', label: 'Price', num: true, get: (b) => b.kindlePrice, render: (b) => (b.kindlePrice != null ? `$${b.kindlePrice.toFixed(2)}` : '') },
    { key: 'captures', label: 'Captures', num: true, get: (b) => b.snapshots, title: (b) => (b.snapshots ? `Last captured ${b.lastCaptured?.slice(0, 10)}` : 'Not captured yet: open it on Amazon and send the page with the extension') },
    { key: 'text', label: 'Text', choices: ['book', 'sample', ''], get: (b) => (b.text ? TEXT_LABEL[b.text] : '') },
    { key: 'penName', label: 'Pen Name', choices: [...penNames, ''], get: (b) => b.penNames.join(', '), values: (b) => (b.penNames.length ? b.penNames : ['']), title: () => 'The author names KDP reports the book under (all of them for a collaboration), or the authors on its captured page. Editors, illustrators and other roles are not included' },
    { key: 'orders', label: 'Orders', num: true, get: (b) => b.paidUnits, render: (b) => n(b.paidUnits), title: (b) => (b.lastSaleDay ? `Paid units in the Orders reports you imported; last sale ${b.lastSaleDay}` : 'Paid units in the Orders reports you imported') },
    { key: 'ku', label: 'KU pages read', num: true, get: (b) => b.kenpPages, render: (b) => n(b.kenpPages), title: () => 'Kindle Unlimited pages read in the KENP Read reports you imported' },
    {
      key: 'actions', label: '', get: () => null,
      render: (b) => (
        <>
          <button onClick={() => void guard(() => api.openBook(b.asin))} title="Open this book's page in your browser, then send it with the extension">Open on Amazon</button>{' '}
          <button className="link" onClick={() => { if (window.confirm('Remove this book from My Books? Captured pages and imported sales stay; a later report import adds it back.')) void guard(() => api.setOwnBook(b.asin, false)); }}>Remove</button>
        </>
      ),
    },
  ];

  return (
    <>
      <p className="muted">
        Import the report workbook from KDP Reports (kdpreports.amazon.com: the Orders download with its royalty sheets, and/or the KENP Read download) and your books appear here, whether or not you have captured them. The royalties feed the charts, the Month view and author statements on the other tabs. Open each on Amazon and send the page with the extension: that adds its rank, price and reviews to the library, and pairs its rank with your sales to calibrate sales estimates (Settings → Sales estimates).
      </p>
      <div className="row"><KdpReportImport onImported={() => { void load(); onImported(); }} /></div>
      <div className="row">
        <input value={asin} onChange={(e) => setAsin(e.target.value.toUpperCase().trim())} placeholder="Add a book by ASIN" aria-label="ASIN to add" style={{ width: 160 }} />
        <button disabled={!/^[A-Z0-9]{10}$/.test(asin)} onClick={() => void guard(async () => { await api.setOwnBook(asin, true); setAsin(''); setMsg(`Added ${asin}.`); })}>Add</button>
        {todo.length > 0 && <button onClick={() => void guard(() => api.openBook(todo[0]!.asin))} title={todo[0]!.title ?? todo[0]!.asin}>Open next not captured ({todo.length})</button>}
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      {msg && <div className="muted" role="status">{msg}</div>}
      {books === null ? null : books.length === 0 ? (
        <p className="muted">No books of yours yet. Import a KDP report above, or add a book by its ASIN.</p>
      ) : (
        <>
          <div className="muted">{books.length - todo.length} of {books.length} captured.</div>
          <DataTable rows={books} columns={columns} rowKey={(b) => b.asin} rowProps={(b) => ({ 'data-asin': b.asin })} noun="book" />
        </>
      )}
    </>
  );
}
