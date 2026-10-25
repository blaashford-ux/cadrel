import { useEffect, useState } from 'react';
import type { BookRow, CategorySummary } from '../../shared/api.js';
import { BookDetailView } from './BookDetailView.js';
import { MyBooksView } from './MyBooksView.js';
import { DataTable, type Column } from './DataTable.js';

const api = window.cadrelMarket;

const TEXT_LABEL = { manuscript: 'book', sample: 'sample' } as const;
/** Whole days from an ISO capture time to now (never negative). */
const daysSince = (iso: string): number => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000));
const money = (v: number | null) => (v != null ? `$${v.toFixed(2)}` : '');

export function LibraryView({ version }: { version: number }) {
  const [cats, setCats] = useState<CategorySummary[]>([]);
  const [books, setBooks] = useState<BookRow[]>([]);
  const [cat, setCat] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [sub, setSub] = useState<'all' | 'mine'>('all');

  useEffect(() => { void api.categories().then(setCats); }, [version]);
  useEffect(() => {
    void api.books({ categoryKey: cat || undefined, search: search || undefined }).then(setBooks);
  }, [cat, search, version, open]);

  const columns: Column<BookRow>[] = [
    { key: 'title', label: 'Title', get: (b) => b.title ?? b.asin, render: (b) => <button className="link" onClick={() => setOpen(b.asin)}>{b.title ?? b.asin}</button> },
    { key: 'author', label: 'Author', get: (b) => b.authorNames.join(', ') },
    { key: 'rank', label: 'Rank', num: true, get: (b) => b.listRank, render: (b) => b.listRank?.toLocaleString() ?? '', title: (b) => (b.listCategory ? `Last recorded on the ${b.listCategory} list` : undefined) },
    { key: 'storeRank', label: 'Store rank', num: true, get: (b) => b.overallRank, render: (b) => b.overallRank?.toLocaleString() ?? '', title: () => 'Rank in the whole Kindle Store, from the newest book page' },
    { key: 'rating', label: 'Rating', num: true, get: (b) => b.ratingValue },
    { key: 'ratings', label: 'Ratings', num: true, get: (b) => b.ratingCount, render: (b) => b.ratingCount?.toLocaleString() ?? '' },
    { key: 'price', label: 'Price', num: true, get: (b) => b.kindlePrice, render: (b) => money(b.kindlePrice) },
    { key: 'captures', label: 'Captures', num: true, get: (b) => b.snapshots },
    { key: 'mine', label: 'Mine', choices: ['mine', ''], get: (b) => (b.own ? 'mine' : ''), render: (b) => (b.own ? '★' : ''), title: () => 'One of your own books (see My Books)' },
    { key: 'text', label: 'Text', choices: ['book', 'sample', ''], get: (b) => (b.text ? TEXT_LABEL[b.text] : '') },
  ];

  if (open) return <BookDetailView asin={open} version={version} onBack={() => setOpen(null)} />;

  return (
    <>
      <h1>Library</h1>
      <div className="subtabs" aria-label="Library sections">
        {([['all', 'All books'], ['mine', 'My Books']] as const).map(([id, label]) => (
          <button key={id} className="tab" aria-pressed={sub === id} onClick={() => setSub(id)}>{label}</button>
        ))}
      </div>
      {sub === 'mine' ? <MyBooksView version={version} onOpen={setOpen} /> : <>
      <div className="grid3">
        {cats.map((c) => (
          <div className="card" key={c.key}>
            <button className="link" onClick={() => void api.openShelf(c.key).catch(() => {})} title={`Open ${c.name ?? c.key} Best Sellers on Amazon to capture it again`}><strong>{c.name ?? c.key}</strong></button>
            <div className="muted">{c.store} · {c.listCaptures} list capture{c.listCaptures === 1 ? '' : 's'}</div>
            <div className="muted">{c.lastListCapture ? `Last captured ${c.lastListCapture.slice(0, 10)} · ${daysSince(c.lastListCapture)} day${daysSince(c.lastListCapture) === 1 ? '' : 's'} ago` : 'Never captured'}</div>
            <div>{c.capturedBooks} of {c.listedBooks} listed books captured</div>
          </div>
        ))}
        {cats.length === 0 && <p className="muted">No lists captured yet.</p>}
      </div>
      <h2>Books</h2>
      <div className="row">
        <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {cats.map((c) => <option key={c.key} value={c.key}>{c.name ?? c.key}</option>)}
        </select>
        <input placeholder="Search title, author or ASIN" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {books.length === 0 ? (
        <p className="muted">No books captured yet.</p>
      ) : (
        <DataTable
          rows={books} columns={columns} rowKey={(b) => b.asin} rowProps={(b) => ({ 'data-asin': b.asin })}
        />
      )}
      </>}
    </>
  );
}
