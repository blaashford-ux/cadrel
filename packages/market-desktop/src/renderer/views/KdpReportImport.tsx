import { useRef, useState } from 'react';
import type { ImportSummary } from '../../shared/api.js';

const api = window.bookscout;

export const describeImport = (s: ImportSummary) =>
  `${s.file.replace(/^\d{8}T\d{6}Z-/, '')}: ${s.contains?.length === 1 && s.contains[0] === 'payments' ? '' : `${s.rows.toLocaleString()} rows for ${s.books} book${s.books === 1 ? '' : 's'}, ${s.from} to ${s.to}`}${s.contains ? ` (${s.contains.map((c) => (c === 'orders' ? 'paid orders' : c === 'payments' ? `${s.paymentCount} payment${s.paymentCount === 1 ? '' : 's'}${s.paymentFrom ? `, paid ${s.paymentFrom}${s.paymentTo && s.paymentTo !== s.paymentFrom ? ' to ' + s.paymentTo : ''}` : ''}` : c === 'royalties' ? `royalties${s.royaltyFrom ? ` ${s.royaltyFrom} to ${s.royaltyTo}` : ''}` : 'Kindle+ pages read')).join(' and ')})` : ''}${s.newBooks ? `; ${s.newBooks} new book${s.newBooks === 1 ? '' : 's'} added to My Books` : ''}${s.skipped ? `; ${s.skipped} unreadable rows skipped` : ''}`;

/** Pick KDP Orders and/or KENP Read reports (xlsx or csv, several at once) and import them. */
export function KdpReportImport({ onImported, label = 'Import KDP reports…' }: { onImported?: () => void; label?: string }) {
  const [msg, setMsg] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

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
      setMsg(done); setBusy(false); onImported?.();
    }
  };

  return (
    <>
      <button className="primary" type="button" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Importing…' : label}</button>
      <input ref={input} type="file" multiple accept=".xlsx,.csv,text/csv" hidden onChange={(e) => { const el = e.target; void pick(el.files).finally(() => { el.value = ''; }); }} />
      {err && <div className="err" role="alert">{err}</div>}
      {msg.map((m, i) => <div key={i} className="muted" role="status">{m}</div>)}
    </>
  );
}
