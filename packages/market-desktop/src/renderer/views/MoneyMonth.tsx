import { useEffect, useState } from 'react';
import type { MonthReport } from '../../shared/api.js';
import { ChartCard, SERIES, StackedBars } from '../charts.js';
import { BookTable, Breakdowns, MoneyNotes, Tile, SERIES_KEYS } from './MoneyAnalysis.js';
import { currentMonth, int, monthName, shiftMonth, usd } from './moneyUtil.js';

const api = window.cadrelMarket;

const delta = (now: number, was: number | undefined) => (was === undefined ? undefined : `${now - was >= 0 ? '+' : ''}${usd(now - was)} (${was ? `${now - was >= 0 ? '+' : ''}${Math.round(((now - was) / was) * 100)}%` : 'new'})`);

/** One month and everything in it: totals by source, every book, every day, marketplace and royalty rate, against the month before and a year earlier. */
export function MoneyMonth({ version }: { version: number }) {
  const [months, setMonths] = useState<string[] | null>(null);
  const [month, setMonth] = useState('');
  const [r, setR] = useState<MonthReport | null>(null);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState<Record<string, string>>({});

  useEffect(() => {
    void api.moneyMonths().then((m) => { setMonths(m); setMonth((cur) => cur || m.find((x) => x < currentMonth()) || m[0] || ''); }, (e) => setErr(String(e.message ?? e)));
  }, [version]);
  const load = () => { if (month) void api.moneyMonth(month).then((x) => { setR(x); setErr(''); }, (e) => setErr(String(e.message ?? e))); };
  useEffect(load, [month, version]);

  if (months && !months.length) return <p className="muted">Nothing to show yet. Import a KDP report from Books.</p>;
  if (!month) return err ? <div className="err" role="alert">{err}</div> : null;
  const oldest = months?.[months.length - 1] ?? month;
  const newest = months?.[0] ?? month;
  const daysIn = (() => { const [y, m] = month.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, m, 0)).getUTCDate(); })();
  const byDay = new Map((r?.daily ?? []).map((d) => [d.day, d]));
  const days = Array.from({ length: daysIn }, (_, i) => { const day = `${month}-${String(i + 1).padStart(2, '0')}`; return byDay.get(day) ?? { day, units: 0, free: 0, pages: 0 }; });
  const saveRate = async (currency: string) => {
    const v = (edit[currency] ?? '').trim();
    try { await api.setKenpRate(month, currency, v === '' ? null : Number(v)); setEdit((e) => { const { [currency]: _, ...rest } = e; return rest; }); load(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <>
      <div className="row">
        <button onClick={() => setMonth(shiftMonth(month, -1))} disabled={month <= oldest} aria-label="Previous month">‹</button>
        <select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
          {(months ?? [month]).map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
        </select>
        <button onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= newest} aria-label="Next month">›</button>
        {r && <span className="pill" title="KDP fixes the month's Kindle+ rate around the 15th of the next month">{month >= currentMonth() ? 'Kindle+ pending' : r.kenp.some((k) => k.state === 'estimated') ? 'Kindle+ estimated' : 'Final'}</span>}
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      {r && (
        <>
          <MoneyNotes r={r} />
          <div className="tiles">
            <Tile n={usd(r.totals.usd)} l={`Royalties, ${monthName(month)}`} sub={r.previous ? `${delta(r.totals.usd, r.previous.usd)} vs ${monthName(r.previous.month)}` : undefined} />
            <Tile n={usd(r.totals.ebook)} l="eBook royalties" />
            <Tile n={usd(r.totals.print)} l="Print royalties" />
            <Tile n={usd(r.totals.kenp)} l="Kindle+" sub={`${int(r.totals.pages)} pages read`} />
          </div>
          <div className="tiles">
            <Tile n={int(r.totals.units)} l="Units sold (eBook and print)" />
            <Tile n={int(r.totals.freeUnits)} l="Free downloads" />
            <Tile n={r.lastYear ? usd(r.lastYear.usd) : '–'} l={r.lastYear ? `${monthName(r.lastYear.month)}` : 'Same month last year'} sub={r.lastYear ? delta(r.totals.usd, r.lastYear.usd) : 'no data'} />
            <Tile n={String(r.books.filter((b) => b.usd > 0).length)} l="Books that earned" />
          </div>
          <h2>Books in {monthName(month)}</h2>
          <BookTable r={r} previous={r.previousByBook} />
          <div className="two">
            <ChartCard title="Units per day" table={{ head: ['Day', 'Paid', 'Free'], rows: days.filter((d) => d.units || d.free).map((d) => [d.day, d.units, d.free]) }}>
              <StackedBars rows={days.map((d) => ({ label: d.day.slice(8), parts: [d.units, d.free] }))} series={[{ label: 'Paid', color: SERIES[0]! }, { label: 'Free', color: SERIES[1]! }]} label="Units per day" yLabel="Units" />
            </ChartCard>
            <ChartCard title="Kindle+ pages read per day" table={{ head: ['Day', 'Pages'], rows: days.filter((d) => d.pages).map((d) => [d.day, d.pages]) }}>
              <StackedBars rows={days.map((d) => ({ label: d.day.slice(8), parts: [d.pages] }))} series={[{ label: 'Pages', color: SERIES[2]! }]} label="Pages read per day" yLabel="Pages" />
            </ChartCard>
          </div>
          <Breakdowns r={r} />
          {r.kenp.length > 0 && (
            <>
              <h2>Kindle+ rate</h2>
              <p className="muted">Pages read are paid per page at a rate KDP sets for the month. After KDP finalizes the month it is worked out from your report; until then the last final rate is used. You can enter a rate to override either.</p>
              <table>
                <thead><tr><th>Currency</th><th className="num">Pages read</th><th className="num">Rate per page</th><th>Status</th><th>Override</th></tr></thead>
                <tbody>
                  {r.kenp.map((k) => (
                    <tr key={k.currency}>
                      <td>{k.currency}</td><td className="num">{int(k.pages)}</td><td className="num">{k.rate.toFixed(5)}</td><td>{month >= currentMonth() ? 'Pending' : k.state === 'final' ? 'Final' : 'Estimated'}</td>
                      <td>
                        <input value={edit[k.currency] ?? ''} onChange={(e) => setEdit({ ...edit, [k.currency]: e.target.value })} placeholder="rate per page" aria-label={`Rate per page for ${k.currency}`} style={{ width: 110 }} />{' '}
                        <button onClick={() => void saveRate(k.currency)} disabled={edit[k.currency] === undefined}>{(edit[k.currency] ?? '').trim() === '' ? 'Use KDP rate' : 'Set'}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <p className="muted" style={{ marginTop: 8 }}>Legend: {SERIES_KEYS.map((s) => s.label).join(', ')}. Amounts in other currencies are shown in USD at the month's exchange rate (Royalties → Exchange rates).</p>
        </>
      )}
    </>
  );
}
