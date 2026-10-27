import { useEffect, useState } from 'react';
import { ChartCard, Legend, StackedBars } from '@cadrel/market-desktop/src/renderer/charts.js';
import type { AnalysisReport, OwnBookRow, SplitVersion } from './types.js';
import { Breakdowns, MoneyNotes, SERIES_KEYS, Tile } from './MoneyAnalysis.js';
import { int, shortMonth, usd } from './moneyUtil.js';

const api = window.cadrelFinance;
const BASIS = { final: 'reported by KDP', estimated: 'estimated KENP rate', pending: 'not reported yet' } as const;

/**
 * One book's money: what it earned by month (reported or estimated, never mixed), where, at which rate, how it is split, and the ways to save
 * it or to open the book on Amazon. The figures are Finance's analysis limited to this book, so they always agree with the Charts tab.
 */
export function BookView({ asin, version, onBack, onSplits }: { asin: string; version: number; onBack: () => void; onSplits: () => void }) {
  const [book, setBook] = useState<OwnBookRow | null | undefined>(undefined);
  const [r, setR] = useState<AnalysisReport | null>(null);
  const [split, setSplit] = useState<SplitVersion | null>(null);
  const [range, setRange] = useState<'12' | 'all'>('12');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let live = true;
    setErr('');
    void (async () => {
      try {
        const books = await api.ownBooks();
        const months = await api.moneyMonths(); // newest first
        const splits = await api.bookSplit(asin);
        if (!live) return;
        setBook(books.find((b) => b.asin === asin) ?? null);
        setSplit(splits[splits.length - 1] ?? null);
        if (!months.length) return void setR(null);
        const used = range === '12' ? months.slice(0, 12) : months;
        setR(await api.moneyAnalysis(used[used.length - 1]!, used[0]!, asin));
      } catch (e) {
        if (live) setErr(String((e as Error).message ?? e));
      }
    })();
    return () => { live = false; };
  }, [asin, version, range]);

  const guard = async (job: () => Promise<unknown>, ok?: (v: unknown) => string) => {
    setErr(''); setMsg('');
    try { const v = await job(); if (ok) setMsg(ok(v)); } catch (e) { setErr((e as Error).message); }
  };

  if (book === undefined) return <p className="muted">Loading…</p>;
  const months = r?.months.filter((m) => m.usd || m.units || m.pages) ?? [];
  return (
    <>
      <div className="row">
        <button onClick={onBack}>← Reports</button>
        <button onClick={() => void guard(() => api.openBook(asin), () => 'Opened the book’s page on Amazon in your browser.')}>Open on Amazon</button>
        <button disabled={!months.length} onClick={() => void guard(() => api.exportBookEarnings(asin), (p) => (p ? `Saved ${p}` : ''))}>Save earnings (CSV)…</button>
        <span className="spacer" />
        <select value={range} onChange={(e) => setRange(e.target.value as '12' | 'all')} aria-label="Period">
          <option value="12">Last 12 months</option>
          <option value="all">All months</option>
        </select>
      </div>
      <h1 style={{ marginBottom: 2 }}>{book?.title ?? asin}</h1>
      <p className="muted" style={{ marginTop: 0 }}>{book?.penNames.join(', ') || book?.authorNames.join(', ') || 'Author not known yet'} · {asin}{book ? null : ' · not one of your own books any more'}</p>
      {err && <div className="err" role="alert">{err}</div>}
      {msg && <div className="muted" role="status">{msg}</div>}
      {!r || !months.length ? (
        <p className="muted">No sales for this book in the reports you have imported{range === '12' ? ' in the last 12 months' : ''}. Import a KDP report on the Reports tab.</p>
      ) : (
        <>
          <div className="tiles">
            <Tile n={usd(r.totals.usd)} l="Royalties" sub={r.totals.estimated ? `${usd(r.totals.estimated)} estimated` : 'all reported by KDP'} />
            <Tile n={int(r.totals.units)} l="Paid units" />
            <Tile n={int(r.totals.pages)} l="Kindle+ pages read" />
            <Tile n={usd(r.totals.ebook)} l="eBook" sub={`print ${usd(r.totals.print)} · Kindle+ ${usd(r.totals.kenp)}`} />
          </div>
          <MoneyNotes r={r} />
          <ChartCard title="Royalties by month" note={<>USD at each month's exchange rate. <Legend items={SERIES_KEYS} /></>}>
            <StackedBars rows={r.months.map((m) => ({ label: shortMonth(m.month), parts: [m.ebook, m.print, m.kenp], faded: m.state !== 'final', tip: m.state === 'final' ? undefined : m.state === 'pending' ? 'Kindle+ not priced yet' : 'Kindle+ at an estimated rate' }))} series={SERIES_KEYS} label="Royalties by month" yLabel="USD" format={usd} />
          </ChartCard>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>By month</h2>
            <table>
              <thead><tr><th>Month</th><th className="num">Royalties</th><th className="num">Units</th><th className="num">Pages</th><th>Basis</th></tr></thead>
              <tbody>{[...months].reverse().map((m) => (
                <tr key={m.month}><td>{m.month}</td><td className="num">{usd(m.usd)}</td><td className="num">{int(m.units)}</td><td className="num">{int(m.pages)}</td><td className="muted">{BASIS[m.state]}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <Breakdowns r={r} />
        </>
      )}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Royalty split</h2>
        {split ? (
          <p>{split.shares.map((s) => `${s.name} ${s.pct}%`).join(' · ')} <span className="muted">from {split.fromMonth === '0000-00' ? 'the first month' : split.fromMonth}</span></p>
        ) : (
          <p className="muted">No split is set, so everything goes to the author KDP reports.</p>
        )}
        <button onClick={onSplits}>{split ? 'Change the split…' : 'Set a split…'}</button>
      </div>
    </>
  );
}
