import type { Overview, Page } from '../shared/api';
import { captureState } from './capture';
import { ago, formatWords, greeting, percent, STATUS_LABEL } from './format';

interface Props {
  overview: Overview | null;
  onGo: (p: Page) => void;
}

export function Home({ overview, onGo }: Props) {
  const now = Date.now();
  const recent = overview?.write.projects.find((p) => !p.archived);
  const pct = recent ? percent(recent.words, recent.goalWords) : null;
  const m = overview?.market;

  return (
    <div className="home">
      <h2 className="hello">{greeting(new Date().getHours())}</h2>
      <p className="muted">Here is where your studio stands.</p>

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
              {formatWords(recent.words)} words · edited {ago(recent.lastEdited, now)}
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
    </div>
  );
}
