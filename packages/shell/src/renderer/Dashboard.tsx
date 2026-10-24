import { kindLabel, outline } from '@cadrel/kernel';
import type { MarketCategoryRow, Overview, Page, StudioState, WriteProjectRow } from '../shared/api';
import { captureState } from './capture';
import { ago, formatWords, percent, STATUS_LABEL } from './format';
import { factsFor } from './projectFacts';

interface Props {
  overview: Overview | null;
  studio: StudioState | null;
  onGo: (p: Page) => void;
  onProject: (id: string) => void;
}

function ProjectsTable({ rows, now }: { rows: WriteProjectRow[]; now: number }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">Project</th>
          <th scope="col">Status</th>
          <th scope="col" className="num">Words</th>
          <th scope="col">Goal</th>
          <th scope="col">Last edited</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => {
          const pct = percent(p.words, p.goalWords);
          return (
            <tr key={p.name}>
              <th scope="row">{p.name}</th>
              <td>{STATUS_LABEL[p.status] ?? p.status}</td>
              <td className="num">{p.words === null ? <span className="muted">none active</span> : formatWords(p.words)}</td>
              <td>
                {pct === null ? (
                  <span className="muted">no goal</span>
                ) : (
                  <span className="goal">
                    <span className="bar small" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${p.name} goal`}>
                      <span style={{ width: `${pct}%` }} />
                    </span>
                    {pct}%
                  </span>
                )}
              </td>
              <td>{ago(p.lastEdited, now)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CategoriesTable({ rows }: { rows: MarketCategoryRow[] }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">Category</th>
          <th scope="col" className="num">Listed</th>
          <th scope="col" className="num">Captured</th>
          <th scope="col" className="num">List captures</th>
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 8).map((c) => (
          <tr key={c.name}>
            <th scope="row">{c.name}</th>
            <td className="num">{c.listedBooks}</td>
            <td className="num">{c.capturedBooks}</td>
            <td className="num">{c.listCaptures}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Dashboard({ overview, studio, onGo, onProject }: Props) {
  const now = Date.now();
  if (!overview) return <p className="muted">Loading…</p>;
  const { write, market } = overview;
  const live = write.projects.filter((p) => !p.archived);
  const totalWords = live.reduce((n, p) => n + (p.words ?? 0), 0);

  return (
    <div className="dashboard">
      <section className="card wide" aria-labelledby="d-projects">
        <div className="card-head">
          <h3 id="d-projects">Projects</h3>
          <button type="button" className="link" onClick={() => onGo('projects')}>Manage projects</button>
        </div>
        {!studio && <p className="muted">Loading…</p>}
        {studio && studio.tree.projects.length === 0 && <p className="muted">No projects yet. Create one on the Projects page and link your manuscripts and market research to it.</p>}
        {studio && studio.tree.projects.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col" className="num">Words</th>
                <th scope="col">Goal</th>
                <th scope="col" className="num">Open notes</th>
                <th scope="col">Last edited</th>
              </tr>
            </thead>
            <tbody>
              {outline(studio.tree).map(({ project: p, depth }) => {
                const f = factsFor(studio.tree, overview, p.id);
                const pct = percent(f.words, f.goalWords);
                return (
                  <tr key={p.id}>
                    <th scope="row" style={{ paddingLeft: 10 + depth * 20 }}>
                      <button type="button" className="link" onClick={() => onProject(p.id)}>{p.name}</button> <span className="chip">{kindLabel(studio.tree, p)}</span>
                    </th>
                    <td className="num">{formatWords(f.words)}</td>
                    <td>{pct === null ? <span className="muted">no goal</span> : `${pct}%`}</td>
                    <td className="num">{studio.openByProject[p.id] ?? 0}</td>
                    <td>{ago(f.lastEdited, now)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card wide" aria-labelledby="d-write">
        <div className="card-head">
          <h3 id="d-write">Writing</h3>
          <button type="button" className="link" onClick={() => onGo('write')}>Open Write</button>
        </div>
        {!write.ok && <p className="warn">Write could not be read: {write.error}</p>}
        {write.ok && !write.exists && <p className="warn">The projects folder {write.root} cannot be found. Open Write to choose it again.</p>}
        {write.ok && write.exists && live.length === 0 && <p className="muted">No projects yet.</p>}
        {write.ok && live.length > 0 && (
          <>
            <p className="stats">
              <span><strong>{live.length}</strong> project{live.length === 1 ? '' : 's'}</span>
              <span><strong>{formatWords(totalWords)}</strong> words</span>
            </p>
            <ProjectsTable rows={live} now={now} />
          </>
        )}
      </section>

      <section className="card wide" aria-labelledby="d-market">
        <div className="card-head">
          <h3 id="d-market">Market</h3>
          <button type="button" className="link" onClick={() => onGo('market')}>Open Market</button>
        </div>
        {!market.ok && <p className="warn">Market could not be read: {market.error}</p>}
        {market.ok && (
          <>
            <p className="stats">
              <span><span className={`dot ${captureState(market).tone}`} aria-hidden /> {captureState(market).text}</span>
              <span><strong>{market.categories.length}</strong> categories</span>
              <span><strong>{market.queued}</strong> in the capture queue</span>
            </p>
            {!market.libraryRoot && <p className="muted">No library chosen yet.</p>}
            {market.categories.length > 0 && <CategoriesTable rows={market.categories} />}
          </>
        )}
      </section>
    </div>
  );
}
