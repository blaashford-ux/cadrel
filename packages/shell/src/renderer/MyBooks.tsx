import { useEffect, useMemo, useState } from 'react';
import { NotesPanel } from '@cadrel/ui';
import type { BookPage, BookSaveResult, CatalogueBookRow, CatalogueDetail, CatalogueList, MyBookRow, MyBooksList, StudioState } from '../shared/api';

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

function BookView({ asin, financeVisible, studio, act, onBack }: { asin: string; financeVisible: boolean; studio: StudioState | null; act: Props['act']; onBack?: () => void }) {
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
        {onBack && <button type="button" className="link" onClick={onBack}>← My Books</button>}
        <p className="muted">{err ?? 'That book is not in My Books any more.'}</p>
      </>
    );
  }
  const m = page.market;
  const f = page.finance;
  return (
    <div className="mybook">
      {onBack && <button type="button" className="link" onClick={onBack}>← My Books</button>}
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

/** The list from Market alone: used where this computer holds no catalogue records for the Studio. */
function MarketList({ studio, act, error, clearError }: Props) {
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

const FORMATS = ['ebook', 'paperback', 'hardcover', 'audiobook', 'other'];
const num = (v: string): number | null => (v.trim() === '' ? null : Number(v));

/** Runs a change and reports a refusal in words. */
function useRun(reload: () => void) {
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = async <T,>(job: () => Promise<T>, ok?: string): Promise<{ ok: true; value: T } | { ok: false }> => {
    setErr(null);
    setNote(null);
    try {
      const value = await job();
      if (ok) setNote(ok);
      reload();
      return { ok: true, value };
    } catch (e) {
      setErr(clean(e));
      return { ok: false };
    }
  };
  return { err, note, run, clear: () => (setErr(null), setNote(null)) };
}

function Progress({ b }: { b: Pick<CatalogueBookRow, 'words' | 'goalWords'> }) {
  if (b.words === null) return <span className="muted small">no manuscript</span>;
  const pct = b.goalWords ? Math.min(100, Math.round((b.words / b.goalWords) * 100)) : null;
  return <span className="small">{n(b.words)} words{pct !== null ? <span className="muted"> · {pct}% of {n(b.goalWords)}</span> : null}</span>;
}

function NewBook({ list, onDone }: { list: CatalogueList; onDone: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [pen, setPen] = useState('');
  const [seriesId, setSeriesId] = useState('');
  const [position, setPosition] = useState('');
  const [newSeries, setNewSeries] = useState('');
  const { err, run } = useRun(() => undefined);
  const make = async () => {
    const r = await run(async () => {
      let sid: string | null = seriesId || null;
      if (seriesId === '__new') sid = (await api.createSeries({ name: newSeries })).id;
      return api.createBook({ title, penName: pen, seriesId: sid, position: sid ? num(position) : null });
    });
    if (r.ok) onDone(r.value.id);
  };
  return (
    <form className="card" aria-label="New book" onSubmit={(e) => (e.preventDefault(), void make())}>
      <h3>New book</h3>
      <div className="row">
        <input aria-label="Title" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus />
        <input aria-label="Pen name" placeholder="Pen name" value={pen} onChange={(e) => setPen(e.target.value)} list="mb-pens" />
        <datalist id="mb-pens">{[...new Set(list.books.map((b) => b.penName).filter(Boolean))].map((p) => <option key={p} value={p} />)}</datalist>
      </div>
      <div className="row">
        <select aria-label="Series" value={seriesId} onChange={(e) => setSeriesId(e.target.value)}>
          <option value="">Not in a series</option>
          {list.series.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          <option value="__new">A new series…</option>
        </select>
        {seriesId === '__new' && <input aria-label="New series name" placeholder="Series name" value={newSeries} onChange={(e) => setNewSeries(e.target.value)} />}
        {seriesId !== '' && <input aria-label="Position in the series" placeholder="Position (1, 2, 2.5…)" value={position} onChange={(e) => setPosition(e.target.value)} inputMode="decimal" />}
        <button type="submit" className="primary" disabled={!title.trim() || (seriesId === '__new' && !newSeries.trim())}>Create</button>
      </div>
      {err && <div className="banner error" role="alert">{err}</div>}
    </form>
  );
}

function CatalogueListView({ list, reload, onOpen }: { list: CatalogueList; reload: () => void; onOpen: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const [seriesF, setSeriesF] = useState('');
  const [adding, setAdding] = useState(false);
  const { err, note, run } = useRun(reload);
  const money = list.financeVisible;
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return list.books.filter((b) => (!seriesF || (seriesF === '__none' ? !b.seriesId : b.seriesId === seriesF)) && (!q || `${b.title} ${b.penName} ${b.seriesName ?? ''} ${b.editions.map((e) => `${e.asin ?? ''} ${e.isbn ?? ''}`).join(' ')}`.toLowerCase().includes(q)));
  }, [list, search, seriesF]);
  const grouped = useMemo(() => {
    const out: { key: string; name: string | null; books: CatalogueBookRow[] }[] = [];
    for (const s of list.series) {
      const books = rows.filter((b) => b.seriesId === s.id).sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || a.title.localeCompare(b.title));
      if (books.length) out.push({ key: s.id, name: s.name, books });
    }
    const alone = rows.filter((b) => !b.seriesId).sort((a, b) => a.title.localeCompare(b.title));
    if (alone.length) out.push({ key: '__none', name: list.series.length ? 'Standalone' : null, books: alone });
    return out;
  }, [list, rows]);
  return (
    <div className="mybooks">
      <p className="muted">Every book in your catalogue, in its series, with its stage and manuscript progress from its project, and its listing, sales and royalties joined from Market and Finance by ASIN.</p>
      {list.unlisted.length > 0 && (
        <section className="banner" aria-label="Books not in the catalogue yet">
          <strong>{list.unlisted.length} book{list.unlisted.length === 1 ? '' : 's'} from your KDP reports and Market {list.unlisted.length === 1 ? 'is' : 'are'} not in the catalogue yet.</strong>{' '}
          {list.may.create && <button type="button" className="primary" onClick={() => void run(() => api.addFromMarket(list.unlisted.map((u) => u.asin)).then((r) => { if (r.skipped.length) throw new Error(`Added ${r.added.length}. ${r.skipped.map((s) => `${s.asin}: ${s.reason}`).join(' ')}`); return r; }), 'Added to the catalogue.')}>Add {list.unlisted.length === 1 ? 'it' : 'them all'}</button>}
          <ul className="plain small">{list.unlisted.slice(0, 6).map((u) => <li key={u.asin}>{u.title} <span className="muted">{u.asin}{u.penNames.length ? ` · ${u.penNames.join(', ')}` : ''}</span></li>)}</ul>
        </section>
      )}
      {err && <div className="banner error" role="alert">{err}</div>}
      {note && <div className="banner info" role="status">{note}</div>}
      <div className="row">
        <input aria-label="Search books" placeholder="Search title, pen name, series, ASIN or ISBN" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="Series" value={seriesF} onChange={(e) => setSeriesF(e.target.value)}>
          <option value="">All series</option><option value="__none">Standalone</option>
          {list.series.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {list.may.create && <button type="button" onClick={() => setAdding(!adding)}>{adding ? 'Cancel' : 'New book…'}</button>}
      </div>
      {adding && <NewBook list={list} onDone={(id) => (setAdding(false), reload(), onOpen(id))} />}
      {list.books.length === 0 ? (
        <div className="empty"><p><strong>No books in the catalogue yet.</strong></p><p className="muted">Create one with New book, or add the books Market already knows from your KDP reports.</p></div>
      ) : (
        grouped.map((g) => (
          <section key={g.key} aria-label={g.name ?? 'Books'}>
            {g.name && <h3>{g.name}</h3>}
            <table className="table">
              <thead><tr>{g.key !== '__none' && <th className="num">#</th>}<th>Title</th><th>Pen name</th><th>Stage</th><th>Manuscript</th><th className="num">Store rank</th><th className="num">Price</th>{money && <th className="num">Last month</th>}</tr></thead>
              <tbody>
                {g.books.map((b) => (
                  <tr key={b.bookId} data-book={b.bookId}>
                    {g.key !== '__none' && <td className="num">{b.position ?? ''}</td>}
                    <th><button type="button" className="link" onClick={() => onOpen(b.bookId)}>{b.title}</button>{!b.asin && <span className="muted small"> not published</span>}</th>
                    <td>{b.penName}</td>
                    <td>{b.stage ? <span className="stage-chip" style={{ borderColor: b.stageColor ?? undefined, color: b.stageColor ?? undefined }}>{b.stage}</span> : <span className="muted small">{b.projectName ? 'no stage' : 'no project'}</span>}</td>
                    <td><Progress b={b} /></td>
                    <td className="num">{n(b.market?.overallRank)}</td>
                    <td className="num">{b.market?.kindlePrice != null ? usd(b.market.kindlePrice) : ''}</td>
                    {money && <td className="num">{b.market?.money?.lastMonthUsd != null ? usd(b.market.money.lastMonthUsd) : ''}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))
      )}
      {!money && list.books.length > 0 && <p className="muted small">Sales and royalties are not part of your role, so they are not shown.</p>}
    </div>
  );
}

function RecordCard({ d, reload }: { d: CatalogueDetail; reload: () => void }) {
  const b = d.book;
  const [title, setTitle] = useState(b.title);
  const [subtitle, setSubtitle] = useState(b.subtitle);
  const [pen, setPen] = useState(b.penName);
  const [seriesId, setSeriesId] = useState(b.seriesId ?? '');
  const [position, setPosition] = useState(b.position === null ? '' : String(b.position));
  const { err, note, run } = useRun(reload);
  useEffect(() => {
    setTitle(b.title);
    setSubtitle(b.subtitle);
    setPen(b.penName);
    setSeriesId(b.seriesId ?? '');
    setPosition(b.position === null ? '' : String(b.position));
  }, [b.title, b.subtitle, b.penName, b.seriesId, b.position]);
  const edit = d.may.edit;
  const detailsDirty = title !== b.title || subtitle !== b.subtitle || pen !== b.penName;
  const placeDirty = seriesId !== (b.seriesId ?? '') || position !== (b.position === null ? '' : String(b.position));
  return (
    <section className="card" aria-labelledby="mb-rec">
      <h3 id="mb-rec">In the catalogue</h3>
      <div className="row">
        <label className="field"><span className="field-label">Title</span><input value={title} disabled={!edit} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></label>
        <label className="field"><span className="field-label">Subtitle</span><input value={subtitle} disabled={!edit} onChange={(e) => setSubtitle(e.target.value)} /></label>
        <label className="field"><span className="field-label">Pen name</span><input value={pen} disabled={!edit} onChange={(e) => setPen(e.target.value)} /></label>
        {edit && <button type="button" className="primary" disabled={!detailsDirty || !title.trim()} onClick={() => void run(() => api.updateBook(b.bookId, { title, subtitle, penName: pen }), 'Saved.')}>Save</button>}
      </div>
      <div className="row">
        <label className="field"><span className="field-label">Series</span>
          <select value={seriesId} disabled={!edit} onChange={(e) => setSeriesId(e.target.value)} aria-label="Series">
            <option value="">Not in a series</option>
            {d.series.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        {seriesId && <label className="field"><span className="field-label">Position</span><input value={position} disabled={!edit} onChange={(e) => setPosition(e.target.value)} inputMode="decimal" aria-label="Position in the series" placeholder="next free" /></label>}
        {edit && <button type="button" disabled={!placeDirty} onClick={() => void run(() => api.moveBook(b.bookId, seriesId || null, seriesId ? num(position) : null), 'Moved.')}>Move</button>}
      </div>
      {err && <div className="banner error" role="alert">{err}</div>}
      {note && <p className="muted small" role="status">{note}</p>}
    </section>
  );
}

/** Permanent removal of a book added by mistake: everything about it goes, from the catalogue, Market and Finance. */
function DeleteCard({ d, reload, onGone }: { d: CatalogueDetail; reload: () => void; onGone: () => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const { err, run } = useRun(reload);
  if (!d.may.archive) return null;
  const title = d.book.title;
  return (
    <section className="card" aria-labelledby="mb-del">
      <h3 id="mb-del">Delete this book</h3>
      <p className="muted small">For a book added by mistake. It is removed for good from the catalogue and from Market and Finance (pages captured, sales, pages read, royalties and splits under its ASINs), with its editions, credits, rights and shares and every log entry about them. The project it was made in stays. Nothing can bring it back; to keep a record of a book you no longer sell, archive it instead.</p>
      {!open ? <button type="button" className="danger" onClick={() => setOpen(true)}>Delete this book…</button> : (
        <div className="row">
          <label className="field"><span className="field-label">Type the title to confirm</span><input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={title} aria-label="Type the title to confirm" /></label>
          <button type="button" className="danger" disabled={typed.trim() !== title} onClick={() => void run(() => api.deleteBook(d.book.bookId)).then((r) => r.ok && onGone())}>Delete permanently</button>
          <button type="button" onClick={() => { setOpen(false); setTyped(''); }}>Cancel</button>
        </div>
      )}
      {err && <div className="banner error" role="alert">{err}</div>}
    </section>
  );
}

function EditionsCard({ d, reload }: { d: CatalogueDetail; reload: () => void }) {
  const b = d.book;
  const { err, note, run } = useRun(reload);
  const [format, setFormat] = useState('');
  const [asin, setAsin] = useState('');
  const [isbn, setIsbn] = useState('');
  const free = FORMATS.filter((f) => !b.editions.some((e) => e.format === f));
  const f = format || free[0] || '';
  const edit = d.may.edit;
  return (
    <section className="card" aria-labelledby="mb-ed">
      <h3 id="mb-ed">Editions</h3>
      {b.editions.length === 0 && <p className="muted">No editions yet. Add the format and its ASIN to join this book to Market and Finance.</p>}
      {b.editions.length > 0 && (
        <table className="table">
          <thead><tr><th>Format</th><th>ASIN</th><th>ISBN</th><th className="num">Price</th><th>Published</th></tr></thead>
          <tbody>{b.editions.map((e) => <EditionRow key={e.id} e={e} edit={edit} run={run} />)}</tbody>
        </table>
      )}
      {edit && free.length > 0 && (
        <form className="row" aria-label="Add an edition" onSubmit={(ev) => (ev.preventDefault(), void run(() => api.addEdition(b.bookId, { format: f, asin: asin.trim() || null, isbn: isbn.trim() || null }), 'Edition added.').then((r) => r.ok && (setAsin(''), setIsbn(''), setFormat(''))))}>
          <select aria-label="Format" value={f} onChange={(e) => setFormat(e.target.value)}>{free.map((x) => <option key={x} value={x}>{x}</option>)}</select>
          <input aria-label="ASIN" placeholder="ASIN" value={asin} onChange={(e) => setAsin(e.target.value)} maxLength={10} />
          <input aria-label="ISBN" placeholder="ISBN" value={isbn} onChange={(e) => setIsbn(e.target.value)} />
          <button type="submit">Add edition</button>
        </form>
      )}
      {err && <div className="banner error" role="alert">{err}</div>}
      {note && <p className="muted small" role="status">{note}</p>}
    </section>
  );
}

function EditionRow({ e, edit, run }: { e: CatalogueBookRow['editions'][number]; edit: boolean; run: ReturnType<typeof useRun>['run'] }) {
  const [asin, setAsin] = useState(e.asin ?? '');
  const [isbn, setIsbn] = useState(e.isbn ?? '');
  const [price, setPrice] = useState(e.price === null ? '' : String(e.price));
  const [date, setDate] = useState(e.publishedOn ?? '');
  useEffect(() => {
    setAsin(e.asin ?? '');
    setIsbn(e.isbn ?? '');
    setPrice(e.price === null ? '' : String(e.price));
    setDate(e.publishedOn ?? '');
  }, [e.asin, e.isbn, e.price, e.publishedOn]);
  const dirty = asin !== (e.asin ?? '') || isbn !== (e.isbn ?? '') || price !== (e.price === null ? '' : String(e.price)) || date !== (e.publishedOn ?? '');
  return (
    <tr>
      <th>{e.format}</th>
      <td><input aria-label={`${e.format} ASIN`} value={asin} disabled={!edit} onChange={(ev) => setAsin(ev.target.value)} maxLength={10} /></td>
      <td><input aria-label={`${e.format} ISBN`} value={isbn} disabled={!edit} onChange={(ev) => setIsbn(ev.target.value)} /></td>
      <td className="num"><input aria-label={`${e.format} price`} value={price} disabled={!edit} onChange={(ev) => setPrice(ev.target.value)} inputMode="decimal" size={6} /> <span className="muted small">{e.currency}</span></td>
      <td><input type="date" aria-label={`${e.format} published on`} value={date} disabled={!edit} onChange={(ev) => setDate(ev.target.value)} /></td>
      <td>{edit && <button type="button" disabled={!dirty} onClick={() => void run(() => api.updateEdition(e.id, { asin: asin.trim() || null, isbn: isbn.trim() || null, price: num(price), publishedOn: date || null }), 'Saved.')}>Save</button>}</td>
    </tr>
  );
}

function ProjectCard({ d, reload, onProject }: { d: CatalogueDetail; reload: () => void; onProject?: (id: string) => void }) {
  const b = d.book;
  const [pick, setPick] = useState('');
  const { err, run } = useRun(reload);
  return (
    <section className="card" aria-labelledby="mb-proj">
      <h3 id="mb-proj">Project and manuscript</h3>
      {b.projectId ? (
        <>
          <p>
            Made in <strong>{onProject ? <button type="button" className="link" onClick={() => onProject(b.projectId!)}>{b.projectName}</button> : b.projectName}</strong>
            {b.stage && <> · <span className="stage-chip" style={{ borderColor: b.stageColor ?? undefined, color: b.stageColor ?? undefined }}>{b.stage}</span></>}
          </p>
          <p><Progress b={b} /></p>
          {d.may.edit && <button type="button" className="quiet" onClick={() => void run(() => api.linkProject(b.bookId, null))}>Unlink</button>}
        </>
      ) : (
        <>
          <p className="muted">Link the project this book is made in, and its stage and manuscript progress show here and in the list.</p>
          {d.may.edit && (
            <div className="row">
              <select aria-label="Project" value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Choose a project…</option>{d.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              <button type="button" disabled={!pick} onClick={() => void run(() => api.linkProject(b.bookId, pick))}>Link</button>
            </div>
          )}
        </>
      )}
      {err && <div className="banner error" role="alert">{err}</div>}
    </section>
  );
}

function CatalogueBookView({ bookId, financeVisible, studio, act, onBack, onProject }: { bookId: string; financeVisible: boolean; studio: StudioState | null; act: Props['act']; onBack: () => void; onProject?: (id: string) => void }) {
  const [d, setD] = useState<CatalogueDetail | null | undefined>(undefined);
  const [asin, setAsin] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);
  useEffect(() => {
    let live = true;
    void api.catalogueBook(bookId).then((x) => live && setD(x), () => live && setD(null));
    return () => {
      live = false;
    };
  }, [bookId, tick]);
  const asins = (d?.book.editions ?? []).filter((e) => e.asin).map((e) => ({ asin: e.asin!, format: e.format }));
  const shown = asin && asins.some((a) => a.asin === asin) ? asin : d?.book.asin ?? null;
  if (d === undefined) return <p className="muted">Loading…</p>;
  if (d === null) return <><button type="button" className="link" onClick={onBack}>← My Books</button><p className="muted">That book is not in the catalogue any more.</p></>;
  return (
    <div className="mybook">
      <button type="button" className="link" onClick={onBack}>← My Books</button>
      <h2>{d.book.title}{d.book.seriesName ? <span className="muted small"> · {d.book.seriesName}{d.book.position !== null ? ` #${d.book.position}` : ''}</span> : null}</h2>
      <RecordCard d={d} reload={reload} />
      <EditionsCard d={d} reload={reload} />
      <ProjectCard d={d} reload={reload} onProject={onProject} />
      <DeleteCard d={d} reload={reload} onGone={onBack} />
      {asins.length > 1 && (
        <label className="inline"><span className="muted small">Listing, sales and royalties for</span>
          <select value={shown ?? ''} onChange={(e) => setAsin(e.target.value)} aria-label="Edition shown below">{asins.map((a) => <option key={a.asin} value={a.asin}>{a.format} · {a.asin}</option>)}</select>
        </label>
      )}
      {shown ? <BookView key={shown} asin={shown} financeVisible={financeVisible} studio={studio} act={act} /> : <section className="card"><p className="muted">This book has no ASIN yet, so there is no listing, sales or royalty data to join. Add an edition with its ASIN above once it is published.</p></section>}
    </div>
  );
}

export function MyBooks(props: Props & { onProject?: (id: string) => void }) {
  const [list, setList] = useState<CatalogueList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = () => void api.catalogue().then(setList, (e) => setLoadError(clean(e)));
  useEffect(() => {
    if (open) return;
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [open]);
  if (loadError) return <div className="banner error" role="alert">{loadError}</div>;
  if (!list) return <p className="muted">Loading…</p>;
  if (!list.available) return <MarketList {...props} />;
  return open ? (
    <>
      {props.error && <div className="banner error" role="alert">{props.error} <button type="button" className="link" onClick={props.clearError}>Dismiss</button></div>}
      <CatalogueBookView bookId={open} financeVisible={list.financeVisible} studio={props.studio} act={props.act} onBack={() => setOpen(null)} onProject={props.onProject} />
    </>
  ) : (
    <CatalogueListView list={list} reload={load} onOpen={setOpen} />
  );
}
