import { useEffect, useState } from 'react';
import type { AnalysisReport } from '../../shared/api.js';
import { ChartCard, HBars, Legend, SERIES, StackedBars } from '../charts.js';
import { DataTable, type Column } from './DataTable.js';
import { currentMonth, int, money, monthName, pct, shiftMonth, shortMonth, usd, SOURCE_NAME } from './moneyUtil.js';

const api = window.cadrelMarket;

export const Tile = ({ n, l, sub }: { n: string; l: string; sub?: string }) => (
  <div className="tile"><div className="n">{n}</div><div className="l">{l}</div>{sub && <div className="l">{sub}</div>}</div>
);

export const SERIES_KEYS = [{ label: SOURCE_NAME.ebook, color: SERIES[0]! }, { label: SOURCE_NAME.print, color: SERIES[1]! }, { label: SOURCE_NAME.kenp, color: SERIES[2]! }];

/** What the three sources of money mean, and what "estimated" and "pending" are, shown wherever totals appear. */
export function MoneyNotes({ r }: { r: AnalysisReport }) {
  return (
    <>
      {r.totals.pending > 0 && <div className="banner">Kindle+ pages read this month are worth about <b>{usd(r.totals.pending)}</b>, but KDP has not priced them yet. They are left out of the totals and of what is owed until the month is over.</div>}
      {r.totals.estimated > 0 && <div className="banner"><b>{usd(r.totals.estimated)}</b> of these totals is Kindle+ money at an estimated rate. KDP fixes a month's rate around the 15th of the next month; import a fresh KDP report after that and it becomes exact.</div>}
      {r.missingRoyalty.length > 0 && <div className="banner">No royalty report has been imported for {r.missingRoyalty.map(shortMonth).join(', ')}. If you made sales then, import a KDP report that covers those months.</div>}
    </>
  );
}

export function BookTable({ r, previous }: { r: AnalysisReport; previous?: Record<string, number> }) {
  const columns: Column<AnalysisReport['books'][number]>[] = [
    { key: 'title', label: 'Book', get: (b) => b.title },
    { key: 'total', label: 'Total', num: true, get: (b) => b.usd, render: (b) => <>{usd(b.usd)}{b.estimated > 0 && <span className="muted" title="Includes Kindle+ money at an estimated rate"> *</span>}</> },
    { key: 'ebook', label: 'eBook', num: true, get: (b) => b.ebook, render: (b) => usd(b.ebook) },
    { key: 'print', label: 'Print', num: true, get: (b) => b.print, render: (b) => usd(b.print) },
    { key: 'ku', label: 'Kindle+', num: true, get: (b) => b.kenp, render: (b) => usd(b.kenp) },
    { key: 'units', label: 'Units', num: true, get: (b) => b.units, render: (b) => int(b.units) },
    { key: 'pages', label: 'Pages read', num: true, get: (b) => b.pages, render: (b) => int(b.pages) },
    { key: 'share', label: 'Share', num: true, get: (b) => Math.round(b.share * 1000) / 10, render: (b) => <><span className="minibar" style={{ width: Math.max(2, b.share * 80) }} /> {pct(b.share)}</> },
    ...(previous ? [{ key: 'delta', label: 'vs last month', num: true, get: (b: AnalysisReport['books'][number]) => Math.round((b.usd - (previous[b.asin] ?? 0)) * 100) / 100, render: (b: AnalysisReport['books'][number]) => { const d = b.usd - (previous[b.asin] ?? 0); return <span style={{ color: d < 0 ? 'var(--bad)' : d > 0 ? 'var(--good)' : undefined }}>{d > 0 ? '+' : ''}{usd(d)}</span>; } } satisfies Column<AnalysisReport['books'][number]>] : []),
  ];
  return <DataTable rows={r.books} columns={columns} rowKey={(b) => b.asin} noun="book" empty="No earnings in this period." />;
}

export function Breakdowns({ r }: { r: AnalysisReport }) {
  const slices = (s: AnalysisReport['marketplaces']) => s.filter((x) => x.usd > 0).slice(0, 12).map((x) => ({ label: x.key, value: x.usd, note: `${int(x.units)} units` }));
  const tbl = (s: AnalysisReport['marketplaces']) => ({ head: ['', 'USD', 'Units'], rows: s.map((x) => [x.key, usd(x.usd), int(x.units)]) });
  return (
    <div className="two">
      <ChartCard title="By marketplace" table={tbl(r.marketplaces)}><HBars rows={slices(r.marketplaces)} label="Royalties by marketplace" unit="$" format={usd} /></ChartCard>
      <ChartCard title="By royalty rate" note="35% and 70% are eBook rates (price band); 60% is print; Kindle+ is paid per page." table={tbl(r.royaltyTypes)}><HBars rows={slices(r.royaltyTypes)} label="Royalties by royalty rate" unit="$" format={usd} /></ChartCard>
      <ChartCard title="By kind of sale" note="Standard sales, Countdown Deals, free promotions, pre-orders." table={tbl(r.transactions)}><HBars rows={slices(r.transactions)} label="Royalties by kind of sale" unit="$" format={usd} /></ChartCard>
    </div>
  );
}

const SHORTCUTS = (now: string) => [
  { label: 'Last 6 months', from: shiftMonth(now, -5), to: now },
  { label: 'Last 12 months', from: shiftMonth(now, -11), to: now },
  { label: 'This year', from: `${now.slice(0, 4)}-01`, to: now },
  { label: 'Last year', from: `${+now.slice(0, 4) - 1}-01`, to: `${+now.slice(0, 4) - 1}-12` },
];

/** Charts and analysis over a span of months: what the books earned, from where, and how it moves. */
export function MoneyAnalysis({ version }: { version: number }) {
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [r, setR] = useState<AnalysisReport | null>(null);
  const [err, setErr] = useState('');
  const [none, setNone] = useState(false);

  useEffect(() => {
    void api.moneyMonths().then((m) => {
      if (!m.length) { setNone(true); return; }
      setNone(false);
      setRange((cur) => cur ?? { from: shiftMonth(m[0]! > currentMonth() ? currentMonth() : m[0]!, -11), to: m[0]! });
    }, (e) => setErr(String(e.message ?? e)));
  }, [version]);
  useEffect(() => {
    if (range && range.from <= range.to) void api.moneyAnalysis(range.from, range.to).then(setR, (e) => setErr(String(e.message ?? e)));
  }, [range, version]);

  if (none) return <p className="muted">Nothing to analyse yet. Import a KDP report from Books (the workbook from KDP Reports with the royalty sheets gives the money; the Orders and KENP Read sheets give units and pages).</p>;
  if (!range) return err ? <div className="err" role="alert">{err}</div> : null;
  const days = r?.daily ?? [];
  const showDays = range.from === range.to || (r && r.months.length <= 3);
  return (
    <>
      <div className="row">
        {SHORTCUTS(currentMonth()).map((s) => <button key={s.label} className="tab" aria-pressed={range.from === s.from && range.to === s.to} onClick={() => setRange({ from: s.from, to: s.to })}>{s.label}</button>)}
        <label>From <input type="month" value={range.from} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} /></label>
        <label>to <input type="month" value={range.to} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} /></label>
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      {range.from > range.to && <div className="err" role="alert">The first month is after the last.</div>}
      {r && (
        <>
          <MoneyNotes r={r} />
          <div className="tiles">
            <Tile n={usd(r.totals.usd)} l={`Royalties, ${monthName(r.from)}${r.from === r.to ? '' : ' to ' + monthName(r.to)}`} />
            <Tile n={usd(r.totals.ebook)} l="eBook royalties" />
            <Tile n={usd(r.totals.print)} l="Print royalties" />
            <Tile n={usd(r.totals.kenp)} l="Kindle+" sub={`${int(r.totals.pages)} pages read`} />
          </div>
          <div className="tiles">
            <Tile n={int(r.totals.units)} l="Units sold" />
            <Tile n={int(r.totals.freeUnits)} l="Free downloads" />
            <Tile n={r.totals.units ? usd(r.totals.ebook / r.totals.units) : '–'} l="eBook royalty per unit" />
            <Tile n={r.totals.pages ? usd((r.totals.kenp / r.totals.pages) * 1000) : '–'} l="Kindle+ per 1,000 pages" />
          </div>
          <ChartCard
            title="Royalties by month" note={<>USD at each month's exchange rate. <Legend items={SERIES_KEYS} /></>}
            table={{ head: ['Month', 'eBook', 'Print', 'Kindle+', 'Total', 'Units', 'Pages read'], rows: r.months.map((m) => [m.month + (m.state === 'pending' ? ' (KU pending)' : m.state === 'estimated' ? ' (KU estimated)' : ''), usd(m.ebook), usd(m.print), usd(m.kenp), usd(m.usd), int(m.units), int(m.pages)]) }}
          >
            <StackedBars rows={r.months.map((m) => ({ label: shortMonth(m.month), parts: [m.ebook, m.print, m.kenp], faded: m.state !== 'final', tip: m.state === 'final' ? undefined : m.state === 'pending' ? 'Kindle+ not priced yet' : 'Kindle+ at an estimated rate' }))} series={SERIES_KEYS} label="Royalties by month" yLabel="USD" format={usd} />
          </ChartCard>
          {showDays && days.length > 0 && (
            <div className="two">
              <ChartCard title="Units per day" table={{ head: ['Day', 'Paid', 'Free'], rows: days.filter((d) => d.units || d.free).map((d) => [d.day, d.units, d.free]) }}>
                <StackedBars rows={days.map((d) => ({ label: d.day.slice(5), parts: [d.units, d.free] }))} series={[{ label: 'Paid', color: SERIES[0]! }, { label: 'Free', color: SERIES[1]! }]} label="Units per day" yLabel="Units" />
              </ChartCard>
              <ChartCard title="Kindle+ pages read per day" table={{ head: ['Day', 'Pages'], rows: days.filter((d) => d.pages).map((d) => [d.day, d.pages]) }}>
                <StackedBars rows={days.map((d) => ({ label: d.day.slice(5), parts: [d.pages] }))} series={[{ label: 'Pages', color: SERIES[2]! }]} label="Pages read per day" yLabel="Pages" />
              </ChartCard>
            </div>
          )}
          <h2>Books</h2>
          <BookTable r={r} />
          <Breakdowns r={r} />
          <p className="muted">Money comes from the royalty sheets of the KDP download (exact, in each marketplace's currency); Kindle+ is pages read times KDP's rate for the month. Daily figures come from the Orders Placed and KENP Read sheets and may differ slightly from processed orders.</p>
        </>
      )}
    </>
  );
}

export { money };
