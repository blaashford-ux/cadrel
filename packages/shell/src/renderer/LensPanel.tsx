import { useEffect, useState } from 'react';
import type { LensDue, LensPass, LensState, Page } from '../shared/api';

const api = window.cadrel;
type Lens = 'director' | 'editor' | 'author' | 'art';
const LABEL: Record<Lens, string> = { director: 'Director', editor: 'Editor', author: 'Author', art: 'Art' };
const KEY = 'cadrel.lens';
const days = (n: number | null) => (n === null ? '' : n <= 0 ? 'today' : n === 1 ? '1 day' : `${n} days`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const KIND: Record<LensPass['kind'], string> = { developmental: 'developmental', line: 'line', copy: 'copy', proof: 'proof' };

/** The lens last chosen on this computer, if it is still one this person has. A convenience only: what is shown is always limited to what the roles allow. */
function remembered(lenses: Lens[]): Lens {
  try {
    const v = localStorage.getItem(KEY) as Lens | null;
    if (v && lenses.includes(v)) return v;
  } catch {
    /* no storage: the first lens is the default */
  }
  return lenses[0]!;
}

/**
 * What a person's working role leads with, above the rest of Home and the Dashboard: a Director sees late books and queries waiting on authors, an
 * Editor their passes, an Author what waits for their answer. It is derived from what their roles hold, so a person with no working view sees
 * nothing here and the page is as it always was. The Owner starts on the Director's view and can switch.
 */
export function LensPanel({ onGo, onProject, studioKey }: { onGo: (p: Page) => void; onProject: (id: string) => void; studioKey?: unknown }) {
  const [state, setState] = useState<LensState | null>(null);
  const [pick, setPick] = useState<Lens | null>(null);
  useEffect(() => {
    let live = true;
    void api.lens.state().then((s) => live && setState(s), () => live && setState(null));
    return () => { live = false; };
  }, [studioKey]);
  if (!state || !state.available || state.lenses.length === 0) return null;
  const lens = pick && state.lenses.includes(pick) ? pick : remembered(state.lenses);
  const choose = (l: Lens) => {
    setPick(l);
    try { localStorage.setItem(KEY, l); } catch { /* not remembered */ }
  };
  const v = state.views;

  return (
    <section className="card wide lens" aria-labelledby="lens-h" data-lens={lens}>
      <div className="card-head">
        <h3 id="lens-h">{LABEL[lens]} view</h3>
        {state.lenses.length > 1 && (
          <div className="seg" role="group" aria-label="Working view">
            {state.lenses.map((l) => <button key={l} type="button" aria-pressed={lens === l} onClick={() => choose(l)}>{LABEL[l]}</button>)}
          </div>
        )}
      </div>

      {lens === 'director' && v.director && v.director.canonWaiting > 0 && (
        <p className="small"><span className="chip warn">{v.director.canonWaiting}</span> canon {v.director.canonWaiting === 1 ? 'proposal is' : 'proposals are'} waiting for you. <button type="button" className="link" onClick={() => onGo('canon')}>Open Canon</button></p>
      )}
      {lens === 'director' && v.director && (
        <div className="lens-cols">
          <div>
            <h4>Late books <span className="chip">{v.director.totals.lateBooks}</span></h4>
            {v.director.lateBooks.length === 0 ? <p className="muted small">No book has a deadline past its date.</p> : (
              <ul className="plain work-list">
                {v.director.lateBooks.map((b) => (
                  <li key={b.projectId}>
                    <button type="button" className="link" onClick={() => onProject(b.projectId)}>{b.name}</button>{' '}
                    <span className="warn small">{plural(b.daysLate, 'day')} late</span>
                    <span className="muted small"> · {b.deadlines.map((d) => `${d.title} (${d.due})`).join(', ')}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h4>Queries waiting on authors <span className="chip">{v.director.totals.unansweredQueries}</span></h4>
            {v.director.unanswered.length === 0 ? <p className="muted small">Every delivered pass has its queries answered.</p> : (
              <ul className="plain work-list">
                {v.director.unanswered.map((u) => (
                  <li key={u.projectId}>
                    <button type="button" className="link" onClick={() => onProject(u.projectId)}>{u.name}</button>{' '}
                    <span className="small">{plural(u.queries, 'query', 'queries')} in {plural(u.passes, 'pass', 'passes')}</span>
                    {u.oldestDays !== null && <span className={u.oldestDays >= 7 ? 'warn small' : 'muted small'}> · longest wait {days(u.oldestDays)}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {lens === 'director' && v.director && v.director.art.inReview > 0 && (
        <p className="small"><span className="chip warn">{v.director.art.inReview}</span> {v.director.art.inReview === 1 ? 'asset is' : 'assets are'} in review, waiting for approval. <button type="button" className="link" onClick={() => onGo('art')}>Open Art</button></p>
      )}
      {lens === 'director' && v.director && v.director.art.notReady.length > 0 && (
        <div>
          <h4>Books not ready to upload <span className="chip">{v.director.art.notReady.length}</span></h4>
          <ul className="plain work-list">
            {v.director.art.notReady.map((n) => (
              <li key={n.fileId}><button type="button" className="link" onClick={() => onProject(n.projectId)}>{n.projectName}</button> <span className="muted small">{n.path}</span> <span className="chip warn">{plural(n.errors, 'error')}</span> <button type="button" className="link" onClick={() => onGo('preflight')}>Open Preflight</button></li>
            ))}
          </ul>
        </div>
      )}
      {lens === 'art' && v.art && (
        <div className="lens-cols">
          <ArtList title="Waiting for approval" rows={v.art.toApprove.map((a) => ({ key: a.assetId, project: a.projectName, projectId: a.projectId, text: a.name }))} empty="No asset is waiting for approval." onProject={onProject} onGo={() => onGo('art')} />
          <ArtList title="Concepts to look at" rows={v.art.concepts.map((c) => ({ key: c.briefId, project: c.projectName, projectId: c.projectId, text: c.title, chip: plural(c.waiting, 'concept') }))} empty="No concept is waiting for a decision." onProject={onProject} onGo={() => onGo('art')} />
          <ArtList title="Licences to renew" rows={v.art.licences.map((l) => ({ key: l.assetId, project: l.projectName, projectId: l.projectId, text: l.name, chip: l.days < 0 ? `ran out ${plural(-l.days, 'day')} ago` : `${plural(l.days, 'day')} left`, warn: l.days <= 14 }))} empty="No licence runs out soon." onProject={onProject} onGo={() => onGo('art')} />
          <ArtList title="Uses to update" rows={v.art.toUpdate.map((u) => ({ key: u.assetId, project: u.projectName, projectId: u.projectId, text: u.name, chip: plural(u.uses, 'use') }))} empty="Nothing waits on a new version." onProject={onProject} onGo={() => onGo('art')} />
        </div>
      )}
      {lens === 'editor' && v.editor && (
        <div className="lens-cols">
          <PassList title="To start" rows={v.editor.toStart} empty="No pass is waiting for you to start it." onGo={onGo} />
          <PassList title="To deliver" rows={v.editor.toDeliver} empty="Nothing under way." onGo={onGo} />
          <PassList title="With the author" rows={v.editor.withAuthor} empty="No delivered pass is waiting on an author." onGo={onGo} wait />
          {v.editor.answered > 0 && <p className="small"><span className="chip">{v.editor.answered}</span> {v.editor.answered === 1 ? 'answer' : 'answers'} from authors to look at. <button type="button" className="link" onClick={() => onGo('editing')}>Open Editing</button></p>}
        </div>
      )}

      {lens === 'author' && v.author && (
        <div className="lens-cols">
          <PassList title="Queries to answer" rows={v.author.answer} empty="No query is waiting for your answer." onGo={onGo} wait author />
          <PassList title="Ready to send back" rows={v.author.respond} empty="Nothing is ready to send back." onGo={onGo} />
          <div>
            <h4>Your dates</h4>
            {v.author.tasks.length === 0 ? <p className="muted small">Nothing late or due this week.</p> : <ul className="plain work-list">{v.author.tasks.map((t) => <DueRow key={t.id} t={t} onProject={onProject} />)}</ul>}
          </div>
        </div>
      )}
    </section>
  );
}

function PassList({ title, rows, empty, onGo, wait, author }: { title: string; rows: LensPass[]; empty: string; onGo: (p: Page) => void; wait?: boolean; author?: boolean }) {
  return (
    <div>
      <h4>{title} <span className="chip">{rows.length}</span></h4>
      {rows.length === 0 ? <p className="muted small">{empty}</p> : (
        <ul className="plain work-list">
          {rows.map((p) => (
            <li key={p.passId}>
              <button type="button" className="link" onClick={() => onGo('editing')}>{p.projectName}</button> <span className="chip">{KIND[p.kind]}</span>
              <span className="muted small"> · {author ? p.editorName : p.title}</span>
              {author && p.unanswered > 0 && <span className="small"> · {plural(p.unanswered, 'query', 'queries')}</span>}
              {author && p.undecided > 0 && <span className="small"> · {plural(p.undecided, 'suggestion')} to decide</span>}
              {wait && p.waitingDays !== null && <span className={p.waitingDays >= 7 ? 'warn small' : 'muted small'}> · waiting {days(p.waitingDays)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DueRow({ t, onProject }: { t: LensDue; onProject: (id: string) => void }) {
  return (
    <li>
      <button type="button" className="link" onClick={() => onProject(t.projectId)}>{t.title}</button> <span className="muted small">on {t.projectName}</span>
      <span className={t.daysLate > 0 ? 'warn small' : 'muted small'}> · {t.daysLate > 0 ? `${plural(t.daysLate, 'day')} late` : `due ${t.due}`}</span>
    </li>
  );
}

function ArtList({ title, rows, empty, onProject, onGo }: { title: string; rows: { key: string; project: string; projectId: string; text: string; chip?: string; warn?: boolean }[]; empty: string; onProject: (id: string) => void; onGo: () => void }) {
  return (
    <div>
      <h4>{title} <span className="chip">{rows.length}</span></h4>
      {rows.length === 0 ? <p className="muted small">{empty}</p> : (
        <ul className="plain work-list">
          {rows.map((r) => (
            <li key={r.key}>
              <button type="button" className="link" onClick={onGo}>{r.text}</button> <button type="button" className="link muted small" onClick={() => onProject(r.projectId)}>{r.project}</button>
              {r.chip && <span className={`chip ${r.warn ? 'warn' : ''}`}>{r.chip}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
