import type { ReactNode } from 'react';

/** Series colours come from CSS so they follow light/dark. Slot 1 is blue, slot 2 orange. */
export const S1 = 'var(--series-1)';
export const S2 = 'var(--series-2)';

export function Legend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span key={i.label}><i style={{ background: i.color }} />{i.label}</span>
      ))}
    </div>
  );
}

/** A chart plus a table of the same numbers, so nothing depends on seeing colour. */
export function ChartCard({ title, note, children, table }: { title: string; note?: ReactNode; children: ReactNode; table?: { head: string[]; rows: (string | number)[][] } }) {
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      {note && <div className="muted" style={{ marginBottom: 6 }}>{note}</div>}
      {children}
      {table && (
        <details className="table-view">
          <summary>Show as table</summary>
          <table>
            <thead><tr>{table.head.map((h, i) => <th key={i} className={i ? 'num' : ''}>{h}</th>)}</tr></thead>
            <tbody>{table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j ? 'num' : ''}>{c}</td>)}</tr>)}</tbody>
          </table>
        </details>
      )}
    </div>
  );
}

const W = 520;

/** Two bars per category (top cohort, rest), as a share of each cohort so different sizes compare fairly. */
export function GroupedBars({ rows, aLabel, bLabel, label }: { rows: { label: string; a: number; b: number; aN: number; bN: number }[]; aLabel: string; bLabel: string; label: string }) {
  const H = 190, top = 18, bottom = 34, left = 8, right = 8;
  const max = Math.max(0.01, ...rows.flatMap((r) => [r.a, r.b]));
  const slot = (W - left - right) / rows.length;
  const bw = Math.min(24, (slot - 12) / 2);
  const y = (v: number) => top + (H - top - bottom) * (1 - v / max);
  return (
    <>
      <Legend items={[{ color: S1, label: aLabel }, { color: S2, label: bLabel }]} />
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        <line className="grid" x1={left} x2={W - right} y1={H - bottom} y2={H - bottom} />
        {rows.map((r, i) => {
          const cx = left + slot * i + slot / 2;
          return (
            <g key={r.label}>
              {[{ v: r.a, n: r.aN, c: S1, x: cx - bw - 1, who: aLabel }, { v: r.b, n: r.bN, c: S2, x: cx + 1, who: bLabel }].map((b) => (
                <g key={b.who}>
                  <rect x={b.x} y={y(b.v)} width={bw} height={Math.max(0, H - bottom - y(b.v))} rx={3} fill={b.c}>
                    <title>{`${r.label} · ${b.who}: ${Math.round(b.v * 100)}% (${b.n} book${b.n === 1 ? '' : 's'})`}</title>
                  </rect>
                  {b.v > 0 && <text className="val" x={b.x + bw / 2} y={y(b.v) - 4} textAnchor="middle">{Math.round(b.v * 100)}%</text>}
                </g>
              ))}
              <text x={cx} y={H - bottom + 14} textAnchor="middle">{r.label}</text>
            </g>
          );
        })}
      </svg>
    </>
  );
}

/** Horizontal bars for one series, each with its value written at the end. */
export function HBars({ rows, label, unit = '%', format }: { rows: { label: string; value: number; note?: string }[]; label: string; unit?: string; /** How a value is written (money); without it a % or the bare number. */ format?: (n: number) => string }) {
  const show = (v: number) => (format ? format(v) : unit === '%' ? `${Math.round(v * 100)}%` : String(v));
  const rowH = 24, left = 170, right = 60;
  const max = Math.max(0.0001, ...rows.map((r) => r.value));
  const H = rows.length * rowH + 4;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      {rows.map((r, i) => {
        const w = ((W - left - right) * r.value) / max;
        return (
          <g key={r.label}>
            <text x={left - 8} y={i * rowH + 15} textAnchor="end">{r.label}</text>
            <rect x={left} y={i * rowH + 4} width={Math.max(0, w)} height={14} rx={3} fill={S1}>
              <title>{`${r.label}: ${show(r.value)}${r.note ? ' · ' + r.note : ''}`}</title>
            </rect>
            <text className="val" x={left + w + 6} y={i * rowH + 15}>{show(r.value)}</text>
          </g>
        );
      })}
    </svg>
  );
}

const nice = (v: number) => (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10);

export function Scatter({ points, aLabel, bLabel, xLabel, yLabel, label }: { points: { x: number; y: number; a: boolean; tip: string }[]; aLabel: string; bLabel: string; xLabel: string; yLabel: string; label: string }) {
  const H = 240, l = 40, r = 10, t = 10, b = 34;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const xMax = Math.max(1, ...xs), yMax = Math.max(1, ...ys);
  const X = (v: number) => l + ((W - l - r) * v) / xMax;
  const Y = (v: number) => t + (H - t - b) * (1 - v / yMax);
  return (
    <>
      <Legend items={[{ color: S1, label: aLabel }, { color: S2, label: bLabel }]} />
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line className="grid" x1={l} x2={W - r} y1={Y(yMax * f)} y2={Y(yMax * f)} />
            <text x={l - 6} y={Y(yMax * f) + 4} textAnchor="end">{nice(yMax * f)}</text>
          </g>
        ))}
        {[0, 0.5, 1].map((f) => <text key={f} x={X(xMax * f)} y={H - b + 14} textAnchor="middle">{Math.round(xMax * f)}</text>)}
        <text x={(l + W - r) / 2} y={H - 4} textAnchor="middle">{xLabel}</text>
        <text x={l + 4} y={t + 8}>{yLabel}</text>
        {points.map((p, i) => (
          <circle key={i} cx={X(p.x)} cy={Y(p.y)} r={5} fill={p.a ? S1 : S2} stroke="var(--surface)" strokeWidth={2}>
            <title>{p.tip}</title>
          </circle>
        ))}
      </svg>
    </>
  );
}

export function LineChart({ points, label, yLabel }: { points: { x: string; y: number | null }[]; label: string; yLabel: string }) {
  const pts = points.filter((p): p is { x: string; y: number } => p.y != null);
  if (pts.length < 2) return <div className="muted">{pts.length ? `One point so far (${pts[0]!.x}: ${pts[0]!.y}). A line needs two captures on different days.` : 'No data yet.'}</div>;
  const H = 170, l = 44, r = 14, t = 14, b = 28;
  const lo = Math.min(...pts.map((p) => p.y)), hi = Math.max(...pts.map((p) => p.y));
  const span = hi - lo || 1;
  const X = (i: number) => l + ((W - l - r) * i) / (pts.length - 1);
  const Y = (v: number) => t + (H - t - b) * (1 - (v - lo) / span);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <line className="grid" x1={l} x2={W - r} y1={H - b} y2={H - b} />
      <text x={l - 6} y={Y(hi) + 4} textAnchor="end">{nice(hi)}</text>
      <text x={l - 6} y={Y(lo) + 4} textAnchor="end">{nice(lo)}</text>
      <text x={12} y={10}>{yLabel}</text>
      <polyline fill="none" stroke={S1} strokeWidth={2} points={pts.map((p, i) => `${X(i)},${Y(p.y)}`).join(' ')} />
      {pts.map((p, i) => (
        <circle key={i} cx={X(i)} cy={Y(p.y)} r={4} fill={S1} stroke="var(--surface)" strokeWidth={2}><title>{`${p.x}: ${p.y}`}</title></circle>
      ))}
      <text x={l} y={H - 8}>{pts[0]!.x}</text>
      <text x={W - r} y={H - 8} textAnchor="end">{pts[pts.length - 1]!.x}</text>
    </svg>
  );
}

export const SERIES = [S1, S2, 'var(--series-3)'];

/** Vertical bars, one per label, each stacked from its parts (eBook / print / Kindle Unlimited). A bar with `faded` is not final. */
export function StackedBars({ rows, series, label, yLabel, format = (n) => String(Math.round(n)), wide = 720 }: { rows: { label: string; parts: number[]; faded?: boolean; tip?: string }[]; series: { label: string; color: string }[]; label: string; yLabel: string; format?: (n: number) => string; wide?: number }) {
  if (!rows.length) return <div className="muted">Nothing to show yet.</div>;
  const H = 200, l = 56, r = 10, t = 26, b = 34;
  const totals = rows.map((x) => x.parts.reduce((a, c) => a + Math.max(c, 0), 0));
  const max = Math.max(0.0001, ...totals);
  const slot = (wide - l - r) / rows.length;
  const bw = Math.min(40, Math.max(3, slot * 0.7));
  const Y = (v: number) => t + (H - t - b) * (1 - v / max);
  const every = Math.max(1, Math.ceil(rows.length / Math.floor((wide - l - r) / 56)));
  return (
    <svg className="chart" viewBox={`0 0 ${wide} ${H}`} role="img" aria-label={label}>
      <text x={4} y={10}>{yLabel}</text>
      {[0, 0.5, 1].map((f) => (
        <g key={f}><line className="grid" x1={l} x2={wide - r} y1={Y(max * f)} y2={Y(max * f)} /><text x={l - 6} y={Y(max * f) + 4} textAnchor="end">{format(max * f)}</text></g>
      ))}
      {rows.map((x, i) => {
        let y = H - b;
        const cx = l + slot * i + slot / 2;
        return (
          <g key={x.label} opacity={x.faded ? 0.55 : 1}>
            {x.parts.map((p, k) => {
              const h = (H - t - b) * (Math.max(p, 0) / max);
              y -= h;
              return h > 0 ? <rect key={k} x={cx - bw / 2} y={y} width={bw} height={h} fill={series[k]!.color}><title>{`${x.label}: ${series[k]!.label} ${format(p)}${x.tip ? ' · ' + x.tip : ''}`}</title></rect> : null;
            })}
            {i % every === 0 && <text x={cx} y={H - 16} textAnchor="middle">{x.label}</text>}
          </g>
        );
      })}
    </svg>
  );
}
