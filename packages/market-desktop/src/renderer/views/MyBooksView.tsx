import { useEffect, useState } from 'react';
import type { OwnBookRow } from '../../shared/api.js';
import { DataTable, type Column } from './DataTable.js';

const api = window.cadrelMarket;
const n = (v: number | null) => (v === null ? '' : v.toLocaleString('en-US'));
const TEXT_LABEL = { manuscript: 'book', sample: 'sample' } as const;

/**
 * The user's own books: a list of titles, including ones not captured yet. Which books are the user's own is Market's record; the money
 * side (importing KDP reports, royalties, splits, payments) is in Finance, and a report import there adds its books here. Each book can be
 * opened on Amazon and sent with the extension, which is also where the ranks used to calibrate sales estimates come from.
 */
export function MyBooksView({ version, onOpen }: { version: number; onOpen: (asin: string) => void }) {
  return <BooksTab version={version} onOpen={onOpen} />;
}

function BooksTab({ version, onOpen }: { version: number; onOpen: (asin: string) => void }) {
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
        Your own books. Open each on Amazon and send the page with the extension: that adds its rank, price and reviews to the library. Sales, royalties and author payments are in Finance; importing a KDP report there adds its books to this list, whether or not you have captured them.
      </p>
      <div className="row">
        <input value={asin} onChange={(e) => setAsin(e.target.value.toUpperCase().trim())} placeholder="Add a book by ASIN" aria-label="ASIN to add" style={{ width: 160 }} />
        <button disabled={!/^[A-Z0-9]{10}$/.test(asin)} onClick={() => void guard(async () => { await api.setOwnBook(asin, true); setAsin(''); setMsg(`Added ${asin}.`); })}>Add</button>
        {todo.length > 0 && <button onClick={() => void guard(() => api.openBook(todo[0]!.asin))} title={todo[0]!.title ?? todo[0]!.asin}>Open next not captured ({todo.length})</button>}
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      {msg && <div className="muted" role="status">{msg}</div>}
      {books === null ? null : books.length === 0 ? (
        <p className="muted">No books of yours yet. Add a book by its ASIN, or import a KDP report in Finance.</p>
      ) : (
        <>
          <div className="muted">{books.length - todo.length} of {books.length} captured.</div>
          <DataTable rows={books} columns={columns} rowKey={(b) => b.asin} rowProps={(b) => ({ 'data-asin': b.asin })} noun="book" />
        </>
      )}
    </>
  );
}
