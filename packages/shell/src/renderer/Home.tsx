import { childrenOf, kindLabel } from '@cadrel/kernel';
import type { Overview, Page, StudioState, StudiosView } from '../shared/api';
import { captureState } from './capture';
import { ago, formatWords, greeting, percent, STATUS_LABEL, wordsLabel } from './format';
import { factsFor } from './projectFacts';
import { NotConnected } from './NotConnected';
import { StudioSwitcher } from './StudioSwitcher';

interface Props {
  overview: Overview | null;
  studio: StudioState | null;
  onGo: (p: Page) => void;
  onProject: (id: string) => void;
  studios: StudiosView | null;
}

export function Home({ overview, studio, onGo, onProject, studios }: Props) {
  const now = Date.now();
  const recent = overview?.write.projects.find((p) => !p.archived);
  const pct = recent ? percent(recent.words, recent.goalWords) : null;
  const m = overview?.market;
  const top = studio ? childrenOf(studio.tree, null).filter((p) => p.status !== 'archived') : [];

  return (
    <div className="home">
      {studios && <StudioSwitcher studios={studios} />}
      {studios && !studios.connected && <NotConnected studio={studios.studios.find((s) => s.id === studios.activeId)!} />}
      {(!studios || studios.connected) && renderBody()}
    </div>
  );

  function renderBody() {
    return (
    <>
      <h2 className="hello">{greeting(new Date().getHours())}</h2>
      <p className="muted">Here is where your studio stands.</p>

      <section className="card" aria-labelledby="h-projects">
        <div className="card-head">
          <h3 id="h-projects">Your projects</h3>
          <button type="button" className="link" onClick={() => onGo('projects')}>All projects</button>
        </div>
        {!studio && <p className="muted">Loading…</p>}
        {studio && top.length === 0 && (
          <>
            <p className="muted">Projects are how Cadrel is organised: usually a series, with each book a subproject. Manuscripts, market research and notes hang from them.</p>
            <button type="button" className="primary" onClick={() => onGo('projects')}>Create your first project</button>
          </>
        )}
        {studio && top.length > 0 && (
          <ul className="project-list">
            {top.map((p) => {
              const f = factsFor(studio.tree, overview, p.id);
              const subs = childrenOf(studio.tree, p.id).filter((s) => s.status !== 'archived');
              const open = studio.openByProject[p.id] ?? 0;
              return (
                <li key={p.id}>
                  <button type="button" className="link" onClick={() => onProject(p.id)}>{p.name}</button>
                  <span className="chip">{kindLabel(studio.tree, p)}</span>
                  <span className="muted small">
                    {subs.length ? `${subs.length} subproject${subs.length === 1 ? '' : 's'} · ` : ''}
                    {formatWords(f.words)} words{open ? ` · ${open} open note${open === 1 ? '' : 's'}` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="h-write">
        <h3 id="h-write">Continue writing</h3>
        {!overview && <p className="muted">Loading…</p>}
        {overview && !overview.write.ok && <p className="warn">Write could not be read: {overview.write.error}</p>}
        {overview?.write.ok && !recent && (
          <>
            <p className="muted">No projects yet. A project is a folder for one book, with room for the manuscript, characters, and research.</p>
            <button type="button" className="primary" onClick={() => onGo('write')}>Open Write to start one</button>
          </>
        )}
        {recent && (
          <>
            <div className="row">
              <strong className="project-name">{recent.name}</strong>
              <span className="chip">{STATUS_LABEL[recent.status] ?? recent.status}</span>
            </div>
            <p className="muted">
              {wordsLabel(recent.words)} · edited {ago(recent.lastEdited, now)}
            </p>
            {pct !== null && (
              <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${recent.name} progress toward its word goal`}>
                <span style={{ width: `${pct}%` }} />
              </div>
            )}
            <button type="button" className="primary" onClick={() => onGo('write')}>Open Write</button>
          </>
        )}
      </section>

      <section className="card" aria-labelledby="h-market">
        <h3 id="h-market">Market research</h3>
        {!m && <p className="muted">Loading…</p>}
        {m && !m.ok && <p className="warn">Market could not be read: {m.error}</p>}
        {m?.ok && (
          <>
            <p>
              <span className={`dot ${captureState(m).tone}`} aria-hidden /> {captureState(m).text}
            </p>
            {m.libraryRoot ? (
              <p className="muted">
                {m.categories.length} categor{m.categories.length === 1 ? 'y' : 'ies'} tracked · {m.queued} book{m.queued === 1 ? '' : 's'} waiting to be captured
              </p>
            ) : (
              <p className="muted">No library chosen yet. Choose a folder in Market to start keeping what you capture.</p>
            )}
            <button type="button" className="primary" onClick={() => onGo('market')}>Open Market</button>
          </>
        )}
      </section>

      <p className="muted small">
        <button type="button" className="link" onClick={() => onGo('dashboard')}>See the whole studio on the Dashboard</button>
      </p>
    </>
    );
  }
}
