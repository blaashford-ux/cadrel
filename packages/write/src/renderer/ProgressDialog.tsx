import { useMemo, useState } from 'react';
import { addDays, burnDown, dailySeries, dateRange, firstDay, localDate, summarize, type Goal, type Progress, type Projection } from '../shared/progress';
import { goalFor, type ProjectMeta } from '../shared/projects';
import { useEscape } from './useEscape';

interface Props {
  project: { path: string; meta: ProjectMeta };
  progress: { progress: Progress; total: number; manuscript: string | null } | null;
  onClose(): void;
  onSetGoal(): void;
}

type Range = 14 | 30 | 'all';

const fmt = (n: number) => Math.round(n).toLocaleString();
const dayLabel = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function projectionText(p: Projection, goal: Goal): string {
  if (p.date === null) return 'No pace yet';
  const base = p.days === 0 ? 'Done' : `${dayLabel(p.date)} (${p.days} day${p.days === 1 ? '' : 's'})`;
  if (p.vsDeadline === null || p.days === 0) return base;
  if (p.vsDeadline >= 0) return `${base} — ${p.vsDeadline} day${p.vsDeadline === 1 ? '' : 's'} ahead`;
  void goal;
  return `${base} — ${-p.vsDeadline} day${p.vsDeadline === -1 ? '' : 's'} behind`;
}

const W = 680;
const H = 260;
const M = { l: 48, r: 56, t: 14, b: 30 };

/** Day-by-day words written (bars) with the burn-down toward the goal, plus the numbers that matter. */
export function ProgressDialog({ project, progress, onClose, onSetGoal }: Props) {
  useEscape(onClose);
  const [range, setRange] = useState<Range>(30);
  const [hover, setHover] = useState<string | null>(null);
  const today = localDate(new Date());
  const goal = goalFor(project.meta);
  const manuscript = progress?.manuscript ?? project.meta.activeManuscript;
  const fileName = manuscript ? manuscript.split('/').pop() : null;
  const p = progress?.progress ?? null;
  const total = progress?.total ?? 0;

  const dates = useMemo(() => {
    if (!p) return [];
    const first = firstDay(p) ?? today;
    if (range === 'all') {
      const start = goal && goal.startDate < first ? goal.startDate : first;
      const end = goal?.targetDate && goal.targetDate > today ? goal.targetDate : today;
      const all = dateRange(start, end);
      return all.length > 366 ? all.slice(-366) : all;
    }
    return dateRange(addDays(today, -(range - 1)), today);
  }, [p, range, goal, today]);

  if (!p) {
    return (
      <div className="modal-backdrop">
        <div className="modal progress-dialog" role="dialog" aria-modal="true" aria-label="Progress">
          <h3>
          Progress — {project.meta.name}
          {fileName && <span className="ms-name"> · {fileName}</span>}
        </h3>
          <p className="muted">Counting words…</p>
          <div className="modal-actions">
            <button onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  const from = dates[0] ?? today;
  const to = dates[dates.length - 1] ?? today;
  const series = dailySeries(p, from, to, today);
  const burn = goal ? burnDown(p, goal, from, to, today) : [];
  const s = goal ? summarize(p, goal, total, today) : null;

  const required = goal && s?.requiredPerDay ? s.requiredPerDay : 0;
  const maxBar = Math.max(1, required, ...series.map((d) => d.written)) * 1.12;
  const maxRem = goal ? Math.max(1, ...burn.map((b) => Math.max(b.remaining ?? 0, b.ideal ?? 0))) * 1.05 : 1;
  const iw = W - M.l - M.r;
  const ih = H - M.t - M.b;
  const slot = iw / Math.max(1, series.length);
  const barW = Math.max(2, Math.min(28, slot * 0.7));
  const x = (i: number) => M.l + slot * i + slot / 2;
  const yBar = (v: number) => M.t + ih - (v / maxBar) * ih;
  const yRem = (v: number) => M.t + ih - (v / maxRem) * ih;
  const line = (pick: (i: number) => number | null) =>
    series
      .map((_, i) => ({ v: pick(i), i }))
      .filter((q): q is { v: number; i: number } => q.v !== null)
      .map((q, k) => `${k === 0 ? 'M' : 'L'}${x(q.i).toFixed(1)},${yRem(q.v).toFixed(1)}`)
      .join(' ');
  const labelEvery = Math.max(1, Math.ceil(series.length / 8));
  const hovered = hover ? series.find((d) => d.date === hover) : null;
  const hoveredBurn = hover ? burn.find((d) => d.date === hover) : null;
  const todayIdx = series.findIndex((d) => d.date === today);

  return (
    <div className="modal-backdrop">
      <div className="modal progress-dialog" role="dialog" aria-modal="true" aria-label="Progress">
        <h3>
          Progress — {project.meta.name}
          {fileName && <span className="ms-name"> · {fileName}</span>}
        </h3>

        <div className="tiles">
          <Tile label={fileName ?? 'Words'} value={fmt(total)} sub={goal ? `of ${fmt(goal.targetWords)} (${s!.percent}%)` : undefined} />
          <Tile label="Today" value={fmt(s?.writtenToday ?? series.find((d) => d.date === today)?.written ?? 0)} />
          <Tile label="3-day average" value={`${fmt(s?.avg3 ?? avg(series, today, 3))}/day`} />
          <Tile label="5-day average" value={`${fmt(s?.avg5 ?? avg(series, today, 5))}/day`} />
          {goal && s && (
            <>
              <Tile label="Remaining" value={fmt(s.remaining)} />
              <Tile label="Days left" value={s.daysLeft === null ? '—' : s.daysLeft <= 0 ? 'Past due' : String(s.daysLeft)} />
              <Tile label="Needed per day" value={s.requiredPerDay === null ? '—' : s.done ? 'Done' : fmt(s.requiredPerDay)} accent />
            </>
          )}
        </div>

        {goal && s && !s.done && (
          <div className="estimates">
            <div>
              <strong>At the 3-day average:</strong> {projectionText(s.eta3, goal)}
            </div>
            <div>
              <strong>At the 5-day average:</strong> {projectionText(s.eta5, goal)}
            </div>
          </div>
        )}
        {goal && s?.done && <div className="banner info">Goal reached — {fmt(total)} words.</div>}
        {!goal && (
          <div className="banner info">
            No goal set. <button onClick={onSetGoal}>Set a word-count goal…</button>
          </div>
        )}

        <div className="chart-head">
          <div className="legend">
            <span className="lg bars">{fileName ? `${fileName}: words written` : 'Words written'}</span>
            {goal && <span className="lg burn">Words remaining</span>}
            {goal?.targetDate && <span className="lg ideal">Steady pace</span>}
          </div>
          <div className="range" role="group" aria-label="Range">
            {([14, 30, 'all'] as const).map((r) => (
              <button key={r} type="button" className={range === r ? 'active' : ''} aria-pressed={range === r} onClick={() => setRange(r)}>
                {r === 'all' ? 'All' : `${r} days`}
              </button>
            ))}
          </div>
        </div>
        <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Words written per day${fileName ? ` in ${fileName}` : ''}`} onMouseLeave={() => setHover(null)}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={M.l} x2={W - M.r} y1={M.t + ih * (1 - f)} y2={M.t + ih * (1 - f)} className="grid" />
              <text x={M.l - 6} y={M.t + ih * (1 - f) + 4} textAnchor="end" className="axis">
                {fmt((maxBar / 1.12) * f)}
              </text>
              {goal && (
                <text x={W - M.r + 6} y={M.t + ih * (1 - f) + 4} className="axis axis-r">
                  {fmt((maxRem / 1.05) * f)}
                </text>
              )}
            </g>
          ))}
          {fileName && (
            <text x={M.l} y={10} className="axis">
              {fileName}
            </text>
          )}
          {todayIdx >= 0 && <line x1={x(todayIdx)} x2={x(todayIdx)} y1={M.t} y2={M.t + ih} className="today-line" />}
          {required > 0 && <line x1={M.l} x2={W - M.r} y1={yBar(required)} y2={yBar(required)} className="need-line" />}
          {series.map((d, i) => (
            <g key={d.date} onMouseEnter={() => setHover(d.date)}>
              <rect x={M.l + slot * i} y={M.t} width={slot} height={ih} fill="transparent" />
              <rect x={x(i) - barW / 2} y={yBar(d.written)} width={barW} height={Math.max(0, M.t + ih - yBar(d.written))} rx={2} className={d.written > 0 ? 'bar' : 'bar zero'}>
                <title>{`${dayLabel(d.date)}: ${fmt(d.written)} words`}</title>
              </rect>
              {i % labelEvery === 0 && (
                <text x={x(i)} y={H - 10} textAnchor="middle" className="axis">
                  {dayLabel(d.date)}
                </text>
              )}
            </g>
          ))}
          {goal?.targetDate && <path d={line((i) => burn[i]?.ideal ?? null)} className="ideal-line" />}
          {goal && <path d={line((i) => burn[i]?.remaining ?? null)} className="burn-line" />}
        </svg>
        <div className="chart-readout" aria-live="polite">
          {hovered
            ? `${dayLabel(hovered.date)}: ${fmt(hovered.written)} written${hovered.total !== null ? ` · ${fmt(hovered.total)} words total` : ''}${
                hoveredBurn?.remaining != null ? ` · ${fmt(hoveredBurn.remaining)} remaining` : ''
              }${hoveredBurn?.ideal != null ? ` (steady pace: ${fmt(hoveredBurn.ideal)})` : ''}`
            : required > 0
              ? `The dashed horizontal line is the ${fmt(required)} words a day needed from today.`
              : 'Hover a day for details.'}
        </div>
        <p className="muted small">
          Written is the net change in the project’s word count each day: deleting more than you write shows as 0. History is stored in the project’s hidden
          .mdedit folder.
        </p>
        <div className="modal-actions">
          {goal && <button onClick={onSetGoal}>Change goal…</button>}
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function avg(series: { date: string; written: number }[], today: string, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += series.find((d) => d.date === addDays(today, -i))?.written ?? 0;
  return sum / n;
}

function Tile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`tile${accent ? ' accent' : ''}`}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}
