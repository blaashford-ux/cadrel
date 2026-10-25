import { useEffect, useState } from 'react';
import type { CalibrationPreview, ImportSummary, SalesStatus } from '../../shared/api.js';
import { KdpReportImport, describeImport } from './KdpReportImport.js';

const api = window.cadrelMarket;
const n = (v: number | null, d = 0) => (v === null ? '–' : v.toLocaleString('en-US', { maximumFractionDigits: d }));
const range = (r: { low: number; high: number } | null) => (r === null ? '–' : `${n(r.low, r.low < 10 ? 1 : 0)} – ${n(r.high, r.high < 10 ? 1 : 0)}`);
const lohi = (lo: number, hi: number) => range({ low: lo, high: hi });
const describe = (s: ImportSummary) => describeImport(s);

/**
 * Settings panel: fit the rank-to-sales curve to the author's own sales. Sales come from reports downloaded from KDP (paid orders
 * and, for Kindle Unlimited, pages read); ranks come from the book pages the author already captures (or an imported history).
 * Nothing has to be entered by hand except, for Kindle Unlimited, each book's page count.
 */
export function SalesCalibration({ onApplied }: { onApplied?: () => void }) {
  const [status, setStatus] = useState<SalesStatus | null>(null);
  const [prev, setPrev] = useState<CalibrationPreview | null>(null);
  const [includeKu, setIncludeKu] = useState<boolean | undefined>(undefined);
  const [share, setShare] = useState('100');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [asin, setAsin] = useState('');

  const load = async (ku: boolean | undefined = includeKu) => {
    const s = await api.salesStatus();
    setStatus(s);
    const p = s.days || s.kenpDays ? await api.calibrationPreview({ includeKu: ku }) : null;
    setPrev(p);
    if (p) setShare(String(Math.round(p.completion * 100)));
  };
  useEffect(() => { void load().catch((e) => setErr(String(e.message ?? e))); }, []);

  const run = async (fn: () => Promise<string | void>) => {
    setErr(''); setMsg('');
    try { const m = await fn(); if (m) setMsg(m); await load(); } catch (e) { setErr((e as Error).message); }
  };
  const bytesOf = async (f: File) => new Uint8Array(await f.arrayBuffer());

  const cur = prev?.current ?? null;
  const ku = prev?.includeKu ?? false;
  return (
    <div className="card">
      <h2>Sales estimates</h2>
      <p className="muted">
        {cur
          ? <>Calibrated to your own sales: {cur.n} readings across {cur.books} book{cur.books === 1 ? '' : 's'} (ranks {n(cur.rankMin)}–{n(cur.rankMax)}), counting {cur.includesKu ? 'paid sales plus estimated Kindle Unlimited borrows' : 'paid sales only'}. Estimates are shown as a range: your fit ×/÷ {n(cur.spread, 2)}, about where two thirds of your own readings fell.</>
          : <>No calibration yet. Estimates are shown as a range spanning three published rank-to-sales rules, which disagree by a factor of two or more. Import your own KDP reports to replace them with your fit.</>}
      </p>

      <ol className="muted" style={{ paddingLeft: 18 }}>
        <li>
          Download from KDP Reports (kdpreports.amazon.com) the <b>Orders</b> report and, if you are in Kindle Unlimited, the <b>KENP Read</b> report, with the dates set as wide as you like, and import them (a workbook holding both tabs works too; you can pick several files at once). This also creates your books under Library → My Books. Import newer ones now and then; overlapping days are replaced.
          <div className="row" style={{ marginTop: 6 }}>
            <KdpReportImport label="Import KDP reports…" onImported={() => void load()} />
          </div>
        </li>
        <li>
          Ranks need no typing: each time you capture one of your own book pages with the extension, that rank is paired with your sales over the previous three days. A rank history file works too (a Date and a Rank column).
          <div className="row" style={{ marginTop: 6 }}>
            <input value={asin} onChange={(e) => setAsin(e.target.value.toUpperCase())} placeholder="ASIN, if the file has none" aria-label="ASIN for the rank file" style={{ width: 170 }} />
            <label className="link" style={{ cursor: 'pointer' }}>
              Import rank history…
              <input type="file" accept=".xlsx,.csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void run(async () => describe(await api.importRanks(f.name, await bytesOf(f), asin || undefined))); }} />
            </label>
          </div>
        </li>
        <li>Check the fit below, then apply it.</li>
      </ol>

      {err && <div className="err" role="alert">{err}</div>}
      {msg && <div className="muted" role="status">{msg}</div>}

      {status && (status.days > 0 || status.kenpDays > 0) && (
        <div className="muted">
          Imported: {n(status.days)} days of paid sales{status.from ? ` (${status.from} to ${status.to})` : ''}{status.kenpDays > 0 ? `, ${n(status.kenpDays)} days of Kindle Unlimited pages read (${status.kenpFrom} to ${status.kenpTo})` : ''}. Rank readings that can be paired: {n(status.rankFromCaptures)} from your captures, {n(status.rankImported)} imported.
        </div>
      )}

      {prev && (
        <>
          {prev.kuAvailable && (
            <div className="card">
              <label>
                <input type="checkbox" checked={ku} onChange={(e) => { setIncludeKu(e.target.checked); void load(e.target.checked); }} />{' '}
                <b>Count Kindle Unlimited borrows as sales</b> (recommended if your books are in KU)
              </label>
              <div className="muted">
                KDP reports pages read, not borrows, so borrows are estimated as pages read ÷ the book’s page count in KENP ÷ the share of the book the average borrower reads. Older author reports say Amazon counts a borrow like a sale when ranking books; Amazon does not document this. With it on, the fit and every estimate that uses it mean <b>sales plus borrows per day</b>, which is what moves a book’s rank, not paid sales alone.
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <label>Share of a book the average borrower reads{' '}
                  <input type="number" min={10} max={100} step={5} value={share} onChange={(e) => setShare(e.target.value)} style={{ width: 70 }} aria-label="Share of a book read, percent" /> %
                </label>
                <button onClick={() => void run(async () => { await api.setKuCompletion(Number(share) / 100); })}>Update</button>
                <span className="muted">100% is the fewest borrows the pages could mean; many borrowers stop early, so the true number is higher. Lower it if you know your read-through.</span>
              </div>
              {prev.kuBooks.length > 0 && (
                <table>
                  <thead><tr><th>Book</th><th className="num">Pages read</th><th className="num">Page count (KENPC)</th><th className="num">Est. borrows</th></tr></thead>
                  <tbody>
                    {prev.kuBooks.map((b) => (
                      <tr key={b.asin}>
                        <td title={b.asin}>{b.title ?? b.asin}</td>
                        <td className="num">{n(b.pagesRead)}</td>
                        <td className="num">
                          <input
                            type="number" min={1} defaultValue={b.kenpc ?? ''} key={`${b.asin}-${b.kenpc}-${b.kenpcFrom}`} style={{ width: 80 }} aria-label={`KENPC for ${b.title ?? b.asin}`}
                            placeholder="pages"
                            onBlur={(e) => { const v = e.target.value.trim(); if (v !== String(b.kenpc ?? '')) void run(async () => { await api.setKenpc(b.asin, v ? Number(v) : null); }); }}
                          />
                          {b.kenpcFrom === 'print length' && <span className="muted" title="Taken from the print length on the page you captured. KENPC is usually different: enter the number shown in your KDP Bookshelf."> from print length</span>}
                        </td>
                        <td className="num">{n(b.borrows, 1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {prev.noKenpc.length > 0 && <div className="err">No page count for {prev.noKenpc.map((b) => b.title ?? b.asin).join(', ')}: their readings are left out until you enter one above.</div>}
            </div>
          )}
          {prev.paidAssumedZero && <div className="banner">No Orders report is imported, so paid sales are taken as zero. If these books also sell outside Kindle Unlimited, import the Orders report too.</div>}

          {prev.fit ? (
            <p>
              <b>Fit ({ku ? 'sales + borrows' : 'paid sales only'}):</b> per day ≈ {n(prev.fit.a)} × rank<sup>−{prev.fit.b.toFixed(2)}</sup> from {prev.fit.n} readings ({prev.fit.mode === 'fitted' ? 'slope and level fitted' : `level fitted, default slope ${prev.fit.b} kept because ${prev.fit.n < 4 ? 'there are fewer than 4 readings' : 'the ranks do not span enough of a range, or the fitted slope was implausible'}`}). Range ×/÷ {n(prev.fit.spread, 2)}.
              {prev.fit.n < 8 && <span className="muted"> A handful of readings gives a rough fit; more captures and a longer report will tighten it.</span>}
            </p>
          ) : (
            <p className="muted">{prev.reason}</p>
          )}
          <table>
            <thead>
              <tr><th>Rank</th><th className="num">Published methods</th><th className="num">Your fit, paid sales only</th>{prev.kuAvailable && <th className="num">Your fit, sales + borrows</th>}</tr>
            </thead>
            <tbody>
              {prev.comparison.map((c) => (
                <tr key={c.rank}>
                  <td>{n(c.rank)}</td>
                  <td className="num">{lohi(c.methodsLow, c.methodsHigh)}</td>
                  <td className="num">{c.paid ? `${range(c.paid)} (mid ${n(c.paid.mid, c.paid.mid < 10 ? 1 : 0)})` : '–'}</td>
                  {prev.kuAvailable && <td className="num">{c.ku ? `${range(c.ku)} (mid ${n(c.ku.mid, c.ku.mid < 10 ? 1 : 0)})` : '–'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted">Units per day at each rank. A book that sells mostly through Kindle Unlimited has a much higher “sales + borrows” figure than paid sales alone, which is why the two columns differ.</div>
          {(prev.noSales > 0 || prev.outsideRange > 0) && (
            <div className="muted">
              Not used: {prev.noSales} reading{prev.noSales === 1 ? '' : 's'} with {ku ? 'no paid sales or borrows' : 'no paid sales'} in the three days before, {prev.outsideRange} outside the days you imported.
            </div>
          )}
          {prev.points.length > 0 && (
            <details>
              <summary>The {prev.points.length} readings used</summary>
              <table>
                <thead><tr><th>Book</th><th>Day</th><th className="num">Rank</th><th className="num">Paid/day</th>{ku && <th className="num">Borrows/day</th>}<th>Rank from</th></tr></thead>
                <tbody>{prev.points.map((p, i) => <tr key={i}><td><code>{p.asin}</code></td><td>{p.day}</td><td className="num">{n(p.rank)}</td><td className="num">{n(p.paidPerDay, 2)}</td>{ku && <td className="num">{n(p.borrowsPerDay, 2)}</td>}<td>{p.source === 'capture' ? 'your capture' : 'imported'}</td></tr>)}</tbody>
              </table>
            </details>
          )}
          <p className="muted">
            {prev.kuAvailable ? 'Whether borrows count the same as sales for rank is not documented by Amazon, which is why both fits are shown. ' : 'Without a KENP Read report, only paid sales are counted: Kindle Unlimited borrows also move rank, so a book that lives in KU will make the fit run high. '}
            Rank is read at the moment of capture and sales are matched by UTC day, so single points are noisy.
          </p>
        </>
      )}

      <div className="row">
        <button className="primary" disabled={!prev?.fit} onClick={() => void run(async () => { await api.applyCalibration({ includeKu: prev?.kuAvailable ? ku : undefined }); onApplied?.(); return `Applied: estimates now use your fit (${ku ? 'sales + borrows' : 'paid sales only'}).`; })}>Apply this fit</button>
        <button disabled={!cur} onClick={() => void run(async () => { await api.resetCalibration(); onApplied?.(); return 'Back to the default curve and the published-methods range.'; })}>Reset to defaults</button>
        <button disabled={!status || (status.days === 0 && status.kenpDays === 0)} onClick={() => { if (window.confirm('Remove the imported sales and rank files? Your captured pages are not affected.')) void run(async () => { await api.clearSalesData(); return 'Imported sales data removed.'; }); }}>Remove imported data</button>
      </div>
    </div>
  );
}
