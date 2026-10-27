import { useEffect, useRef, useState } from 'react';
import type { ImportSummary } from './types.js';

const api = window.cadrelFinance;

export const describeImport = (s: ImportSummary) =>
  `${s.file.replace(/^\d{8}T\d{6}Z-/, '')}: ${s.contains?.length === 1 && s.contains[0] === 'payments' ? '' : `${s.rows.toLocaleString()} rows for ${s.books} book${s.books === 1 ? '' : 's'}, ${s.from} to ${s.to}`}${s.contains ? ` (${s.contains.map((c) => (c === 'orders' ? 'paid orders' : c === 'payments' ? `${s.paymentCount} payment${s.paymentCount === 1 ? '' : 's'}${s.paymentFrom ? `, paid ${s.paymentFrom}${s.paymentTo && s.paymentTo !== s.paymentFrom ? ' to ' + s.paymentTo : ''}` : ''}` : c === 'royalties' ? `royalties${s.royaltyFrom ? ` ${s.royaltyFrom} to ${s.royaltyTo}` : ''}` : 'Kindle+ pages read')).join(' and ')})` : ''}${s.newBooks ? `; ${s.newBooks} new book${s.newBooks === 1 ? '' : 's'} added to My Books` : ''}${s.skipped ? `; ${s.skipped} unreadable rows skipped` : ''}${describeExcluded(s)}`;

/** What a Studio-limited import left out, in words: other pen names' books, or that this Studio has no pen names yet. */
const describeExcluded = (s: ImportSummary) => {
  if (s.noPenNames) return '. This Studio has no pen names yet, so nothing was brought in. Add the pen names it publishes under in Admin → People and roles, then import again';
  const x = s.excluded;
  if (!x || (!x.books && !x.accountTotalsSkipped)) return '';
  const who = x.authors.length ? ` (${x.authors.join(', ')})` : '';
  return `${x.books ? `. Left out ${x.books} book${x.books === 1 ? '' : 's'} by other pen names${who}` : ''}${x.accountTotalsSkipped ? `${x.books ? '; ' : '. '}payments and monthly totals were skipped because they cover every pen name on the KDP account` : ''}`;
};

/** Pick KDP Orders and/or KENP Read reports (xlsx or csv, several at once) and import them. */
export function KdpReportImport({ onImported, label = 'Import KDP reports…' }: { onImported?: () => void; label?: string }) {
  const [msg, setMsg] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [stray, setStray] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const countStray = () => api.booksOutsideScope().then((b) => setStray(b.length), () => setStray(0));
  useEffect(() => { void countStray(); }, []);
  const removeStray = async () => {
    if (!window.confirm(`Remove ${stray} book${stray === 1 ? '' : 's'} by pen names this Studio does not have, with their sales, pages read and royalties? Your KDP files stay on disk.`)) return;
    try { await api.removeBooksOutsideScope(); } catch (e) { setErr((e as Error).message); }
    await countStray(); onImported?.();
  };

  const pick = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true); setErr(''); setMsg([]);
    const done: string[] = [];
    try {
      for (const f of Array.from(files)) {
        try {
          done.push(describeImport(await api.importSales(f.name, new Uint8Array(await f.arrayBuffer()))));
        } catch (e) {
          setErr(`${f.name}: ${(e as Error).message}`);
          break;
        }
      }
    } finally {
      setMsg(done); setBusy(false); void countStray(); onImported?.();
    }
  };

  return (
    <>
      <button className="primary" type="button" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Importing…' : label}</button>
      <input ref={input} type="file" multiple accept=".xlsx,.csv,text/csv" hidden onChange={(e) => { const el = e.target; void pick(el.files).finally(() => { el.value = ''; }); }} />
      {err && <div className="err" role="alert">{err}</div>}
      {stray > 0 && <div className="muted" role="status">{stray} book{stray === 1 ? ' is' : 's are'} in this library under pen names this Studio does not have. <button type="button" onClick={() => void removeStray()}>Remove other pen names’ books</button></div>}
      {msg.map((m, i) => <div key={i} className="muted" role="status">{m}</div>)}
    </>
  );
}
