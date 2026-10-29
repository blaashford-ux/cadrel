import { Fragment, useEffect, useMemo, useState } from 'react';
import type { Rollup } from './types.js';
import { PeriodPicker } from './Royalties.js';
import { int, monthName, periodRange, periodShortcuts, usd, type PeriodKind } from './moneyUtil.js';

const api = window.cadrelFinance;
const today = () => new Date().toISOString().slice(0, 10);

/** What to pay each author for a period (usually the last quarter): what Amazon paid in it, split, plus anything unpaid from before, less what you have already paid out. */
export function Payouts({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [kind, setKind] = useState<PeriodKind>('quarter');
  const [value, setValue] = useState(periodShortcuts()[2]!.value);
  const [r, setR] = useState<Rollup | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState<{ paidOn: string; usd: string; note: string }>({ paidOn: today(), usd: '', note: '' });
  const [who, setWho] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const range = useMemo(() => periodRange(kind, value), [kind, value]);
  const load = () => { if (range) void api.payoutRollup(range.from, range.to).then((x) => { setR(x); setErr(''); }, (e) => setErr(String(e.message ?? e))); };
  useEffect(load, [range?.from, range?.to, version]);
  const run = async (fn: () => Promise<unknown>) => { setErr(''); setMsg(''); try { await fn(); load(); onChanged(); } catch (e) { setErr((e as Error).message); } };
  const label = range ? (range.from === range.to ? monthName(range.from) : `${monthName(range.from)} to ${monthName(range.to)}`) : '';
  const save = (k: 'csv' | 'pdf') => run(async () => { if (!range) return; const f = await api.exportRollup(range.from, range.to, k, who || null); if (f) setMsg(`Saved ${f}`); });

  return (
    <>
      <p className="muted">
        What to pay each author for a period, from what Amazon has actually paid you: the payments dated in the period, split by the splits of the months they cover (after tax), plus anything still unpaid from earlier periods, less what you have already paid out for the period. Allocate each payment first so a later change of split cannot alter it.
      </p>
      <PeriodPicker kind={kind} value={value} setKind={setKind} setValue={setValue} />
      {err && <div className="err" role="alert">{err}</div>}
      {!range && <div className="err" role="alert">That period is not valid.</div>}
      {r && (
        <>
          {r.payments.length === 0 && r.scheduled.length === 0 && <p className="muted">Amazon paid nothing in {label}.</p>}
          {r.scheduled.length > 0 && <div className="banner">Not counted yet: {r.scheduled.map((p) => `payment ${p.number} is scheduled for ${p.paidOn} (${usd(p.net)} after tax)`).join('; ')}. It has not been received.</div>}
          {r.unallocated.length > 0 && (
            <div className="banner">
              {r.unallocated.length === 1 ? 'One payment has' : `${r.unallocated.length} payments have`} not been allocated, so {r.unallocated.length === 1 ? 'its amounts are' : 'their amounts are'} worked out from the current splits and can still change.{' '}
              <button onClick={() => void run(async () => { const done = await api.allocateRollup(range!.from, range!.to); setMsg(`Allocated ${done.length} payment${done.length === 1 ? '' : 's'}.`); })}>Allocate {r.unallocated.length === 1 ? 'it' : 'them all'}</button>
            </div>
          )}
          {r.changed.length > 0 && <div className="banner">A split has changed since {r.changed.length === 1 ? `payment ${r.changed[0]} was` : 'payments ' + r.changed.join(', ') + ' were'} allocated. The roll-up uses the frozen amounts; open the payment on the Payments tab and allocate it again to take the new split.</div>}
          {r.unmatchedNet > 0 && <div className="banner">{usd(r.unmatchedNet)} of these payments is for months with no royalty report imported, so no author is credited with it. Import the royalty report covering those months.</div>}
          {r.payees.length > 0 && (
            <>
              <div className="row">
                <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Author"><option value="">All authors</option>{r.payees.map((p) => <option key={p.name}>{p.name}</option>)}</select>
                <button onClick={() => void save('csv')}>Save CSV</button>
                <button onClick={() => void save('pdf')} title={who ? undefined : 'Writes one payout statement per author into a folder you choose'}>{who ? 'Save payout statement (PDF)' : 'Save a payout statement for each author'}</button>
              </div>
              {msg && <div className="muted" role="status">{msg}</div>}
              <table>
                <thead><tr><th>Author</th><th className="num">Unpaid from before</th><th className="num" title={`Owed from the payments Amazon made in ${label}`}>Owed from payments</th><th className="num">Before tax</th><th className="num">Tax withheld</th><th className="num">Paid out</th><th className="num">Due now</th><th /></tr></thead>
                <tbody>
                  {r.payees.map((p) => (
                    <Fragment key={p.name}>
                      <tr>
                        <td><button className="link" onClick={() => { setOpen(open === p.name ? null : p.name); setForm({ paidOn: today(), usd: p.due > 0 ? p.due.toFixed(2) : '', note: '' }); }} aria-expanded={open === p.name}>{p.name}</button></td>
                        <td className="num">{usd(p.carriedIn)}</td><td className="num">{usd(p.owed)}</td><td className="num">{usd(p.accrued)}</td><td className="num">{usd(p.tax)}</td>
                        <td className="num">{p.paidOut ? usd(p.paidOut) : ''}</td><td className="num"><b>{usd(p.due)}</b></td>
                        <td><button onClick={() => { setOpen(p.name); setForm({ paidOn: today(), usd: p.due > 0 ? p.due.toFixed(2) : '', note: '' }); }}>Record a payout</button></td>
                      </tr>
                      {open === p.name && (
                        <tr><td colSpan={8}>
                          <div className="card">
                            <b>{p.name}</b>
                            <table>
                              <thead><tr><th>Payment</th><th>Paid on</th><th className="num">Before tax</th><th className="num">Tax</th><th className="num">Owed</th><th>Allocation</th></tr></thead>
                              <tbody>{p.payments.map((x) => <tr key={x.number}><td>{x.number}</td><td>{x.paidOn}</td><td className="num">{usd(x.accrued)}</td><td className="num">{usd(x.tax)}</td><td className="num">{usd(x.owed)}</td><td>{x.allocated ? (x.changed ? <span className="err">frozen (split changed since)</span> : 'allocated') : <span className="muted">not allocated</span>}</td></tr>)}</tbody>
                            </table>
                            {p.payouts.length > 0 && (
                              <table>
                                <thead><tr><th>Paid out on</th><th>Note</th><th className="num">Amount</th><th /></tr></thead>
                                <tbody>{p.payouts.map((o) => <tr key={o.id}><td>{o.paidOn}</td><td>{o.note ?? ''}</td><td className="num">{usd(o.usd)}</td><td><button className="link" onClick={() => { if (window.confirm('Delete this payout from the record?')) void run(() => api.deletePayout(o.id)); }}>Delete</button></td></tr>)}</tbody>
                              </table>
                            )}
                            <div className="row">
                              <span>Record a payout to {p.name} for {label}:</span>
                              <input type="date" value={form.paidOn} onChange={(e) => setForm({ ...form, paidOn: e.target.value })} aria-label="Date paid" />
                              <input value={form.usd} onChange={(e) => setForm({ ...form, usd: e.target.value })} placeholder="USD" aria-label="Amount paid in USD" style={{ width: 100 }} />
                              <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Note (optional)" aria-label="Note" style={{ width: 200 }} />
                              <button className="primary" disabled={!(Number(form.usd) > 0) || !form.paidOn} onClick={() => void run(async () => { await api.recordPayout({ payee: p.name, paidOn: form.paidOn, usd: Number(form.usd), period: range!.from, note: form.note }); setMsg(`Recorded ${usd(Number(form.usd))} paid to ${p.name}.`); })}>Record payout</button>
                            </div>
                          </div>
                        </td></tr>
                      )}
                    </Fragment>
                  ))}
                  <tr><th>Total</th><th className="num">{usd(r.totals.carriedIn)}</th><th className="num">{usd(r.totals.owed)}</th><th className="num">{usd(r.totals.accrued)}</th><th className="num">{usd(r.totals.tax)}</th><th className="num">{r.totals.paidOut ? usd(r.totals.paidOut) : ''}</th><th className="num">{usd(r.totals.due)}</th><th /></tr>
                </tbody>
              </table>
              <p className="muted">Due now = unpaid from before + owed from this period's payments − paid out for this period. Amounts are USD as Amazon paid them, after the tax it withheld; a payout you record counts against the period it is recorded under ({label}).</p>
            </>
          )}
          {r.payments.length > 0 && (
            <>
              <h2>Amazon payments in {label}</h2>
              <table>
                <thead><tr><th>Payment</th><th>Paid on</th><th className="num">Accrued</th><th className="num">Tax</th><th className="num">Net</th><th>Allocation</th></tr></thead>
                <tbody>{r.payments.map((p) => <tr key={p.number}><td>{p.number}</td><td>{p.paidOn}</td><td className="num">{usd(p.accrued)}</td><td className="num">{usd(p.tax)}</td><td className="num">{usd(p.net)}</td><td>{p.allocated ? (p.changed ? <span className="err">frozen (split changed since)</span> : 'allocated') : <span className="muted">not allocated</span>}</td></tr>)}</tbody>
              </table>
              <div className="muted">{int(r.payments.length)} payment{r.payments.length === 1 ? '' : 's'}.</div>
            </>
          )}
        </>
      )}
    </>
  );
}
