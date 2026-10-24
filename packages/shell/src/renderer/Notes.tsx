import { useMemo, useState } from 'react';
import { outline, subtreeIds, getProject } from '@cadrel/kernel';
import type { ModuleId, StudioState } from '../shared/api';
import { NotesPanel } from './NotesPanel';

interface Props {
  studio: StudioState | null;
  error: string | null;
  act: <T>(job: () => Promise<T>) => Promise<{ ok: boolean }>;
  onGo: (m: ModuleId) => void;
}

/** Every note in the studio, from every module, in one list; narrow it to one project (and its subprojects) with the picker. */
export function Notes({ studio, error, act, onGo }: Props) {
  const [project, setProject] = useState('');
  const shown = useMemo(() => {
    if (!studio) return [];
    if (!project) return studio.notes;
    const ids = new Set(subtreeIds(studio.tree, project));
    return studio.notes.filter((n) => n.projectId && ids.has(n.projectId));
  }, [studio, project]);
  if (!studio) return <p className="muted">Loading…</p>;
  const rows = outline(studio.tree);
  const name = (id: string) => getProject(studio.tree, id)?.name ?? null;
  return (
    <div className="notes-page">
      <p className="muted">Comments and suggestions from every part of Cadrel: left by you, by reviewers, and by AI. Notes in a manuscript are changed in Write; the rest are changed here.</p>
      {error && <div className="banner error" role="alert">{error}</div>}
      <div className="row">
        <label className="inline">
          <span className="muted small">Project</span>
          <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
            <option value="">Everything</option>
            {rows.map((r) => <option key={r.project.id} value={r.project.id}>{' '.repeat(r.depth)}{r.project.name}</option>)}
          </select>
        </label>
      </div>
      <section className="card">
        <NotesPanel
          notes={shown}
          addTo={{ projectId: project || null, label: project ? name(project) ?? 'this project' : 'the studio' }}
          projectName={name}
          act={act}
          onOpenModule={(m) => onGo(m as ModuleId)}
        />
      </section>
    </div>
  );
}
