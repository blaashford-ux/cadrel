import { useEffect, useState } from 'react';
import type { Page, ProjectStageView, Pulse, PulseTask } from '../shared/api';
import { relativeDay } from './calendar';

type Ready = Extract<Pulse, { available: true }>;

/** Reads the pulse of the studio; reloads when `studio` (the project tree and notes) changes. */
export function usePulse(studio: unknown): Pulse | null {
  const [p, setP] = useState<Pulse | null>(null);
  useEffect(() => {
    let live = true;
    void window.cadrel.work.pulse().then((x) => live && setP(x), () => live && setP(null));
    return () => {
      live = false;
    };
  }, [studio]);
  return p;
}

/** Every project's stage by project id, reloaded when the studio changes. */
export function useStages(studio: unknown): Record<string, ProjectStageView> {
  const [v, setV] = useState<Record<string, ProjectStageView>>({});
  useEffect(() => {
    let live = true;
    void window.cadrel.stages.views().then((x) => live && setV(x), () => undefined);
    return () => {
      live = false;
    };
  }, [studio]);
  return v;
}

export function StageTag({ view }: { view: ProjectStageView | undefined }) {
  const s = view?.stage;
  return s ? <span className="stage-chip small" style={{ borderColor: s.color, color: s.color }}>{s.name}</span> : null;
}

const usd = (v: number) => v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

function Stat({ n, label, tone, onClick }: { n: number | string; label: string; tone?: 'warn'; onClick?: () => void }) {
  const inner = (<><strong className={tone === 'warn' && n !== 0 ? 'warn' : undefined}>{n}</strong> <span className="muted small">{label}</span></>);
  return onClick ? <button type="button" className="stat link" onClick={onClick}>{inner}</button> : <span className="stat">{inner}</span>;
}

function TaskRow({ t, today, onProject }: { t: PulseTask; today: string; onProject: (id: string) => void }) {
  const late = t.due !== null && t.due < today;
  return (
    <li>
      <span className="chip">{t.kind}</span> <button type="button" className="link" onClick={() => onProject(t.projectId)}>{t.title}</button> <span className="muted small">on {t.projectName}</span>
      {t.due && <span className={late ? 'warn small' : 'muted small'}> · {relativeDay(t.due, today)}</span>}
    </li>
  );
}

/** The studio's numbers on one line: for Home. */
export function GlanceLine({ pulse, onGo }: { pulse: Pulse | null; onGo: (p: Page) => void }) {
  if (!pulse || !pulse.available) return null;
  const { work, books } = pulse;
  return (
    <p className="stats" aria-label="The studio at a glance">
      <Stat n={work.open} label="open tasks" onClick={() => onGo('planner')} />
      <Stat n={work.late} label="late" tone="warn" onClick={() => onGo('planner')} />
      <Stat n={work.dueSoon} label="due in two weeks" onClick={() => onGo('planner')} />
      {work.approvalsPending > 0 && <Stat n={work.approvalsPending} label="sign-offs waiting" onClick={() => onGo('projects')} />}
      {books.total > 0 && <Stat n={`${books.published}/${books.total}`} label="books published" onClick={() => onGo('mybooks')} />}
    </p>
  );
}

/** The Dashboard's studio-wide cards: work, pipeline, sign-offs, decisions and books, all from the Studio's records. */
export function Glance({ pulse, onGo, onProject }: { pulse: Pulse | null; onGo: (p: Page) => void; onProject: (id: string) => void }) {
  if (!pulse) return <section className="card wide"><p className="muted">Loading…</p></section>;
  if (!pulse.available) return <section className="card wide"><p className="muted">{pulse.reason}</p></section>;
  const p: Ready = pulse;
  const nameOf = (id: string) => p.people.find((x) => x.id === id)?.name ?? 'someone';
  return (
    <>
      <section className="card wide" aria-labelledby="g-work">
        <div className="card-head"><h3 id="g-work">Work</h3><button type="button" className="link" onClick={() => onGo('planner')}>Open the planner</button></div>
        <p className="stats">
          <Stat n={p.work.open} label="open tasks" />
          <Stat n={p.work.late} label="late" tone="warn" />
          <Stat n={p.work.dueSoon} label="due in the next two weeks" />
          <Stat n={p.work.approvalsPending} label="sign-offs waiting" />
          <Stat n={p.work.doneThisWeek} label="finished this week" />
        </p>
        <div className="glance-cols">
          <div>
            <h4>Late</h4>
            {p.late.length === 0 ? <p className="muted small">Nothing is late.</p> : <ul className="plain work-list">{p.late.map((t) => <TaskRow key={t.id} t={t} today={p.today} onProject={onProject} />)}</ul>}
          </div>
          <div>
            <h4>Coming up</h4>
            {p.upcoming.length === 0 ? <p className="muted small">Nothing dated in the next two weeks.</p> : <ul className="plain work-list">{p.upcoming.map((t) => <TaskRow key={t.id} t={t} today={p.today} onProject={onProject} />)}</ul>}
          </div>
          <div>
            <h4>Waiting for a sign-off</h4>
            {p.approvals.length === 0 ? <p className="muted small">None.</p> : (
              <ul className="plain work-list">{p.approvals.map((a) => <li key={a.id}><button type="button" className="link" onClick={() => onProject(a.projectId)}>{a.label}</button> <span className="muted small">on {a.projectName}, waiting for {a.waiting.map(nameOf).join(', ')}</span></li>)}</ul>
            )}
          </div>
        </div>
      </section>

      <section className="card wide" aria-labelledby="g-pipe">
        <div className="card-head"><h3 id="g-pipe">Pipeline</h3><button type="button" className="link" onClick={() => onGo('planner')}>Open the pipeline</button></div>
        {p.pipeline.length === 0 && <p className="muted">No projects yet.</p>}
        {p.pipeline.map((w) => (
          <div key={w.id} className="glance-pipe">
            <p className="muted small">{w.name} · {w.total} project{w.total === 1 ? '' : 's'}</p>
            <ul className="plain stage-strip" aria-label={`${w.name} by stage`}>
              {w.stages.map((s) => (
                <li key={s.key} style={{ borderColor: s.color || undefined }}>
                  <strong>{s.count}</strong> <span className="small">{s.name}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="card wide" aria-labelledby="g-books">
        <div className="card-head"><h3 id="g-books">Books</h3><button type="button" className="link" onClick={() => onGo('mybooks')}>Open My Books</button></div>
        {p.books.total === 0 && p.books.unlisted === 0 ? (
          <p className="muted">No books in the catalogue yet.</p>
        ) : (
          <p className="stats">
            <Stat n={p.books.total} label={`book${p.books.total === 1 ? '' : 's'} in the catalogue`} />
            <Stat n={p.books.published} label="published" />
            <Stat n={p.books.unpublished} label="not published yet" />
            <Stat n={p.books.series} label={`series`} />
            <Stat n={p.books.inProduction} label="in production" />
            {p.books.money && <span className="stat"><strong>{usd(p.books.money.usd)}</strong> <span className="muted small">royalties in {p.books.money.month}{p.books.money.estimated ? ', partly estimated' : ''}</span></span>}
          </p>
        )}
        {p.books.unlisted > 0 && <p className="muted small">{p.books.unlisted} book{p.books.unlisted === 1 ? '' : 's'} from your KDP reports {p.books.unlisted === 1 ? 'is' : 'are'} not in the catalogue yet: <button type="button" className="link" onClick={() => onGo('mybooks')}>add {p.books.unlisted === 1 ? 'it' : 'them'}</button>.</p>}
      </section>

      <section className="card wide" aria-labelledby="g-dec">
        <h3 id="g-dec">Recent decisions</h3>
        {p.decisions.length === 0 ? <p className="muted">None recorded yet. Record what was decided and why on a project’s page.</p> : (
          <ul className="plain">{p.decisions.map((d) => <li key={d.id}><strong>{d.title}</strong>: {d.outcome} <span className="muted small">{d.projectName ? `· ${d.projectName} ` : ''}· {d.decidedAt.slice(0, 10)}</span></li>)}</ul>
        )}
      </section>
    </>
  );
}
