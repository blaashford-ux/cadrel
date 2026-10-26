import { useEffect, useState } from 'react';
import type { BookDetail, OwnBookRow } from '../../shared/api.js';
import { TextCard } from './TextCard.js';
import { NotesButton } from '../NotesButton.js';

const api = window.cadrelMarket;

function Spark({ values, label, invert }: { values: (number | null)[]; label: string; invert?: boolean }) {
  const pts = values.map((v, i) => (v == null ? null : ([i, v] as const))).filter((p): p is readonly [number, number] => p !== null);
  if (pts.length < 2) return <div className="muted">{label}: {pts[0] ? pts[0][1].toLocaleString() : 'n/a'} (one capture so far)</div>;
  const ys = pts.map((p) => p[1]);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const x = (i: number) => (i / (values.length - 1)) * 216 + 2;
  const y = (v: number) => (hi === lo ? 22 : (invert ? (v - lo) / (hi - lo) : 1 - (v - lo) / (hi - lo)) * 38 + 3);
  return (
    <div>
      <div className="muted">{label}: {ys[0]!.toLocaleString()} → {ys[ys.length - 1]!.toLocaleString()}</div>
      <svg className="spark" viewBox="0 0 220 44" role="img" aria-label={`${label} history`}>
        <polyline fill="none" stroke="var(--accent)" strokeWidth="2" points={pts.map(([i, v]) => `${x(i)},${y(v)}`).join(' ')} />
      </svg>
    </div>
  );
}

/** What the imported KDP reports say about one of the user's own books. */
function MySales({ b }: { b: OwnBookRow }) {
  return (
    <div className="card">
      <strong>Your sales (from the KDP reports you imported)</strong>
      <div>
        {b.paidUnits.toLocaleString()} paid unit{b.paidUnits === 1 ? '' : 's'}{b.firstSaleDay ? ` since ${b.firstSaleDay}` : ''}{b.lastSaleDay ? `, last sale ${b.lastSaleDay}` : ''}
        {b.kenpPages > 0 && <> · {b.kenpPages.toLocaleString()} Kindle Unlimited pages read</>}
      </div>
      {b.paidUnits === 0 && b.kenpPages === 0 && <div className="muted">No sales in the imported reports.</div>}
    </div>
  );
}

export function BookDetailView({ asin, onBack, version }: { asin: string; onBack: () => void; version: number }) {
  const [d, setD] = useState<BookDetail | null | undefined>(undefined);
  const [cover, setCover] = useState<string | null>(null);
  const [own, setOwn] = useState<OwnBookRow | null | undefined>(undefined);
  const [err, setErr] = useState('');
  const [lists, setLists] = useState<{ key: string; name: string | null }[]>([]);

  const loadLists = () => api.bookLists(asin).then(setLists, () => setLists([]));
  const loadOwn = () => api.ownBook(asin).then(setOwn);
  useEffect(() => {
    void api.book(asin).then(setD);
    void api.cover(asin).then(setCover);
    void loadOwn();
    void loadLists();
  }, [asin, version]);
  const run = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); } catch (e) { setErr((e as Error).message); } };
  const toggleOwn = async (v: boolean) => {
    setErr('');
    try { await api.setOwnBook(asin, v); await loadOwn(); } catch (e) { setErr((e as Error).message); }
  };

  if (d === undefined || own === undefined) return null;
  if (d === null && own) {
    // one of the user's books that has not been captured yet: it is known from a KDP report (or added by ASIN)
    return (
      <>
        <div className="row">
          <button onClick={onBack}>← Back</button>
          <button className="primary" onClick={() => api.openBook(asin)}>Open on Amazon</button>
          <button onClick={() => { if (window.confirm('Remove this book from My Books? Imported sales stay; a later report import adds it back.')) void toggleOwn(false).then(onBack); }}>Remove from My Books</button>
        </div>
        <div className="detail">
          <div className="cover-empty">Not captured yet</div>
          <div>
            <h1>{own.title ?? asin}</h1>
            <div className="muted">{own.penNames.join(', ')}</div>
            <div className="muted">★ One of your books · ASIN <code>{asin}</code></div>
          </div>
        </div>
        <MySales b={own} />
        <div className="banner">
          <strong>Bring this book into the library</strong>
          <ol>
            <li>Press <b>Open on Amazon</b>: the book's page opens in your browser.</li>
            <li>On that page, right-click and choose <b>Send to Cadrel Market</b> (or use the toolbar button).</li>
            <li>The page appears here with its rank, price, reviews and cover. Its rank is also paired with your sales to calibrate sales estimates.</li>
          </ol>
        </div>
        {err && <div className="err" role="alert">{err}</div>}
      </>
    );
  }
  if (d === null) return <><button onClick={onBack}>← Back</button><p>Not found.</p></>;
  const L = d.latest as Record<string, any>;
  const authors = d.authorNames.join(', ');

  return (
    <>
      <div className="row">
        <button onClick={onBack}>← Back</button>
        <button onClick={() => api.openBook(asin)}>Open on Amazon</button>
        <button onClick={() => api.revealBook(asin)}>Show files</button>
        <button onClick={() => void toggleOwn(!own)} title={own ? 'This is one of your books' : 'Add it to My Books'}>{own ? '★ Remove from My Books' : '☆ This is my book'}</button>
        <NotesButton kind="book" id={asin} label={String(L.title ?? asin)} />
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="detail">
        {cover ? <img src={cover} alt="Cover" /> : <div className="cover-empty">No cover</div>}
        <div>
          <h1>{L.title ?? asin}</h1>
          <div className="muted">{authors}</div>
          {L.series_name && <div>Book {L.series_position} of {L.series_total ?? '?'}: {L.series_name}</div>}
          <div>{L.rating_value ?? '–'} stars · {Number(L.rating_count ?? 0).toLocaleString()} ratings · {L.kindle_price != null ? `$${Number(L.kindle_price).toFixed(2)}` : 'no price'} · {L.pages ?? '–'} pages</div>
          <div className="muted">Published {L.publication_date ?? '–'} · {L.publisher ?? '–'} · ASIN <code>{asin}</code></div>
        </div>
      </div>

      {own && <MySales b={own} />}

      <h2>History ({d.history.length} capture{d.history.length === 1 ? '' : 's'})</h2>
      <div className="grid3">
        <div className="card"><Spark label="Kindle Store rank" values={d.history.map((h) => h.overallRank)} invert /></div>
        <div className="card"><Spark label="Price" values={d.history.map((h) => h.kindlePrice)} /></div>
        <div className="card"><Spark label="Ratings" values={d.history.map((h) => h.ratingCount)} /></div>
      </div>

      <TextCard asin={asin} />

      <h2>Ranks</h2>
      <table>
        <thead><tr><th>Store</th><th>Scope</th><th>Category</th><th className="num">Rank</th></tr></thead>
        <tbody>{d.ranks.map((r, i) => <tr key={i}><td>{String(r.store)}</td><td>{String(r.scope)}</td><td>{String(r.name)}</td><td className="num">{Number(r.rank).toLocaleString()}</td></tr>)}</tbody>
      </table>

      {L.description && (<><h2>Description</h2><div className="card" style={{ whiteSpace: 'pre-wrap' }}>{L.description}</div></>)}

      <h2>Remove</h2>
      <div className="card">
        <div className="muted">Wrong genre, or captured by mistake? Taking a book out of a category keeps it in the library but hides it from that category's analyses, search and the MCP; you can restore it from the Capture queue page. Removing it from the library deletes its pages, cover, text, notes and files.</div>
        <div className="row" style={{ marginTop: 8 }}>
          {lists.map((c) => (
            <button key={c.key} onClick={() => void run(async () => { await api.excludeFromCategory(asin, c.key); await loadLists(); })}>Remove from {c.name ?? c.key}</button>
          ))}
          {lists.length === 0 && <span className="muted">Not on any captured list.</span>}
        </div>
        <div className="row">
          <button onClick={() => { if (window.confirm('Delete this book from the library? Its captured pages, cover, text, notes and files are removed from disk. It stays on bestseller lists as a book that is not captured yet.')) void run(async () => { await api.removeBook(asin, false); onBack(); }); }}>Remove from library…</button>
          <button onClick={() => { if (window.confirm('Delete this book from the library and take it out of every category it is listed in? Its captured pages, cover, text, notes and files are removed from disk.')) void run(async () => { await api.removeBook(asin, true); onBack(); }); }}>Remove from library and all categories…</button>
        </div>
      </div>

      {d.issues.length > 0 && (
        <>
          <h2>Parse issues</h2>
          <ul>{d.issues.map((i, k) => <li key={k} className={i.severity === 'error' ? 'err' : ''}><code>{i.field}</code> {i.detail}</li>)}</ul>
        </>
      )}
    </>
  );
}
