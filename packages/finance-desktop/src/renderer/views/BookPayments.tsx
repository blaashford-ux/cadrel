import { Fragment, useEffect, useMemo, useState } from 'react';
import type { BookPayments as BookPaymentsData, PaymentOwed, Rollup } from './types.js';
import { PeriodPicker } from './Royalties.js';
import { monthName, periodRange, periodShortcuts, usd, type PeriodKind } from './moneyUtil.js';

const api = window.cadrelFinance;

/**
 * One book's side of the money Amazon has paid: each payment it is in with the book's part of it, the payment calculator limited to the book,
 * and a roll-up for a period. The whole payment is always shown beside the book's part, and the book's parts add up to it. Allocating
 * (freezing) is a whole-payment action and stays on the Payments tab; here the allocation is only shown.
 */
export function BookPayments({ asin, version, onPayments, onPayAuthors }: { asin: string; version: number; onPayments: () => void; onPayAuthors: () => void }) {
  const [d, setD] = useState<BookPaymentsData | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { void api.bookPayments(asin).then((x) => { setD(x); setErr(''); }, (e) => setErr(String(e.message ?? e))); }, [asin, version]);
  if (err) return <div className="err" role="alert">{err}</div>;
  if (!d) return null;
  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Payments</h2>
        {!d.reconciled ? (
          <p className="muted">No KDP payment report has been imported, so there is nothing to show as paid. Download the Payments report from KDP Reports and import it on the Reports tab.</p>
        ) : d.payments.length === 0 ? (
          <p className="muted">None of the payments you have imported includes this book.</p>
        ) : (
          <>
            <p className="muted">Each payment is Amazon’s lump sum for many books. This is this book’s part of it, after the tax Amazon withheld; the book’s parts add up to the payment. Allocation (freezing the amounts) is for the whole payment: do it on the <button className="link" onClick={onPayments}>Payments tab</button>.</p>
            <table>
              <thead><tr><th>Payment</th><th>Paid on</th><th className="num">Whole payment</th><th className="num">Before tax</th><th className="num">Tax</th><th className="num">This book</th><th>Allocation</th></tr></thead>
              <tbody>
                {d.payments.map((p) => (
                  <Fragment key={p.number}>
                    <tr>
                      <td><button className="link" onClick={() => setOpen(open === p.number ? null : p.number)} aria-expanded={open === p.number}>{p.number}</button></td>
                      <td>{p.paidOn}{p.scheduled ? <span className="muted"> scheduled</span> : null}</td>
                      <td className="num">{usd(p.paymentNet)}</td><td className="num">{usd(p.accrued)}</td><td className="num">{usd(p.tax)}</td><td className="num"><b>{usd(p.net)}</b></td>
                      <td className="muted">{p.allocated ? (p.changed ? 'allocated; split changed since' : 'allocated') : 'not allocated'}</td>
                    </tr>
                    {open === p.number && <tr><td colSpan={7}><Calculator number={p.number} asin={asin} /></td></tr>}
                  </Fragment>
                ))}
                <tr><th colSpan={3}>Total of this book’s parts</th><th className="num">{usd(d.totals.accrued)}</th><th className="num">{usd(d.totals.tax)}</th><th className="num">{usd(d.totals.net)}</th><th /></tr>
              </tbody>
            </table>
            {d.awaitingUsd > 0 && <p className="muted">A further {usd(d.awaitingUsd)} is earned by this book but not in any payment yet (an estimate where Kindle+ is not final).</p>}
          </>
        )}
      </div>
      {d.reconciled && <Rollup asin={asin} version={version} onPayAuthors={onPayAuthors} />}
    </>
  );
}

/** The payment calculator for one payment, limited to this book. */
function Calculator({ number, asin }: { number: string; asin: string }) {
  const [o, setO] = useState<PaymentOwed | null>(null);
  const [who, setWho] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { void api.paymentOwed(number, asin).then((x) => { setO(x); setErr(''); }, (e) => setErr(String(e.message ?? e))); }, [number, asin]);
  const save = async (kind: 'csv' | 'pdf') => { setErr(''); setMsg(''); try { const f = await api.exportPayment(number, kind, who || null, asin); if (f) setMsg(`Saved ${f}`); } catch (e) { setErr((e as Error).message); } };
  if (!o) return err ? <div className="err" role="alert">{err}</div> : null;
  return (
    <div>
      <p className="muted">Payment {number}: {usd(o.payment.accrued)} before {usd(o.payment.tax)} tax = {usd(o.payment.net)} in all. This book’s part: {usd(o.totalAccrued)} before {usd(o.totalTax)} tax = <b>{usd(o.totalOwed)}</b>.</p>
      {o.payees.length === 0 ? <p className="muted">Nothing can be credited to anyone from this book in this payment.</p> : (
        <table>
          <thead><tr><th>Author</th><th className="num">Before tax</th><th className="num">Tax withheld</th><th className="num">Owed</th><th>{o.allocation ? 'Frozen at' : ''}</th></tr></thead>
          <tbody>
            {o.payees.map((p) => {
              const frozen = o.allocation?.payees.find((x) => x.name === p.name);
              return (
                <Fragment key={p.name}>
                  <tr>
                    <td><button className="link" onClick={() => setOpen(open === p.name ? null : p.name)} aria-expanded={open === p.name}>{p.name}</button></td>
                    <td className="num">{usd(p.accrued)}</td><td className="num">{usd(p.tax)}</td><td className="num"><b>{usd(p.owed)}</b></td>
                    <td className="muted">{frozen ? (Math.abs(frozen.owed - p.owed) > 0.005 ? <span className="err">{usd(frozen.owed)}</span> : usd(frozen.owed)) : ''}</td>
                  </tr>
                  {open === p.name && (
                    <tr><td colSpan={5}>
                      <table>
                        <thead><tr><th>Sales month</th><th>Source</th><th className="num">Book royalty</th><th className="num">Share</th><th className="num">Owed</th></tr></thead>
                        <tbody>{p.lines.map((l, i) => <tr key={i}><td>{l.month}</td><td>{l.source === 'kenp' ? 'Kindle+' : l.source === 'print' ? 'Print' : 'eBook'}</td><td className="num">{usd(l.grossUsd)}</td><td className="num">{l.pct}%</td><td className="num">{usd(l.usd)}</td></tr>)}</tbody>
                      </table>
                    </td></tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      {o.allocation?.changed && <div className="banner">The splits have changed since this payment was allocated on {o.allocation.at.slice(0, 10)}; the frozen amounts are what the roll-up uses. Allocate again on the Payments tab to take the new ones.</div>}
      <div className="row">
        <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Author"><option value="">All authors</option>{o.payees.map((p) => <option key={p.name}>{p.name}</option>)}</select>
        <button onClick={() => void save('csv')} disabled={o.payees.length === 0}>Save CSV</button>
        <button onClick={() => void save('pdf')} disabled={o.payees.length === 0} title={who ? undefined : 'Writes one PDF per author into a folder you choose'}>{who ? 'Save PDF' : 'Save a PDF for each author'}</button>
      </div>
      {msg && <div className="muted" role="status">{msg}</div>}
      {err && <div className="err" role="alert">{err}</div>}
    </div>
  );
}

/** What this book’s payments in a period owe each author. Payouts, carried-in balances and what is due are per author across all their books, so they are not here. */
function Rollup({ asin, version, onPayAuthors }: { asin: string; version: number; onPayAuthors: () => void }) {
  const [kind, setKind] = useState<PeriodKind>('quarter');
  const [value, setValue] = useState(periodShortcuts()[2]!.value);
  const [r, setR] = useState<Rollup | null>(null);
  const [who, setWho] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const range = useMemo(() => periodRange(kind, value), [kind, value]);
  useEffect(() => { if (range) void api.payoutRollup(range.from, range.to, asin).then((x) => { setR(x); setErr(''); }, (e) => setErr(String(e.message ?? e))); }, [range?.from, range?.to, asin, version]);
  const label = range ? (range.from === range.to ? monthName(range.from) : `${monthName(range.from)} to ${monthName(range.to)}`) : '';
  const save = async (k: 'csv' | 'pdf') => { if (!range) return; setErr(''); setMsg(''); try { const f = await api.exportRollup(range.from, range.to, k, who || null, asin); if (f) setMsg(`Saved ${f}`); } catch (e) { setErr((e as Error).message); } };
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Payments by period</h2>
      <p className="muted">What the payments Amazon made for this book in a period owe each author. What to pay each author (with what is carried in and what you have already paid out) is worked out across all their books on <button className="link" onClick={onPayAuthors}>Pay authors</button>.</p>
      <PeriodPicker kind={kind} value={value} setKind={setKind} setValue={setValue} />
      {err && <div className="err" role="alert">{err}</div>}
      {!range && <div className="err" role="alert">That period is not valid.</div>}
      {r && (r.payments.length === 0 ? <p className="muted">Amazon paid nothing for this book in {label}.</p> : (
        <>
          <table>
            <thead><tr><th>Author</th><th className="num">Before tax</th><th className="num">Tax withheld</th><th className="num">Owed from this book</th></tr></thead>
            <tbody>
              {r.payees.map((p) => <tr key={p.name}><td>{p.name}</td><td className="num">{usd(p.accrued)}</td><td className="num">{usd(p.tax)}</td><td className="num"><b>{usd(p.owed)}</b></td></tr>)}
              <tr><th>Total</th><th className="num">{usd(r.totals.accrued)}</th><th className="num">{usd(r.totals.tax)}</th><th className="num">{usd(r.totals.owed)}</th></tr>
            </tbody>
          </table>
          <p className="muted">From payment{r.payments.length === 1 ? '' : 's'} {r.payments.map((p) => `${p.number} (${p.paidOn})`).join(', ')}.{r.unallocated.length > 0 ? ' Not all are allocated, so some amounts are worked out from the current splits.' : ''}</p>
          <div className="row">
            <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Author"><option value="">All authors</option>{r.payees.map((p) => <option key={p.name}>{p.name}</option>)}</select>
            <button onClick={() => void save('csv')}>Save CSV</button>
            <button onClick={() => void save('pdf')} title={who ? undefined : 'Writes one statement per author into a folder you choose'}>{who ? 'Save statement (PDF)' : 'Save a statement for each author'}</button>
          </div>
          {msg && <div className="muted" role="status">{msg}</div>}
        </>
      ))}
    </div>
  );
}
