import { useEffect, useMemo, useState } from 'react';
import type { DetectedAuthor, OwnBookRow, Person, SplitVersion, Statement, StatementBasis } from './types.js';
import { currentMonth, int, money, monthName, periodRange, periodShortcuts, quarterOf, SOURCE_NAME, usd, type PeriodKind } from './moneyUtil.js';

const api = window.cadrelFinance;
const ALL_MONTHS = '0000-00';

// ---------------------------------------------------------------- people

function People({ people, reload }: { people: Person[]; reload: () => void }) {
  const [name, setName] = useState('');
  const [pens, setPens] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const save = async () => {
    setErr('');
    try {
      await api.savePerson({ ...(editing ? { id: editing } : {}), name, penNames: pens.split(',').map((x) => x.trim()).filter(Boolean) });
      setName(''); setPens(''); setEditing(null); reload();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>People who are paid</h2>
      <p className="muted">People appear here on their own when you pick an author in a book's split below (authors are found from your KDP reports), so you do not need to add anyone first. Add a person here when one real person writes under several pen names: list the pen names and every book under any of them is paid to that person. A book with no split is paid wholly to the author KDP reports it under.</p>
      {people.length > 0 && (
        <table>
          <thead><tr><th>Name</th><th>Writes as</th><th /></tr></thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td><td>{p.penNames.join(', ')}</td>
                <td>
                  <button className="link" onClick={() => { setEditing(p.id); setName(p.name); setPens(p.penNames.join(', ')); }}>Edit</button>{' '}
                  <button className="link" onClick={() => { if (window.confirm(`Remove ${p.name}?`)) void api.deletePerson(p.id).then(reload, (e) => setErr(e.message)); }}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Person's name" />
        <input value={pens} onChange={(e) => setPens(e.target.value)} placeholder="Pen names, comma separated (optional)" aria-label="Pen names" style={{ width: 280 }} />
        <button className="primary" disabled={!name.trim()} onClick={() => void save()}>{editing ? 'Save' : 'Add person'}</button>
        {editing && <button onClick={() => { setEditing(null); setName(''); setPens(''); }}>Cancel</button>}
      </div>
      {err && <div className="err" role="alert">{err}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- splits

const describe = (v: SplitVersion | undefined) => (v ? v.shares.map((s) => `${s.name} ${s.pct}%`).join(', ') : '');

type Row = { who: string; name: string; pct: string };

/** Equal shares to the cent that add up to 100 exactly. */
const equalShares = (n: number) => { const each = Math.floor(10000 / n) / 100; return Array.from({ length: n }, (_, i) => String(i === 0 ? Math.round((100 - each * (n - 1)) * 100) / 100 : each)); };

function SplitEditor({ book, people, detected, history, onDone, onCapture }: { book: OwnBookRow; onCapture: () => void; people: Person[]; detected: DetectedAuthor[]; history: SplitVersion[]; onDone: () => void }) {
  const last = history[history.length - 1];
  // the authors found on this book come first, then the people already added, then names found on other books
  const onBook = detected.filter((d) => d.asins.includes(book.asin));
  const optionOf = (d: DetectedAuthor) => (d.personId ? `p:${d.personId}` : `n:${d.name}`);
  const labelOf = (d: DetectedAuthor) => (d.personId ? people.find((p) => p.id === d.personId)?.name ?? d.name : d.name);
  const first = onBook.length ? onBook : [];
  const shares = equalShares(Math.max(first.length, 1));
  const [rows, setRows] = useState<Row[]>(
    last ? last.shares.map((s) => ({ who: `p:${s.personId}`, name: '', pct: String(s.pct) })) : first.length ? first.map((d, i) => ({ who: optionOf(d), name: '', pct: shares[i]! })) : [{ who: '', name: '', pct: '100' }],
  );
  const [ask, setAsk] = useState(false);
  const [from, setFrom] = useState(currentMonth());
  const [err, setErr] = useState('');
  const total = rows.reduce((a, r) => a + (Number(r.pct) || 0), 0);
  const key = (r: Row) => (r.who === 'new' ? `n:${r.name.trim().toLowerCase()}` : r.who);
  const filled = (r: Row) => (r.who === 'new' ? r.name.trim() !== '' : r.who !== '');
  const ok = rows.length > 0 && rows.every((r) => filled(r) && Number(r.pct) > 0) && Math.abs(total - 100) < 0.001 && new Set(rows.map(key)).size === rows.length;
  const equal = () => { const e = equalShares(rows.length); setRows(rows.map((x, i) => ({ ...x, pct: e[i]! }))); };
  const patch = (i: number, p: Partial<Row>) => setRows(rows.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const save = async (fromMonth: string | undefined) => {
    setErr('');
    try {
      await api.setBookSplit(book.asin, rows.map((r) => (r.who.startsWith('p:') ? { personId: Number(r.who.slice(2)), pct: Number(r.pct) } : { name: r.who === 'new' ? r.name.trim() : r.who.slice(2), pct: Number(r.pct) })), fromMonth);
      onDone();
    } catch (e) { setErr((e as Error).message); }
  };
  const onIds = new Set(onBook.map(optionOf));
  const others = detected.filter((d) => !onIds.has(optionOf(d)) && !d.personId);
  const peopleNotOnBook = people.filter((p) => !onIds.has(`p:${p.id}`));
  return (
    <div className="card" style={{ marginTop: 6 }}>
      <b>{book.title ?? book.asin}</b>
      {history.length > 1 && <div className="muted">Earlier versions: {history.slice(0, -1).map((v) => `${v.fromMonth === ALL_MONTHS ? 'from the start' : 'from ' + v.fromMonth}: ${describe(v)}`).join(' · ')}</div>}
      <div className="row">
        <button onClick={onCapture} title="Open this book on Amazon, then send the page with the extension to bring in every credited author">{book.snapshots ? 'Capture the page again' : 'Open on Amazon to capture the authors'}</button>
        <span className="muted">{book.snapshots ? `Page captured ${book.lastCaptured?.slice(0, 10)}.` : 'Not captured yet, so only the author in the KDP report is known.'}</span>
      </div>
      {!last && onBook.length > 1 && <div className="muted">Authors found for this book are filled in with equal shares: adjust the percentages.</div>}
      {rows.map((r, i) => (
        <div className="row" key={i}>
          <select value={r.who} onChange={(e) => patch(i, { who: e.target.value })} aria-label="Author">
            <option value="">Choose an author…</option>
            {onBook.length > 0 && <optgroup label="On this book">{onBook.map((d) => <option key={optionOf(d)} value={optionOf(d)}>{labelOf(d)}</option>)}</optgroup>}
            {peopleNotOnBook.length > 0 && <optgroup label="People you added">{peopleNotOnBook.map((p) => <option key={p.id} value={`p:${p.id}`}>{p.name}</option>)}</optgroup>}
            {others.length > 0 && <optgroup label="Other names in your reports">{others.map((d) => <option key={d.name} value={`n:${d.name}`}>{d.name}</option>)}</optgroup>}
            <option value="new">Someone else (type a name)…</option>
          </select>
          {r.who === 'new' && <input value={r.name} onChange={(e) => patch(i, { name: e.target.value })} placeholder="Name" aria-label="Author's name" />}
          <input value={r.pct} onChange={(e) => patch(i, { pct: e.target.value })} style={{ width: 70 }} aria-label="Share in percent" /> %
          <button className="link" onClick={() => setRows(rows.filter((_, j) => j !== i))} disabled={rows.length === 1}>Remove</button>
        </div>
      ))}
      <div className="row">
        <button onClick={() => setRows([...rows, { who: '', name: '', pct: '0' }])}>Add author</button>
        <button onClick={equal} disabled={rows.length < 2}>Split equally</button>
        <span className={ok ? 'muted' : 'err'}>{total.toFixed(2).replace(/\.00$/, '')}% of 100%</span>
      </div>
      {ask ? (
        <div className="row">
          <span>This book already has a split. Apply the new one from</span>
          <input type="month" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Apply from month" />
          <button className="primary" disabled={!from} onClick={() => void save(from)}>Apply from {from ? monthName(from) : '…'}</button>
          <button onClick={() => void save(ALL_MONTHS)}>Apply to all months</button>
          <button onClick={() => setAsk(false)}>Back</button>
        </div>
      ) : (
        <div className="row">
          <button className="primary" disabled={!ok} onClick={() => (history.length ? setAsk(true) : void save(undefined))}>Save split</button>
          <button onClick={onDone}>Cancel</button>
          {history.length > 0 && <button className="link" onClick={() => { if (window.confirm('Remove this book\'s split? Every month goes back to the author KDP reports it under.')) void api.setBookSplit(book.asin, []).then(onDone, (e) => setErr(e.message)); }}>Remove split</button>}
        </div>
      )}
      {err && <div className="err" role="alert">{err}</div>}
    </div>
  );
}

function Splits({ people, version, reload }: { people: Person[]; version: number; reload: () => void }) {
  const [books, setBooks] = useState<OwnBookRow[]>([]);
  const [splits, setSplits] = useState<Record<string, SplitVersion[]>>({});
  const [detected, setDetected] = useState<DetectedAuthor[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const capture = async (b: OwnBookRow) => {
    setErr(''); setMsg('');
    try { await api.openBook(b.asin); setMsg(`Opened “${b.title ?? b.asin}” on Amazon. Right-click the page → Send to Cadrel Market; its credited authors appear here once it arrives.`); } catch (e) { setErr((e as Error).message); }
  };
  const load = () => { void api.ownBooks().then(setBooks); void api.allSplits().then(setSplits); void api.detectedAuthors().then(setDetected); };
  useEffect(load, [version]);
  const authorsOf = (b: OwnBookRow) => detected.filter((d) => d.asins.includes(b.asin)).map((d) => d.name);
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Royalty split per book</h2>
      <p className="muted">A book's split covers everything it earns: eBook and print royalties and Kindle+. The authors on each book are found from your KDP reports and captured pages, so there is nothing to set up first; you can also type a name. A KDP report names only one author of a collaboration: press Open to capture, send the book's Amazon page with the extension, and every author credited on it is added. Changing a split asks from which month it applies; earlier months keep the split they had.</p>
      <table>
        <thead><tr><th>Book</th><th>Authors found</th><th>Split now</th><th /><th /></tr></thead>
        <tbody>
          {books.filter((b) => b.paidUnits > 0 || b.kenpPages > 0 || splits[b.asin]).map((b) => {
            const names = authorsOf(b);
            return (
              <tr key={b.asin}>
                <td>{b.title ?? b.asin}</td>
                <td>{names.join(', ')}</td>
                <td>{describe(splits[b.asin]?.[splits[b.asin]!.length - 1]) || <span className="muted">{names.length > 1 ? `Collaboration with no split: all of it goes to “${names.join(' & ')}”` : '100% to the reported author'}</span>}</td>
                <td style={{ whiteSpace: 'nowrap' }}><button className="link" onClick={() => setOpen(open === b.asin ? null : b.asin)}>{open === b.asin ? 'Close' : splits[b.asin] ? 'Change' : 'Set split'}</button></td>
                <td>
                  <button style={{ whiteSpace: 'nowrap' }} onClick={() => void capture(b)} title={b.snapshots ? `Captured ${b.lastCaptured?.slice(0, 10)}. Open it again to refresh the authors credited on its page` : 'Not captured yet: open it on Amazon and send the page with the extension to bring in every credited author'}>{b.snapshots ? 'Capture again' : 'Open to capture'}</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {msg && <div className="muted" role="status">{msg}</div>}
      {err && <div className="err" role="alert">{err}</div>}
      {open && <SplitEditor key={`${open}:${detected.filter((d) => d.asins.includes(open)).length}`} book={books.find((b) => b.asin === open)!} people={people} detected={detected} history={splits[open] ?? []} onCapture={() => void capture(books.find((b) => b.asin === open)!)} onDone={() => { setOpen(null); load(); reload(); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- statement

const years = (n = 6) => Array.from({ length: n }, (_, i) => String(+currentMonth().slice(0, 4) - i));

export function PeriodPicker({ kind, value, setKind, setValue }: { kind: PeriodKind; value: string; setKind: (k: PeriodKind) => void; setValue: (v: string) => void }) {
  const y = value.slice(0, 4) || currentMonth().slice(0, 4);
  const [from, to] = value.split('..');
  return (
    <>
      <div className="row">
        {periodShortcuts().map((s) => <button key={s.label} className="tab" aria-pressed={kind === s.kind && value === s.value} onClick={() => { setKind(s.kind); setValue(s.value); }}>{s.label}</button>)}
      </div>
      <div className="row">
        {(['month', 'quarter', 'year', 'custom'] as const).map((k) => (
          <button key={k} className="tab" aria-pressed={kind === k} onClick={() => {
            setKind(k);
            setValue(k === 'month' ? currentMonth() : k === 'quarter' ? quarterOf(currentMonth()) : k === 'year' ? currentMonth().slice(0, 4) : `${currentMonth().slice(0, 4)}-01..${currentMonth()}`);
          }}>{k === 'custom' ? 'Custom range' : k[0]!.toUpperCase() + k.slice(1)}</button>
        ))}
        {kind === 'month' && <input type="month" value={value} onChange={(e) => e.target.value && setValue(e.target.value)} aria-label="Month" />}
        {kind === 'quarter' && (
          <>
            <select value={y} onChange={(e) => setValue(`${e.target.value}-${value.slice(5) || 'Q1'}`)} aria-label="Year">{years().map((x) => <option key={x}>{x}</option>)}</select>
            <select value={value.slice(5) || 'Q1'} onChange={(e) => setValue(`${y}-${e.target.value}`)} aria-label="Quarter">{['Q1', 'Q2', 'Q3', 'Q4'].map((q) => <option key={q}>{q}</option>)}</select>
          </>
        )}
        {kind === 'year' && <select value={value} onChange={(e) => setValue(e.target.value)} aria-label="Year">{years().map((x) => <option key={x}>{x}</option>)}</select>}
        {kind === 'custom' && (
          <>
            <input type="month" value={from ?? ''} onChange={(e) => e.target.value && setValue(`${e.target.value}..${to ?? e.target.value}`)} aria-label="From month" />
            to
            <input type="month" value={to ?? ''} onChange={(e) => e.target.value && setValue(`${from ?? e.target.value}..${e.target.value}`)} aria-label="To month" />
          </>
        )}
      </div>
    </>
  );
}

function FxRates({ s, reload }: { s: Statement; reload: () => void }) {
  const rows = s.fx.filter((f) => f.currency !== 'USD');
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  if (!rows.length) return null;
  const save = async (m: string, c: string) => {
    const k = `${m}|${c}`; const v = (edit[k] ?? '').trim();
    try { await api.setFxRate(m, c, v === '' ? null : Number(v)); setEdit((e) => { const { [k]: _, ...rest } = e; return rest; }); reload(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <details>
      <summary>Exchange rates used ({rows.length})</summary>
      <p className="muted">USD value of one unit of each currency, per month. “Default” is the app's built-in approximation: enter the rate you were actually paid at (from your bank or KDP payment report) and it is kept, and carries forward to later months until you set another.</p>
      <table>
        <thead><tr><th>Month</th><th>Currency</th><th className="num">USD per unit</th><th>Source</th><th>Set</th></tr></thead>
        <tbody>
          {rows.map((f) => (
            <tr key={`${f.month}|${f.currency}`}>
              <td>{f.month}</td><td>{f.currency}</td><td className="num">{f.toUsd}</td><td>{f.source === 'user' ? 'Yours' : 'Default'}</td>
              <td>
                <input value={edit[`${f.month}|${f.currency}`] ?? ''} onChange={(e) => setEdit({ ...edit, [`${f.month}|${f.currency}`]: e.target.value })} placeholder="rate" aria-label={`USD per ${f.currency} for ${f.month}`} style={{ width: 90 }} />{' '}
                <button onClick={() => void save(f.month, f.currency)} disabled={edit[`${f.month}|${f.currency}`] === undefined}>{(edit[`${f.month}|${f.currency}`] ?? '').trim() === '' ? 'Use default' : 'Set'}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {err && <div className="err" role="alert">{err}</div>}
    </details>
  );
}

const BASIS_TEXT = {
  paid: 'What Amazon paid in the period: every payment dated in it, split by each line\'s sales month and the split for that month, after the tax Amazon withheld. This is what can be paid out to authors.',
  earned: 'What the books earned in the period, by sales month. Sales Amazon has paid are owed; sales it has not paid yet are shown as estimates and are not owed yet.',
} as const;

function StatementPanel({ version, bump }: { version: number; bump: () => void }) {
  const [basis, setBasis] = useState<StatementBasis>('paid');
  const [kind, setKind] = useState<PeriodKind>('quarter');
  const [value, setValue] = useState(periodShortcuts()[1]!.value);
  const [who, setWho] = useState('');
  const [s, setS] = useState<Statement | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const range = useMemo(() => periodRange(kind, value), [kind, value]);
  const load = () => { if (range) void api.statement(range.from, range.to, basis).then((x) => { setS(x); setErr(''); }, (e) => setErr(String(e.message ?? e))); };
  useEffect(load, [range?.from, range?.to, basis, version]);
  const shown = s?.payees.filter((p) => !who || p.name === who) ?? [];
  const out = async (k: 'csv' | 'pdf', payee: string | null) => {
    if (!range) return;
    setMsg(''); setErr('');
    try { const f = await api.exportStatement(range.from, range.to, k, payee, basis); if (f) setMsg(`Saved ${f}`); } catch (e) { setErr((e as Error).message); }
  };
  const label = range ? (range.from === range.to ? monthName(range.from) : `${monthName(range.from)} to ${monthName(range.to)}`) : '';
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Author statement</h2>
      <div className="row">
        {(['paid', 'earned'] as const).map((b) => <button key={b} className="tab" aria-pressed={basis === b} onClick={() => setBasis(b)}>{b === 'paid' ? 'Paid by Amazon in the period' : 'Earned in the period (by sales month)'}</button>)}
      </div>
      <p className="muted">{BASIS_TEXT[basis]} Kindle+ (Kindle+) money of the current month is left out until the month is over.</p>
      <PeriodPicker kind={kind} value={value} setKind={setKind} setValue={setValue} />
      <div className="row">
        <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Author"><option value="">All authors</option>{s?.payees.map((p) => <option key={p.name}>{p.name}</option>)}</select>
        <button onClick={() => void out('csv', who || null)} disabled={!s?.payees.length}>Save CSV</button>
        <button onClick={() => void out('pdf', who || null)} disabled={!s?.payees.length} title={who ? undefined : 'Writes one PDF per author into a folder you choose'}>{who ? 'Save PDF' : 'Save a PDF for each author'}</button>
      </div>
      {msg && <div className="muted" role="status">{msg}</div>}
      {err && <div className="err" role="alert">{err}</div>}
      {!range && <div className="err" role="alert">That period is not valid.</div>}
      {s && (
        <>
          {!s.reconciled && <div className="banner">{basis === 'paid' ? 'No KDP payment report has been imported, so there is nothing to show as paid. Download the Payments report from KDP Reports and import it on the Reports tab.' : 'No KDP payment report has been imported: these are royalties as KDP reports them by sales month, not checked against what Amazon paid or the tax it withheld. Import the Payments report (Reports tab) for exact amounts.'}</div>}
          {s.payments.length > 0 && <div className="muted">{basis === 'paid' ? 'Payments in this period' : 'Payments that cover these sales'}: {s.payments.map((x) => `${x.number} on ${x.paidOn}${x.scheduled ? ' (scheduled)' : ''}: ${usd(x.accrued)} before ${usd(x.tax)} tax = ${usd(x.net)}`).join('; ')}.</div>}
          {s.pending.length > 0 && <div className="banner">Not owed yet: Kindle+ pages read in {[...new Set(s.pending.map((p) => monthName(p.month)))].join(', ')} (about {usd(s.pending.reduce((a, p) => a + p.usd, 0))}). KDP has not priced them; they will appear once the month is over.</div>}
          {s.unmatched.length > 0 && <div className="banner">A payment includes money for months with no royalty report imported ({[...new Set(s.unmatched.map((u) => u.month))].join(', ')}: {usd(s.unmatched.reduce((a, u) => a + u.net, 0))} after tax), so no book can be credited. Import the royalty report that covers those months.</div>}
          {s.differences.length > 0 && <div className="banner">KDP paid {s.differences.length === 1 ? 'a month' : `${s.differences.length} lines`} differently from the royalty report ({s.differences.map((d) => `${d.month} ${d.source === 'kenp' ? 'Kindle+' : 'sales'}: reported ${money(d.reported, d.currency)}, paid ${money(d.paid, d.currency)}`).join('; ')}). Amazon revised the month after paying it; the paid amount is what is owed, and any shortfall shows as awaiting payment.</div>}
          {shown.length === 0 && <p className="muted">{basis === 'paid' ? `Amazon paid nothing in ${label}.` : `No royalties in ${label}.`}</p>}
          {shown.map((p) => {
            const months = [...new Set(p.lines.map((l) => l.month))];
            return (
              <div key={p.name} className="card" style={{ marginTop: 8 }}>
                <div className="row">
                  <h3 style={{ margin: 0 }}>{p.name}</h3><span className="spacer" />
                  <b style={{ fontSize: 18 }} title="After the tax Amazon withheld">{usd(p.totalUsd)}</b>
                </div>
                <div className="muted">{p.taxUsd > 0 ? `${usd(p.accruedUsd)} before ${usd(p.taxUsd)} tax withheld by Amazon` : p.byCurrency.length ? p.byCurrency.map((c) => money(c.amount, c.currency)).join(' + ') + ' at the month\'s exchange rates' : ''}{p.estimatedUsd > 0 && <> · {usd(p.estimatedUsd)} rests on an estimated Kindle+ rate</>}{p.awaitingUsd > 0 && <> · plus about {usd(p.awaitingUsd)} not owed yet (awaiting payment)</>}</div>
                <table>
                  <thead><tr><th>Sales month</th><th>Book</th><th>Source</th><th>Status</th><th className="num">Book royalty</th><th className="num">Share</th><th className="num">Before tax</th><th className="num">Tax</th><th className="num">{basis === 'paid' ? 'Paid' : 'Owed'}</th></tr></thead>
                  <tbody>
                    {months.map((m) => {
                      // one row per book, source and payment: the marketplaces' currencies of an unpaid line are folded into its USD figure (the CSV and PDF keep every line)
                      const groups = new Map<string, typeof p.lines>();
                      for (const l of p.lines.filter((x) => x.month === m)) { const k = `${l.asin}|${l.source}|${l.status}|${l.paymentNumber ?? ''}`; groups.set(k, [...(groups.get(k) ?? []), l]); }
                      return [...groups.values()].map((ls, i) => {
                        const l0 = ls[0]!;
                        const cur = [...new Set(ls.map((l) => l.currency))];
                        const aw = l0.status === 'awaiting';
                        const total = ls.reduce((a, l) => a + l.usd, 0);
                        return (
                          <tr key={`${m}${i}`} style={aw ? { color: 'var(--muted)', fontStyle: 'italic' } : undefined}>
                            <td>{i === 0 ? monthName(m) : ''}</td><td>{l0.title}</td><td>{SOURCE_NAME[l0.source]}</td>
                            <td>{l0.status === 'paid' ? <span title={`Payment ${l0.paymentNumber}`}>Paid {l0.paidOn}{l0.scheduled ? ' (scheduled)' : ''}{l0.derived ? ' *' : ''}</span> : aw ? 'Awaiting payment' : 'Not checked'}{ls.some((l) => l.state === 'estimated') && <span className="pill" style={{ marginLeft: 6 }}>estimated</span>}</td>
                            <td className="num">{cur.length === 1 ? money(ls.reduce((a, l) => a + l.gross, 0), cur[0]!) : usd(ls.reduce((a, l) => a + l.grossUsd, 0))}</td>
                            <td className="num">{l0.pct}%</td>
                            <td className="num">{usd(ls.reduce((a, l) => a + l.shareGrossUsd, 0))}</td>
                            <td className="num">{l0.status === 'paid' ? usd(ls.reduce((a, l) => a + l.shareTaxUsd, 0)) : ''}</td>
                            <td className="num">{aw ? `(${usd(total)})` : usd(total)}</td>
                          </tr>
                        );
                      });
                    })}
                    <tr><th colSpan={8}>{basis === 'paid' ? 'Total paid' : 'Total owed'} (USD, after tax)</th><th className="num">{usd(p.totalUsd)}</th></tr>
                  </tbody>
                </table>
                {p.lines.some((l) => l.derived) && <div className="muted">* The payment line was not in USD, and KDP does not say what rate it used: its USD value is worked out from the payment's total.</div>}
              </div>
            );
          })}
          {shown.length > 1 && <div className="row"><b>All authors: {usd(shown.reduce((a, p) => a + p.totalUsd, 0))}</b> <span className="muted">for {label} · {int(shown.reduce((a, p) => a + p.lines.length, 0))} lines</span></div>}
          <FxRates s={s} reload={() => { load(); bump(); }} />
        </>
      )}
    </div>
  );
}

/** Royalty splits between the authors of a book, and what each author is owed for a period. */
export function Royalties({ version }: { version: number }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [v, setV] = useState(0);
  const reload = () => { void api.people().then(setPeople); setV((x) => x + 1); };
  useEffect(() => { void api.people().then(setPeople); }, [version]);
  return (
    <>
      <People people={people} reload={reload} />
      <Splits people={people} version={version + v} reload={reload} />
      <StatementPanel version={version + v} bump={() => setV((x) => x + 1)} />
    </>
  );
}
