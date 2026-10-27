import { useEffect, useMemo, useState } from 'react';
import { NotesPanel } from '@cadrel/ui';
import type { BookPage, BookSaveResult, MyBookRow, MyBooksList, StudioState } from '../shared/api';

const api = window.cadrel.myBooks;
const studioApi = window.cadrel.studio;

const n = (v: number | null | undefined) => (v === null || v === undefined ? '' : v.toLocaleString('en-US'));
const usd = (v: number) => v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const BASIS = { final: 'reported by KDP', estimated: 'estimated (KENP rate not final)', pending: 'not reported yet' } as const;
const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

interface Props {
  studio: StudioState | null;
  act: <T>(job: () => Promise<T>) => Promise<{ ok: boolean }>;
  error: string | null;
  clearError: () => void;
}

/** A small history line: price or rank over the captures, oldest first. Rank is drawn upside down so up means better. */
function Spark({ points, label, invert }: { points: number[]; label: string; invert?: boolean }) {
  if (points.length < 2) return <span className="muted small">{points.length === 1 ? `${label}: ${n(points[0])}` : `${label}: one capture so far`}</span>;
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const y = (v: number) => (hi === lo ? 12 : (invert ? (v - lo) : (hi - v)) / (hi - lo) * 22 + 1);
  const d = points.map((v, i) => `${i ? 'L' : 'M'}${(i / (points.length - 1)) * 118 + 1} ${y(v).toFixed(1)}`).join('');
  return (
    <span className="spark" title={`${label}: ${n(points[0])} → ${n(points[points.length - 1])}`}>
      <svg width="120" height="24" viewBox="0 0 120 24" role="img" aria-label={`${label}: ${n(points[0])} to ${n(points[points.length - 1])}`}><path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      <span className="muted small"> {label}</span>
    </span>
  );
}

function SaveBar({ page, financeVisible }: { page: BookPage; financeVisible: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BookSaveResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (job: () => Promise<BookSaveResult | null>) => {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      setResult(await job());
    } catch (e) {
      setErr(clean(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="mb-save">
      <h3 id="mb-save">Save</h3>
      <p className="muted small">These use the same save code as Market and Finance, so the files are identical to saving there. Each save goes into a new folder for this book; nothing is overwritten.</p>
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => void run(() => api.saveAll(page.asin))}>Save everything for this book…</button>
        <button type="button" disabled={busy || page.market.categories.length === 0} title={page.market.categories.length ? undefined : 'This book is not on any captured category list yet'} onClick={() => void run(() => api.saveMarket(page.asin))}>Market exports…</button>
        {financeVisible && <button type="button" disabled={busy || !page.finance?.hasData} title={page.finance?.hasData ? undefined : 'Import a KDP report in Finance first'} onClick={() => void run(() => api.saveFinance(page.asin))}>Earnings, payments and statements…</button>}
      </div>
      {err && <div className="banner error" role="alert">{err}</div>}
      {result && <div className="banner info" role="status">Saved {result.files.length} file{result.files.length === 1 ? '' : 's'} to {result.folder}</div>}
    </section>
  );
}

function BookView({ asin, financeVisible, studio, act, onBack }: { asin: string; financeVisible: boolean; studio: StudioState | null; act: Props['act']; onBack: () => void }) {
  const [page, setPage] = useState<BookPage | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api.book(asin).then((p) => live && setPage(p), (e) => live && (setPage(null), setErr(clean(e))));
    return () => {
      live = false;
    };
  }, [asin]);

  const [note, setNote] = useState<string | null>(null);
  const [noteErr, setNoteErr] = useState<string | null>(null);
  const run = async (job: () => Promise<unknown>, ok?: string) => {
    setNote(null);
    setNoteErr(null);
    try {
      await job();
      if (ok) setNote(ok);
    } catch (e) {
      setNoteErr(clean(e));
    }
  };

  const notes = useMemo(() => (studio?.notes ?? []).filter((x) => x.target?.module === 'market' && x.target.kind === 'book' && x.target.id === asin), [studio, asin]);

  if (page === undefined) return <p className="muted">Loading…</p>;
  if (page === null) {
    return (
      <>
        <button type="button" className="link" onClick={onBack}>← My Books</button>
        <p className="muted">{err ?? 'That book is not in My Books any more.'}</p>
      </>
    );
  }
  const m = page.market;
  const f = page.finance;
  return (
    <div className="mybook">
      <button type="button" className="link" onClick={onBack}>← My Books</button>
      <section className="card" aria-labelledby="mb-over">
        <div className="mb-head">
          {page.cover ? <img className="mb-cover" src={page.cover} alt={`Cover of ${page.title}`} /> : <div className="mb-cover empty" aria-hidden />}
          <div>
            <h2 id="mb-over">{page.title}</h2>
            <p className="muted">{page.penNames.join(', ') || page.authors.join(', ') || 'Author not known yet'} · {page.asin}</p>
            <p className="muted small">In My Books {page.source === 'report' ? 'from a KDP report' : 'added by ASIN'} on {page.addedAt.slice(0, 10)}.</p>
            <div className="row">
              <button type="button" className="primary" onClick={() => void run(() => api.openOnAmazon(page.asin), 'Opened the book’s page on Amazon in your browser.')}>Open on Amazon</button>
              <button type="button" onClick={() => void run(() => api.openIn('market', page.asin))}>Open in Market</button>
              {financeVisible && <button type="button" onClick={() => void run(() => api.openIn('finance', page.asin))}>Open in Finance</button>}
            </div>
            {note && <p className="muted small" role="status">{note}</p>}
            {noteErr && <div className="banner error" role="alert">{noteErr}</div>}
          </div>
        </div>
      </section>

      <section className="card" aria-labelledby="mb-market">
        <h3 id="mb-market">Listing and market</h3>
        {!m.captured ? (
          <p className="muted">No page of this book has been captured yet. Open it in Market, then send its Amazon page with the extension, to see its rank, price and reviews here.</p>
        ) : (
          <>
            <table className="table"><tbody>
              <tr><th>Store rank</th><td className="num">{n(m.overallRank) || '—'}</td><th>Price</th><td className="num">{m.kindlePrice != null ? usd(m.kindlePrice) : '—'}</td></tr>
              <tr><th>List rank</th><td className="num">{n(m.listRank) || '—'}{m.listCategory ? <span className="muted small"> on {m.listCategory}</span> : null}</td><th>Rating</th><td className="num">{m.ratingValue ?? '—'}{m.ratingCount ? <span className="muted small"> ({n(m.ratingCount)})</span> : null}</td></tr>
            </tbody></table>
            <div className="row">
              <Spark points={m.history.map((h) => h.rank).filter((v): v is number => v != null)} label="store rank" invert />
              <Spark points={m.history.map((h) => h.price).filter((v): v is number => v != null)} label="price" />
            </div>
            <p className="muted small">Last captured {m.lastCaptured?.slice(0, 10)}. {m.text ? `Text in the library: ${m.text === 'manuscript' ? 'the whole book' : 'the free sample'}.` : 'No text in the library.'}</p>
          </>
        )}
        <p className="small"><strong>On these category lists:</strong> {m.categories.length ? m.categories.map((c) => c.name).join(', ') : <span className="muted">none captured yet</span>}</p>
      </section>

      {f && (
        <>
          <section className="card" aria-labelledby="mb-sales">
            <h3 id="mb-sales">Sales and royalties</h3>
            {!f.hasData ? (
              <p className="muted">No sales for this book in the reports you have imported. Import a KDP report in Finance and they appear here.</p>
            ) : (
              <>
                <p>
                  <strong>{usd(f.totalUsd)}</strong> in the last {f.months.length} month{f.months.length === 1 ? '' : 's'} with sales
                  {f.estimatedUsd > 0 && <span className="muted small"> · {usd(f.estimatedUsd)} of it rests on an estimated Kindle Unlimited rate</span>}
                </p>
                <table className="table">
                  <thead><tr><th>Month</th><th className="num">Royalties</th><th className="num">Units</th><th className="num">KENP pages</th><th>Basis</th></tr></thead>
                  <tbody>
                    {f.months.map((r) => (
                      <tr key={r.month}><th>{r.month}</th><td className="num">{usd(r.usd)}</td><td className="num">{n(r.units)}</td><td className="num">{n(r.pages)}</td><td className="muted small">{BASIS[r.state]}</td></tr>
                    ))}
                  </tbody>
                </table>
                <p className="muted small">{n(f.paidUnits)} paid units and {n(f.kenpPages)} pages read in all{f.firstSaleDay ? `, since ${f.firstSaleDay}` : ''}. Royalty figures are as KDP reports them by sales month, in dollars at your exchange rates; they are not what has been paid out.</p>
              </>
            )}
          </section>
          <section className="card" aria-labelledby="mb-split">
            <h3 id="mb-split">Splits</h3>
            {f.split ? (
              <p>{f.split.shares.map((s) => `${s.name} ${s.pct}%`).join(' · ')}<span className="muted small"> from {f.split.fromMonth === '0000-00' ? 'the first month' : f.split.fromMonth}</span></p>
            ) : (
              <p className="muted">No split is set, so everything goes to the author KDP reports. Set one in Finance → Royalties and splits.</p>
            )}
          </section>
          <section className="card" aria-labelledby="mb-pay">
            <h3 id="mb-pay">Payments</h3>
            {!f.payments.reconciled ? (
              <p className="muted">No KDP payment report has been imported, so there is nothing to show as paid. Import the Payments report in Finance.</p>
            ) : f.payments.items.length === 0 ? (
              <p className="muted">None of the payments you have imported includes this book.</p>
            ) : (
              <>
                <table className="table">
                  <thead><tr><th>Payment</th><th>Paid on</th><th className="num">Whole payment</th><th className="num">This book</th><th>Allocation</th></tr></thead>
                  <tbody>
                    {f.payments.items.map((p) => (
                      <tr key={p.number}><th>{p.number}</th><td>{p.paidOn}{p.scheduled ? <span className="muted small"> scheduled</span> : null}</td><td className="num">{usd(p.paymentNet)}</td><td className="num">{usd(p.net)}</td><td className="muted small">{p.allocated ? (p.changed ? 'allocated; split changed since' : 'allocated') : 'not allocated'}</td></tr>
                    ))}
                  </tbody>
                </table>
                <p className="muted small">This book’s part of each payment, after the tax Amazon withheld. {f.payments.awaitingUsd > 0 ? `A further ${usd(f.payments.awaitingUsd)} is earned but not in any payment yet. ` : ''}The calculators for each payment, the roll-up by period and allocation are in Finance.</p>
                <button type="button" onClick={() => void run(() => api.openIn('finance', page.asin))}>Calculators and roll-up in Finance</button>
              </>
            )}
          </section>
        </>
      )}

      <SaveBar page={page} financeVisible={financeVisible} />

      <section className="card" aria-labelledby="mb-notes">
        <h3 id="mb-notes">Notes</h3>
        <NotesPanel
          notes={notes}
          api={{
            add: (o) => studioApi.addNote({ projectId: null, target: { module: 'market', kind: 'book', id: asin, label: page.title }, ...o }),
            setStatus: studioApi.setNoteStatus,
            reply: studioApi.replyToNote,
            remove: studioApi.deleteNote
          }}
          addTo={{ label: page.title }}
          act={act}
        />
      </section>
    </div>
  );
}

export function MyBooks({ studio, act, error, clearError }: Props) {
  const [list, setList] = useState<MyBooksList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [pen, setPen] = useState('');

  useEffect(() => {
    if (open) return;
    const load = () => void api.list().then(setList, (e) => setLoadError(clean(e)));
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [open]);

  const penNames = useMemo(() => [...new Set((list?.books ?? []).flatMap((b) => b.penNames))].sort((a, b) => a.localeCompare(b)), [list]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (list?.books ?? []).filter((b) => (!pen || b.penNames.includes(pen)) && (!q || `${b.title} ${b.asin} ${b.penNames.join(' ')}`.toLowerCase().includes(q)));
  }, [list, search, pen]);

  if (loadError) return <div className="banner error" role="alert">{loadError}</div>;
  if (!list) return <p className="muted">Loading…</p>;
  if (!list.available) {
    return (
      <section className="card" role="status">
        <h3>My Books needs Market’s library</h3>
        <p className="muted">Your books come from the same library as Market. Open Market once and choose where the library goes, then come back.</p>
      </section>
    );
  }
  if (open) {
    return (
      <>
        {error && <div className="banner error" role="alert">{error} <button type="button" className="link" onClick={clearError}>Dismiss</button></div>}
        <BookView asin={open} financeVisible={list.financeVisible} studio={studio} act={act} onBack={() => setOpen(null)} />
      </>
    );
  }
  const money = list.financeVisible;
  return (
    <div className="mybooks">
      <p className="muted">Every book you have published, in one place: its listing from Market, its sales and royalties from Finance, and its files to save. Books come from your KDP reports and from Market’s list of your own books.</p>
      <div className="row">
        <input aria-label="Search books" placeholder="Search title, pen name or ASIN" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="Pen name" value={pen} onChange={(e) => setPen(e.target.value)}>
          <option value="">All pen names</option>
          {penNames.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
      {list.books.length === 0 ? (
        <div className="empty"><p><strong>No books yet.</strong></p><p className="muted">Import a KDP report in Finance, or add a book by its ASIN in Market → Library → My Books.</p></div>
      ) : (
        <table className="table">
          <thead>
            <tr><th>Title</th><th>Pen name</th><th className="num">Store rank</th><th className="num">Price</th><th className="num">Rating</th>{money && <><th className="num">Last month</th><th className="num">Orders</th></>}</tr>
          </thead>
          <tbody>
            {rows.map((b: MyBookRow) => (
              <tr key={b.asin} data-asin={b.asin}>
                <th><button type="button" className="link" onClick={() => setOpen(b.asin)}>{b.title}</button>{!b.captured && <span className="muted small"> not captured</span>}</th>
                <td>{b.penNames.join(', ')}</td>
                <td className="num">{n(b.overallRank)}</td>
                <td className="num">{b.kindlePrice != null ? usd(b.kindlePrice) : ''}</td>
                <td className="num">{b.ratingValue ?? ''}</td>
                {money && (
                  <>
                    <td className="num" title={b.money?.lastMonth ? `${b.money.lastMonth}, ${b.money.lastMonthState ? BASIS[b.money.lastMonthState] : ''}` : undefined}>
                      {b.money?.lastMonthUsd != null ? <>{usd(b.money.lastMonthUsd)}{b.money.lastMonthState !== 'final' && <span className="muted small"> est.</span>}</> : ''}
                    </td>
                    <td className="num">{n(b.money?.paidUnits)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!money && list.books.length > 0 && <p className="muted small">Sales and royalties are not part of your role, so they are not shown.</p>}
    </div>
  );
}
