import { useEffect, useMemo, useState } from 'react';
import { inViewScope } from '@cadrel/kernel';
import type { PlanProject, PlanState, StudioState } from '../shared/api';
import { ScopeToggle, usePageScope } from './PageScope';
import { byDate, lateTasks, monthGrid, monthTitle, relativeDay, shiftMonth } from './calendar';

const api = window.cadrel.work;
type Ready = Extract<PlanState, { available: true }>;

interface Props {
  /** Changes elsewhere (a stage move, a task) reload the plan. */
  studio: StudioState | null;
  onProject: (id: string) => void;
}

/** The pipeline (every project by workflow and stage) and the calendar (every task and deadline), over the same records the Projects page edits. */
export function Planner({ studio, onProject }: Props) {
  const [plan, setPlan] = useState<PlanState | null>(null);
  const ps = usePageScope('planner');
  const [tab, setTab] = useState<'pipeline' | 'calendar'>('pipeline');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api.plan().then((p) => live && (setPlan(p), setError(null)), (e) => live && setError(String((e as Error)?.message ?? e)));
    return () => {
      live = false;
    };
  }, [studio]);
  if (error) return <div className="banner error" role="alert">{error}</div>;
  if (!plan) return <p className="muted">Loading…</p>;
  if (!plan.available) return <section className="card"><p className="muted">{plan.reason}</p></section>;
  // The Project in scope: its Books' stages and its tasks, deadlines and what is inside it; closed Books are left out with the rest of the scope.
  const view: Ready = ps.scope && studio ? { ...plan, projects: plan.projects.filter((p) => inViewScope(studio.tree, ps.scope!, p.id)), tasks: plan.tasks.filter((t) => inViewScope(studio.tree, ps.scope!, t.projectId)) } : plan;
  return (
    <div className="planner">
      <div className="row"><ScopeToggle s={ps} /></div>
      <div className="tabs" role="tablist" aria-label="Planner">
        {(['pipeline', 'calendar'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t === 'pipeline' ? 'Pipeline' : 'Calendar'}</button>
        ))}
      </div>
      {tab === 'pipeline' ? <Pipeline plan={view} onProject={onProject} /> : <Calendar plan={view} onProject={onProject} />}
    </div>
  );
}

function Pipeline({ plan, onProject }: { plan: Ready; onProject: (id: string) => void }) {
  const [wfId, setWfId] = useState(plan.workflows[0]?.id ?? '');
  const [level, setLevel] = useState<'all' | 'top' | 'sub'>('all');
  const wf = plan.workflows.find((w) => w.id === wfId) ?? plan.workflows[0];
  if (!wf) return <p className="muted pad">No projects yet. Create one on the Projects page and it appears here, in its workflow’s first stage.</p>;
  const mine = plan.projects.filter((p) => p.workflowId === wf.id && (level === 'all' || (level === 'top') === (p.path.length === 0)));
  const noStage = mine.filter((p) => !wf.stages.some((s) => s.key === p.stage));
  return (
    <section aria-label="Pipeline">
      <div className="row">
        <label className="inline"><span className="muted small">Workflow</span>
          <select value={wf.id} onChange={(e) => setWfId(e.target.value)} aria-label="Workflow">{plan.workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
        </label>
        <label className="inline"><span className="muted small">Show</span>
          <select value={level} onChange={(e) => setLevel(e.target.value as typeof level)} aria-label="Level">
            <option value="all">Projects and subprojects</option><option value="top">Projects only</option><option value="sub">Subprojects only</option>
          </select>
        </label>
        <span className="muted small">{mine.length} project{mine.length === 1 ? '' : 's'} in this workflow</span>
      </div>
      <div className="pipeline" role="list">
        {wf.stages.map((s) => {
          const here = mine.filter((p) => p.stage === s.key);
          return (
            <div key={s.key} className="pipe-col" role="listitem" aria-label={`${s.name}, ${here.length}`}>
              <h4 style={{ borderColor: s.color || undefined }}>{s.name} <span className="count">{here.length}</span></h4>
              {here.map((p) => <Card key={p.id} p={p} today={plan.today} onProject={onProject} />)}
              {here.length === 0 && <p className="muted small">Nothing here.</p>}
            </div>
          );
        })}
      </div>
      {noStage.length > 0 && <p className="muted small">Not in a stage of this workflow: {noStage.map((p) => p.name).join(', ')}.</p>}
    </section>
  );
}

function Card({ p, today, onProject }: { p: PlanProject; today: string; onProject: (id: string) => void }) {
  return (
    <button type="button" className="pipe-card" onClick={() => onProject(p.id)}>
      <strong>{p.name}</strong>
      {p.path.length > 0 && <span className="muted small">in {p.path.join(' / ')}</span>}
      <span className="small">
        <span className="chip">{p.kind}</span>
        {p.openTasks > 0 && <span className="muted"> {p.openTasks} open task{p.openTasks === 1 ? '' : 's'}</span>}
        {p.late > 0 && <span className="warn"> {p.late} late</span>}
        {p.nextDue && p.late === 0 && <span className="muted"> next {relativeDay(p.nextDue, today)}</span>}
      </span>
    </button>
  );
}

function Calendar({ plan, onProject }: { plan: Ready; onProject: (id: string) => void }) {
  const [y0, m0] = plan.today.split('-').map(Number) as [number, number];
  const [ym, setYm] = useState({ year: y0, month0: m0 - 1 });
  const [who, setWho] = useState<'all' | 'me'>('all');
  const [showDone, setShowDone] = useState(true);
  const tasks = useMemo(() => plan.tasks.filter((t) => (who === 'all' || t.assigneeId === plan.me) && (showDone || t.state === 'open')), [plan, who, showDone]);
  const days = useMemo(() => byDate(tasks), [tasks]);
  const weeks = monthGrid(ym.year, ym.month0);
  const late = lateTasks(tasks, plan.today);
  const undated = tasks.filter((t) => !t.due && t.state === 'open');
  const nameOf = (id: string | null) => (id ? plan.people.find((p) => p.id === id)?.name ?? '' : '');
  const go = (by: number) => setYm((c) => shiftMonth(c.year, c.month0, by));
  return (
    <section aria-label="Calendar" className="cal-wrap">
      <div className="row">
        <button type="button" aria-label="Previous month" onClick={() => go(-1)}>‹</button>
        <h3 className="cal-title" aria-live="polite">{monthTitle(ym.year, ym.month0)}</h3>
        <button type="button" aria-label="Next month" onClick={() => go(1)}>›</button>
        <button type="button" onClick={() => setYm({ year: y0, month0: m0 - 1 })}>Today</button>
        <label className="inline"><span className="muted small">Whose</span>
          <select value={who} onChange={(e) => setWho(e.target.value as 'all' | 'me')} aria-label="Whose work"><option value="all">Everyone’s</option><option value="me">Mine</option></select>
        </label>
        <label className="inline small muted"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Finished work</label>
      </div>
      <div className="cal-body">
        <table className="cal" aria-label={monthTitle(ym.year, ym.month0)}>
          <thead><tr>{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <th key={d} scope="col">{d}</th>)}</tr></thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w[0]}>
                {w.map((d) => {
                  const inMonth = Number(d.slice(5, 7)) - 1 === ym.month0;
                  const items = days.get(d) ?? [];
                  return (
                    <td key={d} className={`${inMonth ? '' : 'out'}${d === plan.today ? ' today' : ''}`} aria-label={d}>
                      <span className="cal-day">{Number(d.slice(8))}</span>
                      <ul className="plain">
                        {items.slice(0, 4).map((t) => (
                          <li key={t.id}>
                            <button type="button" className={`cal-item${t.kind === 'deadline' ? ' deadline' : ''}${t.state !== 'open' ? ' done' : ''}${t.state === 'open' && t.due! < plan.today ? ' late' : ''}`} title={`${t.title} · ${t.projectName}${t.assigneeId ? ` · ${nameOf(t.assigneeId)}` : ''}`} onClick={() => onProject(t.projectId)}>
                              {t.kind === 'deadline' ? '◆ ' : ''}{t.title}
                            </button>
                          </li>
                        ))}
                        {items.length > 4 && <li className="muted small">+{items.length - 4} more</li>}
                      </ul>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <aside className="cal-side" aria-label="Late and unscheduled">
          <h4>Late <span className="count">{late.length}</span></h4>
          {late.length === 0 && <p className="muted small">Nothing is late.</p>}
          <ul className="plain">{late.map((t) => <li key={t.id}><button type="button" className="link" onClick={() => onProject(t.projectId)}>{t.title}</button> <span className="warn small">{relativeDay(t.due!, plan.today)}</span> <span className="muted small">{t.projectName}</span></li>)}</ul>
          <h4>No date <span className="count">{undated.length}</span></h4>
          <ul className="plain">{undated.slice(0, 20).map((t) => <li key={t.id}><button type="button" className="link" onClick={() => onProject(t.projectId)}>{t.title}</button> <span className="muted small">{t.projectName}</span></li>)}</ul>
        </aside>
      </div>
    </section>
  );
}
