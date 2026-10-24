import { useEffect, useState } from 'react';
import type { HealthRow, IssueRow, MaintenanceStatus } from '../../shared/api.js';

const api = window.bookscout;

export function IssuesView({ version }: { version: number }) {
  const [rows, setRows] = useState<IssueRow[]>([]);
  const [health, setHealth] = useState<HealthRow[]>([]);
  const [m, setM] = useState<MaintenanceStatus | null>(null);
  const [err, setErr] = useState('');
  const load = () => {
    void api.issues().then(setRows);
    void api.parserHealth().then(setHealth);
    void api.maintenanceStatus().then(setM);
  };
  useEffect(() => {
    load();
    return api.onMaintenance(load);
  }, [version]);
  const rebuilding = m?.kind === 'rebuild';

  return (
    <>
      <h1>Parser health</h1>
      <p className="muted">
        If Amazon changes a page layout, fields start going missing in new captures. This shows how many captures per week had missing fields. Every page is kept, so after an update that fixes the reader, "Re-read all pages" repairs the old captures too.
      </p>
      <div className="row">
        <button disabled={!!m?.kind} onClick={() => { setErr(''); api.rebuild().catch((e) => setErr(String(e.message ?? e))); }}>Re-read all pages</button>
        {rebuilding && <span role="status">Re-reading… {m!.done.toLocaleString()} of {m!.total.toLocaleString()}</span>}
        {m?.message && !m.kind && <span role="status" className="muted">{m.message}</span>}
        {(err || m?.error) && <span className="err" role="alert">{err || m?.error}</span>}
      </div>
      {health.length === 0 ? <p className="muted">Nothing captured yet.</p> : (
        <table>
          <thead><tr><th>Week of</th><th>Pages</th><th className="num">Captures</th><th className="num">With missing fields</th><th>Most common missing fields</th></tr></thead>
          <tbody>
            {health.map((h) => (
              <tr key={h.week + h.kind} data-week={h.week}>
                <td>{h.week}</td><td>{h.kind}</td><td className="num">{h.captures}</td>
                <td className={`num ${h.share >= 0.5 ? 'err' : ''}`}>{h.withIssues} ({Math.round(h.share * 100)}%)</td>
                <td className="muted">{h.fields.slice(0, 4).map((f) => `${f.field} (${f.captures})`).join(', ') || '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Individual issues</h2>
      {rows.length === 0 ? (
        <p>None. Every captured page parsed cleanly.</p>
      ) : (
        <table>
          <thead><tr><th>Source</th><th>Capture</th><th>Field</th><th>Severity</th><th>Detail</th></tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}><td>{r.source}</td><td><code>{r.ref}</code></td><td>{r.field}</td><td className={r.severity === 'error' ? 'err' : ''}>{r.severity}</td><td>{r.detail}</td></tr>)}</tbody>
        </table>
      )}
    </>
  );
}
