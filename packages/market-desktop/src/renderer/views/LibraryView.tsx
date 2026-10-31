import { useEffect, useState } from 'react';
import type { BookRow, CategorySummary } from '../../shared/api.js';
import { BookDetailView } from './BookDetailView.js';
import { MyBooksView } from './MyBooksView.js';
import { DataTable, type Column } from './DataTable.js';
import { scopedBooks, scopedCategories, useMarketScope } from '../scope.js';

const api = window.cadrelMarket;

const TEXT_LABEL = { manuscript: 'book', sample: 'sample' } as const;
/** Whole days from an ISO capture time to now (never negative). */
const daysSince = (iso: string): number => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000));
const money = (v: number | null) => (v != null ? `$${v.toFixed(2)}` : '');

export function LibraryView({ version, show = null }: { version: number; show?: { asin: string } | null }) {
  const [cats, setCats] = useState<CategorySummary[]>([]);
  const [books, setBooks] = useState<BookRow[]>([]);
  const [cat, setCat] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [sub, setSub] = useState<'all' | 'mine'>('all');
  const scope = useMarketScope();
  const keys = scope.keys;
  useEffect(() => setCat(''), [scope.token]);
  const [editing, setEditing] = useState<{ key: string; name: string } | null>(null);
  const [err, setErr] = useState('');
  const rename = async (key: string, name: string) => {
    try { await api.renameCategory(key, name); setEditing(null); setErr(''); setCats(scopedCategories(await api.categories(), keys)); } catch (e) { setErr((e as Error).message); }
  };
  useEffect(() => { if (show) setOpen(show.asin); }, [show]);

  useEffect(() => { void api.categories().then((c) => setCats(scopedCategories(c, keys))); }, [version, scope.token]);
  useEffect(() => {
    void scopedBooks(api, keys, { categoryKey: cat || undefined, search: search || undefined }).then(setBooks);
  }, [cat, search, version, open, scope.token]);

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
            {editing?.key === c.key ? (
              <form className="row" onSubmit={(e) => { e.preventDefault(); void rename(c.key, editing.name); }}>
                <input autoFocus aria-label={`New name for ${c.name ?? c.key}`} placeholder="Leave empty to use Amazon's name" maxLength={120} value={editing.name} onChange={(e) => setEditing({ key: c.key, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }} />
                <button type="submit">Save</button>
                <button type="button" className="link" onClick={() => setEditing(null)}>Cancel</button>
              </form>
            ) : (
              <>
                <button className="link" onClick={() => void api.openShelf(c.key).catch(() => {})} title={`Open ${c.name ?? c.key} Best Sellers on Amazon to capture it again`}><strong>{c.name ?? c.key}</strong></button>
                {' '}<button className="link" aria-label={`Rename ${c.name ?? c.key}`} title={c.renamed ? 'Rename it, or leave the name empty to go back to the name Amazon gives it' : 'Give this category your own name (the name Amazon gives it is kept)'} onClick={() => setEditing({ key: c.key, name: c.renamed ? (c.name ?? '') : '' })}>Rename</button>
                {c.renamed && <> <span className="muted">(your name)</span> <button className="link" onClick={() => void rename(c.key, '')}>Reset</button></>}
              </>
            )}
            <div className="muted">{c.store} · {c.listCaptures} list capture{c.listCaptures === 1 ? '' : 's'}</div>
            <div className="muted">{c.lastListCapture ? `Last captured ${c.lastListCapture.slice(0, 10)} · ${daysSince(c.lastListCapture)} day${daysSince(c.lastListCapture) === 1 ? '' : 's'} ago` : 'Never captured'}</div>
            <div>{c.capturedBooks} of {c.listedBooks} listed books captured</div>
          </div>
        ))}
        {cats.length === 0 && <p className="muted">No lists captured yet.</p>}
      </div>
      {err && <p role="alert" className="err">{err}</p>}
      <h2>Books</h2>
      <div className="row">
        <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
          <option value="">{keys ? 'All of this project’s categories' : 'All categories'}</option>
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
