import { Fragment, useEffect, useState } from 'react';
import type { PaymentOwed, PaymentsReport } from './types.js';
import { KdpReportImport } from './KdpReportImport.js';
import { int, money, monthName, usd } from './moneyUtil.js';

const api = window.cadrelFinance;
const SRC = { sales: 'Sales (eBook and print)', kenp: 'Kindle+', ebook: 'eBook', print: 'Print' } as const;

/** What Amazon has paid, line by line, what does not reconcile with the royalty reports, and what has been earned but not paid yet. */
export function Payments({ version, onImported }: { version: number; onImported: () => void }) {
  const [r, setR] = useState<PaymentsReport | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const load = () => void api.payments().then((x) => { setR(x); setErr(''); }, (e) => setErr(String(e.message ?? e)));
  useEffect(load, [version]);

  const unpaidByCur = new Map<string, { amount: number; usd: number; from: string; to: string }>();
  for (const u of r?.unpaid ?? []) {
    if (u.state === 'pending') continue;
    const c = unpaidByCur.get(u.currency) ?? { amount: 0, usd: 0, from: u.month, to: u.month };
    c.amount += u.amount; c.usd += u.usd; c.from = c.from < u.month ? c.from : u.month; c.to = c.to > u.month ? c.to : u.month;
    unpaidByCur.set(u.currency, c);
  }
  const diffOf = (n: string, month: string, source: string, currency: string) => r?.differences.find((d) => d.paymentNumber === n && d.month === month && d.source === source && d.currency === currency);
  const unmatchedOf = (n: string, month: string, source: string, currency: string) => r?.unmatched.some((d) => d.paymentNumber === n && d.month === month && d.source === source && d.currency === currency);

  return (
    <>
      <p className="muted">
        Amazon pays one lump sum in USD, two months or more after the sales, once a balance passes its minimum, after withholding tax. Download the <b>Payments</b> report from KDP Reports (kdpreports.amazon.com) and import it here: each payment is matched to the royalty reports month by month, so statements can show what was actually paid, with its tax, and what is still to come. Importing a payment again (for example once your bank has the figures) replaces it.
      </p>
      <div className="row"><KdpReportImport onImported={() => { load(); onImported(); }} label="Import a KDP payment report…" /></div>
      {err && <div className="err" role="alert">{err}</div>}
      {r && r.payments.length === 0 && <p className="muted">No payments imported yet.</p>}
      {r && r.unmatched.length > 0 && <div className="banner">Payment lines with no royalty report for their month ({[...new Set(r.unmatched.map((u) => u.month))].join(', ')}): {usd(r.unmatched.reduce((a, u) => a + u.net, 0))} after tax cannot be credited to a book. Import the royalty report covering those months (Books tab).</div>}
      {r && r.differences.length > 0 && <div className="banner">Amazon paid {r.differences.length} line{r.differences.length === 1 ? '' : 's'} differently from the royalty report: it revised the month after paying it. See the lines marked below.</div>}
      {r && r.payments.length > 0 && (
        <table>
          <thead><tr><th>Payment</th><th>Paid on</th><th>Sales</th><th className="num">Accrued</th><th className="num">Tax withheld</th><th className="num">Net (USD)</th><th className="num">To your bank</th><th>Status</th><th>Authors</th><th /></tr></thead>
          <tbody>
            {r.payments.map((p) => (
              <Fragment key={p.number}>
                <tr>
                  <td><button className="link" onClick={() => setOpen(open === p.number ? null : p.number)} aria-expanded={open === p.number}>{p.number}</button></td>
                  <td>{p.paidOn}{p.scheduled && <span className="pill" style={{ marginLeft: 6 }} title="Dated after today: Amazon has scheduled it">scheduled</span>}</td>
                  <td>{p.periodFrom && p.periodTo ? `${p.periodFrom.slice(0, 7)} to ${p.periodTo.slice(0, 7)}` : ''}</td>
                  <td className="num">{money(p.accrued, p.currency)}</td><td className="num">{money(p.tax, p.currency)}</td><td className="num">{money(p.net, p.currency)}</td>
                  <td className="num">{p.payoutAmount != null ? `${money(p.payoutAmount, p.payoutCurrency ?? 'USD')}${p.fxRate ? ` at ${p.fxRate}` : ''}` : <span className="muted" title="The bank has not reported the conversion yet">pending</span>}</td>
                  <td>{p.status ?? ''}</td>
                  <td>{r.allocated[p.number] ? <span className="pill" title={`Allocated ${r.allocated[p.number]!.slice(0, 10)}`}>allocated</span> : <span className="muted">not allocated</span>}</td>
                  <td><button className="link" onClick={() => { if (window.confirm(`Forget payment ${p.number}? Statements will treat its sales as unpaid until you import it again.`)) void api.removePayment(p.number).then(() => { load(); onImported(); }, (e) => setErr(e.message)); }}>Remove</button></td>
                </tr>
                {open === p.number && (
                  <tr>
                    <td colSpan={10}>
                      <PaymentCalculator number={p.number} onChanged={load} />
                      <h3>Lines</h3>
                      <table>
                        <thead><tr><th>Sales month</th><th>Source</th><th className="num">Accrued</th><th className="num">Tax</th><th className="num">Net</th><th>Royalty report</th></tr></thead>
                        <tbody>
                          {p.lines.map((l, i) => {
                            const d = diffOf(p.number, l.month, l.source, l.currency);
                            return (
                              <tr key={i}>
                                <td>{monthName(l.month)}</td><td>{SRC[l.source]}</td>
                                <td className="num">{money(l.accrued, l.currency)}</td><td className="num">{money(l.tax, l.currency)}</td><td className="num">{money(l.net, l.currency)}</td>
                                <td>{unmatchedOf(p.number, l.month, l.source, l.currency) ? <span className="err">no royalty report for this month</span> : d ? <span className="err">report says {money(d.reported, d.currency)}</span> : 'matches'}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      {r && unpaidByCur.size > 0 && (
        <>
          <h2>Earned but not paid yet</h2>
          <p className="muted">Royalties for these sales are not in any imported payment. Amazon pays each balance once it passes its minimum, so small currencies can wait many months; the USD values use your exchange rates (or the app's defaults) and are estimates.</p>
          <table>
            <thead><tr><th>Currency</th><th>Sales months</th><th className="num">Amount</th><th className="num">About (USD)</th></tr></thead>
            <tbody>
              {[...unpaidByCur].sort((a, b) => b[1].usd - a[1].usd).map(([c, v]) => (
                <tr key={c}><td>{c}</td><td>{v.from === v.to ? monthName(v.from) : `${monthName(v.from)} to ${monthName(v.to)}`}</td><td className="num">{money(v.amount, c)}</td><td className="num">{usd(v.usd)}</td></tr>
              ))}
              <tr><th colSpan={3}>Total (estimate)</th><th className="num">{usd([...unpaidByCur.values()].reduce((a, v) => a + v.usd, 0))}</th></tr>
            </tbody>
          </table>
          <details className="table-view">
            <summary>By month and source</summary>
            <table>
              <thead><tr><th>Sales month</th><th>Source</th><th>Currency</th><th className="num">Amount</th><th className="num">About (USD)</th></tr></thead>
              <tbody>{r!.unpaid.filter((u) => u.state !== 'pending').map((u, i) => <tr key={i}><td>{u.month}</td><td>{SRC[u.source]}</td><td>{u.currency}</td><td className="num">{money(u.amount, u.currency)}</td><td className="num">{usd(u.usd)}</td></tr>)}</tbody>
            </table>
          </details>
          <div className="muted">{int(r!.unpaid.length)} lines.</div>
        </>
      )}
    </>
  );
}

/** What each collaborator is owed from one payment (after tax), allocation, and its CSV and PDF. */
function PaymentCalculator({ number, onChanged }: { number: string; onChanged: () => void }) {
  const [o, setO] = useState<PaymentOwed | null>(null);
  const [who, setWho] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const load = () => void api.paymentOwed(number).then((x) => { setO(x); setErr(''); }, (e) => setErr(String(e.message ?? e)));
  useEffect(load, [number]);
  const run = async (fn: () => Promise<unknown>) => { setErr(''); setMsg(''); try { await fn(); load(); onChanged(); } catch (e) { setErr((e as Error).message); } };
  const save = (kind: 'csv' | 'pdf') => run(async () => { const f = await api.exportPayment(number, kind, who || null); if (f) setMsg(`Saved ${f}`); });
  if (!o) return err ? <div className="err" role="alert">{err}</div> : null;
  const a = o.allocation;
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Owed to collaborators from this payment</h3>
      <p className="muted">Each line of the payment is split by the percentages for the month it was earned in, after the tax Amazon withheld. {usd(o.totalAccrued)} before {usd(o.totalTax)} tax = <b>{usd(o.totalOwed)}</b>, in USD.</p>
      {o.unmatchedNet > 0 && <div className="banner">{usd(o.unmatchedNet)} of this payment is for months with no royalty report imported, so no author can be credited with it yet.</div>}
      {o.payees.length === 0 ? <p className="muted">Nothing can be credited to anyone from this payment yet.</p> : (
        <table>
          <thead><tr><th>Author</th><th className="num">Before tax</th><th className="num">Tax withheld</th><th className="num">Owed</th><th>{a ? 'Allocated' : ''}</th></tr></thead>
          <tbody>
            {o.payees.map((p) => {
              const frozen = a?.payees.find((x) => x.name === p.name);
              return (
                <Fragment key={p.name}>
                  <tr>
                    <td><button className="link" onClick={() => setOpen(open === p.name ? null : p.name)} aria-expanded={open === p.name}>{p.name}</button></td>
                    <td className="num">{usd(p.accrued)}</td><td className="num">{usd(p.tax)}</td><td className="num"><b>{usd(p.owed)}</b></td>
                    <td className="muted">{frozen ? (Math.abs(frozen.owed - p.owed) > 0.005 ? <span className="err">frozen at {usd(frozen.owed)}</span> : usd(frozen.owed)) : ''}</td>
                  </tr>
                  {open === p.name && (
                    <tr><td colSpan={5}>
                      <table>
                        <thead><tr><th>Sales month</th><th>Book</th><th>Source</th><th className="num">Book royalty</th><th className="num">Share</th><th className="num">Owed</th></tr></thead>
                        <tbody>{p.lines.map((l, i) => <tr key={i}><td>{l.month}</td><td>{l.title}</td><td>{l.source === 'kenp' ? 'Kindle+' : l.source === 'print' ? 'Print' : 'eBook'}</td><td className="num">{usd(l.grossUsd)}</td><td className="num">{l.pct}%</td><td className="num">{usd(l.usd)}</td></tr>)}</tbody>
                      </table>
                    </td></tr>
                  )}
                </Fragment>
              );
            })}
            <tr><th>Total</th><th className="num">{usd(o.totalAccrued)}</th><th className="num">{usd(o.totalTax)}</th><th className="num">{usd(o.totalOwed)}</th><th /></tr>
          </tbody>
        </table>
      )}
      {a?.changed && <div className="banner">The splits (or the royalty reports) have changed since this payment was allocated on {a.at.slice(0, 10)}: the frozen amounts above are what the quarterly roll-up uses. Allocate again to take the new ones.</div>}
      <div className="row">
        <button className="primary" onClick={() => void run(() => api.allocatePayment(number))} disabled={o.payees.length === 0} title="Freeze these amounts so a later change of split does not rewrite them">{a ? 'Allocate again' : 'Allocate this payment'}</button>
        {a && <button onClick={() => void run(() => api.unallocatePayment(number))}>Remove allocation</button>}
        <span className="spacer" />
        <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Author"><option value="">All authors</option>{o.payees.map((p) => <option key={p.name}>{p.name}</option>)}</select>
        <button onClick={() => void save('csv')} disabled={o.payees.length === 0}>Save CSV</button>
        <button onClick={() => void save('pdf')} disabled={o.payees.length === 0} title={who ? undefined : 'Writes one PDF per author into a folder you choose'}>{who ? 'Save PDF' : 'Save a PDF for each author'}</button>
      </div>
      {a && <div className="muted">Allocated {a.at.slice(0, 10)}.</div>}
      {msg && <div className="muted" role="status">{msg}</div>}
      {err && <div className="err" role="alert">{err}</div>}
    </div>
  );
}
