import { useEffect, useState } from 'react';
import type { CategorySummary, Exclusion, QueueItem } from '../../shared/api.js';

const api = window.cadrelMarket;

export function QueueView({ version }: { version: number }) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [cats, setCats] = useState<CategorySummary[]>([]);
  const [cat, setCat] = useState('');
  const [showSkipped, setShowSkipped] = useState(false);
  const [onlyNew, setOnlyNew] = useState(false);
  const [note, setNote] = useState('');
  const [removed, setRemoved] = useState<Exclusion[]>([]);

  const load = async () => {
    setItems(await api.queue({ categoryKey: cat || undefined, includeSkipped: showSkipped, onlyNew }));
    setCats(await api.categories());
    setRemoved(await api.categoryExclusions(cat || undefined));
  };
  useEffect(() => { void load(); }, [cat, showSkipped, onlyNew, version]);

  const pending = items.filter((i) => i.state === 'pending').length;

  return (
    <>
      <h1>Capture queue</h1>
      <p className="muted">
        Books seen on a bestseller list or search page that you haven't captured yet. Search results stay uncategorised until you capture the book's page. "Open next" opens the next one in your browser; capture it with the right-click menu.
      </p>
      <div className="row">
        <button className="primary" disabled={pending === 0} onClick={async () => {
          const it = await api.openNext(cat || undefined, onlyNew);
          setNote(it ? `Opened ${it.title ?? it.asin}` : onlyNew ? 'No new additions left to open' : 'Nothing left to open');
          await load();
        }}>Open next</button>
        <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          <option value="uncategorised">Uncategorised (from searches)</option>
          {cats.map((c) => <option key={c.key} value={c.key}>{c.name ?? c.key}</option>)}
        </select>
        <label title="Only books that are on the newest capture of a category's list but were on none of its earlier captures: what joined the list since you last captured it."><input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} /> New additions only</label>
        <label><input type="checkbox" checked={showSkipped} onChange={(e) => setShowSkipped(e.target.checked)} /> Show skipped</label>
        <span className="muted">{pending} to go</span>
        <span role="status">{note}</span>
      </div>
      {items.length === 0 ? (
        <p className="muted">{onlyNew ? 'No new additions to capture. A book counts as new when it is on a category\'s newest list capture but on none of its earlier ones, so this needs a list captured at least twice.' : 'Nothing to capture. Capture a bestseller list or search page first and its books will appear here.'}</p>
      ) : (
        <table>
          <thead><tr><th className="num">Rank</th><th>Title</th><th>Author</th><th>Category</th><th className="num">Price</th><th>State</th><th></th></tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.asin} data-asin={i.asin}>
                <td className="num">{i.rank}</td>
                <td>{i.title ?? <span className="muted">{i.asin}</span>}{i.isNew && <>{' '}<span className="pill pending" title="Not on this category's earlier captures">new</span></>}</td>
                <td>{i.author ?? ''}</td>
                <td className="muted">{i.categoryName}</td>
                <td className="num">{i.price != null ? `$${i.price.toFixed(2)}` : ''}</td>
                <td><span className={`pill ${i.state}`}>{i.state}</span></td>
                <td>
                  <button className="link" onClick={() => api.openBook(i.asin)}>Open</button>{' · '}
                  <button className="link" title={`Wrong genre: take it out of ${i.categoryName ?? 'this category'} for good (analyses, search and the MCP stop seeing it there). You can restore it below.`} onClick={async () => { await api.excludeFromCategory(i.asin, i.categoryKey); setNote(`Removed ${i.title ?? i.asin} from ${i.categoryName ?? 'the category'}`); await load(); }}>Remove from category</button>{' · '}
                  {i.state === 'skipped'
                    ? <button className="link" onClick={async () => { await api.setQueueState(i.asin, 'pending'); await load(); }}>Restore</button>
                    : <button className="link" onClick={async () => { await api.setQueueState(i.asin, 'skipped'); await load(); }}>Skip</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {removed.length > 0 && (
        <>
          <h2>Removed from categories ({removed.length})</h2>
          <p className="muted">Books you took out of a category's lists. They stay out when the list is captured again.</p>
          <table>
            <thead><tr><th>Title</th><th>Category</th><th>Removed</th><th></th></tr></thead>
            <tbody>
              {removed.map((x) => (
                <tr key={`${x.categoryKey}|${x.asin}`}>
                  <td>{x.title ?? <span className="muted">{x.asin}</span>}</td>
                  <td className="muted">{x.categoryName ?? x.categoryKey}</td>
                  <td className="muted">{x.excludedAt.slice(0, 10)}</td>
                  <td><button className="link" onClick={async () => { await api.restoreToCategory(x.asin, x.categoryKey); await load(); }}>Restore</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
