import { useMemo, useState } from 'react';
import { outline, subtreeIds, getProject, inViewScope } from '@cadrel/kernel';
import type { ModuleId, StudioState } from '../shared/api';
import { NotesPanel } from '@cadrel/ui';
import { projectNotes } from './Projects';
import { ScopeToggle, usePageScope } from './PageScope';

interface Props {
  studio: StudioState | null;
  error: string | null;
  act: <T>(job: () => Promise<T>) => Promise<{ ok: boolean }>;
  onGo: (m: ModuleId) => void;
}

/** Every note in the studio, from every module, in one list; narrow it to one project (and its subprojects) with the picker. */
export function Notes({ studio, error, act, onGo }: Props) {
  const [project, setProject] = useState('');
  const ps = usePageScope('notes');
  const shown = useMemo(() => {
    if (!studio) return [];
    // Only the Project in scope: its notes, its Books', and (with a Book chosen) the series' own.
    if (ps.scope) return studio.notes.filter((n) => inViewScope(studio.tree, ps.scope!, n.projectId ?? null));
    if (!project) return studio.notes;
    const ids = new Set(subtreeIds(studio.tree, project));
    return studio.notes.filter((n) => n.projectId && ids.has(n.projectId));
  }, [studio, project, ps.scope]);
  if (!studio) return <p className="muted">Loading…</p>;
  const rows = outline(studio.tree);
  const name = (id: string) => getProject(studio.tree, id)?.name ?? null;
  return (
    <div className="notes-page">
      <p className="muted">Comments and suggestions from every part of Cadrel: left by you, by reviewers, and by AI. Notes in a manuscript are changed in Write; the rest are changed here.</p>
      {error && <div className="banner error" role="alert">{error}</div>}
      <div className="row">
        <ScopeToggle s={ps} />
        {!ps.on && <label className="inline">
          <span className="muted small">Project</span>
          <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
            <option value="">Everything</option>
            {rows.map((r) => <option key={r.project.id} value={r.project.id}>{' '.repeat(r.depth)}{r.project.name}</option>)}
          </select>
        </label>}
        {ps.on && studio.notes.length > shown.length && (
          <span className="muted small">{studio.notes.length - shown.length} more belong to other projects or to none. <button type="button" className="link" onClick={() => ps.setMode('all')}>Show everything</button></span>
        )}
      </div>
      <section className="card">
        <NotesPanel
          notes={shown}
          api={projectNotes(ps.scope ? ps.scope.book ?? ps.scope.project : project || null)}
          addTo={{ label: ps.scope ? ps.title : project ? name(project) ?? 'this project' : 'the studio' }}
          projectName={name}
          act={act}
          onOpenModule={(m) => onGo(m as ModuleId)}
        />
      </section>
    </div>
  );
}
