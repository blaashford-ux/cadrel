import { useEffect, useMemo, useState } from 'react';
import {
  KIND_SUGGESTIONS, ancestorsOf, childrenOf, getProject, kindLabel, linksOf, outline, queryNotes, subtreeIds, type Project, type ProjectTree
} from '@cadrel/kernel';
import type { NotesApi } from '@cadrel/ui';
import type { ModuleId, Overview, StudioState } from '../shared/api';
import { NotesPanel } from '@cadrel/ui';
import { ago, formatWords, percent, STATUS_LABEL } from './format';
import { factsFor } from './projectFacts';

const api = window.cadrel.studio;

/** The shared Notes panel's view of the studio, for notes written on one project. */
export const projectNotes = (projectId: string | null): NotesApi => ({
  add: (o) => api.addNote({ projectId, ...o }),
  setStatus: api.setNoteStatus,
  reply: api.replyToNote,
  remove: api.deleteNote
});

interface Props {
  studio: StudioState | null;
  overview: Overview | null;
  error: string | null;
  clearError: () => void;
  act: <T>(job: () => Promise<T>) => Promise<{ ok: true; value: T } | { ok: false }>;
  onGo: (m: ModuleId) => void;
  /** Remembered between visits by the app. */
  selected: string | null;
  onSelect: (id: string | null) => void;
}

type Dialog = { kind: 'new'; parentId: string | null } | { kind: 'rename'; id: string } | { kind: 'delete'; id: string } | null;

function NameDialog({ title, initialName, initialKind, askKind, action, onSubmit, onCancel }: { title: string; initialName: string; initialKind: string; askKind: boolean; action: string; onSubmit(name: string, kind: string): void; onCancel(): void }) {
  const [name, setName] = useState(initialName);
  const [kind, setKind] = useState(initialKind);
  return (
    <div className="modal-backdrop" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <form className="modal" role="dialog" aria-modal="true" aria-label={title} onSubmit={(e) => (e.preventDefault(), onSubmit(name, kind))}>
        <h3>{title}</h3>
        <label className="field">
          <span className="field-label">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} />
        </label>
        {askKind && (
          <label className="field">
            <span className="field-label">Kind (optional)</span>
            <input list="project-kinds" value={kind} onChange={(e) => setKind(e.target.value)} maxLength={30} placeholder="Series, Book, Campaign…" />
            <datalist id="project-kinds">{KIND_SUGGESTIONS.map((k) => <option key={k} value={k} />)}</datalist>
            <span className="field-hint">A label for you. A project can hold subprojects whatever it is called.</span>
          </label>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary" disabled={!name.trim()}>{action}</button>
        </div>
      </form>
    </div>
  );
}

/** Everything a project can be moved under: not itself, not anything inside it, and nothing archived. */
function moveTargets(tree: ProjectTree, id: string): { id: string | null; label: string }[] {
  const inside = new Set(subtreeIds(tree, id));
  return [{ id: null, label: 'Top level' }, ...outline(tree).filter((r) => !inside.has(r.project.id)).map((r) => ({ id: r.project.id, label: `${' '.repeat(r.depth)}${r.project.name}` }))];
}

function Detail({ p, studio, overview, act, onGo, onSelect, openDialog }: { p: Project; studio: StudioState; overview: Overview | null; act: Props['act']; onGo: Props['onGo']; onSelect: Props['onSelect']; openDialog: (d: Dialog) => void }) {
  const tree = studio.tree;
  const facts = factsFor(tree, overview, p.id);
  const pct = percent(facts.words, facts.goalWords);
  const path = [...ancestorsOf(tree, p.id), p];
  const subs = childrenOf(tree, p.id);
  const mine = linksOf(tree, p.id);
  const ids = useMemo(() => subtreeIds(tree, p.id), [tree, p.id]);
  const notes = useMemo(() => queryNotes(studio.notes, { projectIds: ids, status: 'any' }), [studio.notes, ids]);
  const nameOf = (id: string) => getProject(tree, id)?.name ?? null;

  const takenWrite = new Set(tree.links.filter((l) => l.module === 'write').map((l) => l.ref));
  const takenMarket = new Set(tree.links.filter((l) => l.module === 'market').map((l) => l.ref));
  const freeWrite = (overview?.write.projects ?? []).filter((w) => !takenWrite.has(w.name));
  const freeMarket = (overview?.market.categories ?? []).filter((c) => !takenMarket.has(c.key));
  const [pick, setPick] = useState('');
  useEffect(() => setPick(''), [p.id]);

  const link = () => {
    const [module, ref] = [pick.slice(0, pick.indexOf(':')), pick.slice(pick.indexOf(':') + 1)];
    if (module && ref) void act(() => api.link(p.id, module, ref)).then(() => setPick(''));
  };
  const labelOf = (module: string, ref: string) => (module === 'market' ? overview?.market.categories.find((c) => c.key === ref)?.name ?? ref : ref);

  return (
    <div className="project-detail">
      <nav className="crumbs" aria-label="Where this project sits">
        {path.map((x, i) => (
          <span key={x.id}>
            {i > 0 && <span aria-hidden> / </span>}
            {x.id === p.id ? <strong>{x.name}</strong> : <button type="button" className="link" onClick={() => onSelect(x.id)}>{x.name}</button>}
          </span>
        ))}
      </nav>
      <div className="row title-row">
        <h2>{p.name}</h2>
        <span className="chip">{kindLabel(tree, p)}</span>
        {p.status === 'archived' && <span className="chip">archived</span>}
      </div>

      <div className="actions">
        <button type="button" className="primary" disabled={p.status === 'archived'} onClick={() => openDialog({ kind: 'new', parentId: p.id })}>Add subproject</button>
        <button type="button" onClick={() => openDialog({ kind: 'rename', id: p.id })}>Rename</button>
        <label className="inline">
          <span className="muted small">Move to</span>
          <select
            value=""
            aria-label="Move to"
            onChange={(e) => {
              const v = e.target.value;
              if (v !== '') void act(() => api.moveProject(p.id, v === '__top' ? null : v));
            }}
          >
            <option value="">Choose…</option>
            {moveTargets(tree, p.id).filter((t) => t.id !== p.parentId).map((t) => <option key={t.id ?? 'top'} value={t.id ?? '__top'}>{t.label}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => void act(() => api.archiveProject(p.id, p.status !== 'archived'))}>{p.status === 'archived' ? 'Restore' : 'Archive'}</button>
        <button type="button" className="quiet" onClick={() => openDialog({ kind: 'delete', id: p.id })}>Delete…</button>
      </div>

      <section className="card" aria-labelledby="pd-sum">
        <h3 id="pd-sum">At a glance</h3>
        <p className="stats">
          <span><strong>{formatWords(facts.words)}</strong> words{facts.manuscripts > 1 ? ` across ${facts.manuscripts} manuscripts` : ''}</span>
          <span><strong>{subs.length}</strong> subproject{subs.length === 1 ? '' : 's'}</span>
          <span><strong>{studio.openByProject[p.id] ?? 0}</strong> open note{(studio.openByProject[p.id] ?? 0) === 1 ? '' : 's'}</span>
          {facts.lastEdited !== null && <span>edited {ago(facts.lastEdited, Date.now())}</span>}
        </p>
        {pct !== null && (
          <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${p.name} progress toward its word goal`}><span style={{ width: `${pct}%` }} /></div>
        )}
        {subs.length > 0 && (
          <ul className="subs">
            {subs.map((s) => {
              const f = factsFor(tree, overview, s.id);
              return (
                <li key={s.id} className={s.status === 'archived' ? 'archived' : ''}>
                  <button type="button" className="link" onClick={() => onSelect(s.id)}>{s.name}</button>
                  <span className="chip">{kindLabel(tree, s)}</span>
                  <span className="muted small">{formatWords(f.words)} words{studio.openByProject[s.id] ? ` · ${studio.openByProject[s.id]} open note${studio.openByProject[s.id] === 1 ? '' : 's'}` : ''}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="pd-links">
        <h3 id="pd-links">What belongs to it</h3>
        {mine.length === 0 && <p className="muted">Nothing is linked yet. Link a manuscript from Write or a category from Market, and it counts toward this project.</p>}
        <ul className="links">
          {mine.map((l) => {
            const w = l.module === 'write' ? overview?.write.projects.find((x) => x.name === l.ref) : undefined;
            const gone = l.module === 'write' ? !!overview?.write.ok && !w : l.module === 'market' ? !!overview?.market.ok && !!overview.market.libraryRoot && !overview.market.categories.some((c) => c.key === l.ref) : false;
            return (
              <li key={`${l.module}:${l.ref}`}>
                <span className="chip">{l.module === 'write' ? 'Manuscript' : 'Market category'}</span>
                <strong>{labelOf(l.module, l.ref)}</strong>
                {w && <span className="muted small">{STATUS_LABEL[w.status] ?? w.status} · {w.words === null ? 'no active manuscript' : `${formatWords(w.words)} words`}</span>}
                {gone && <span className="warn small">not found any more</span>}
                <button type="button" className="link" onClick={() => onGo(l.module as ModuleId)}>Open {l.module === 'write' ? 'Write' : 'Market'}</button>
                <button type="button" className="quiet" onClick={() => void act(() => api.unlink(l.module, l.ref))}>Unlink</button>
              </li>
            );
          })}
        </ul>
        <div className="row">
          <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Link to this project">
            <option value="">Link a manuscript or category…</option>
            {freeWrite.length > 0 && <optgroup label="Manuscripts (Write)">{freeWrite.map((w) => <option key={w.name} value={`write:${w.name}`}>{w.name}</option>)}</optgroup>}
            {freeMarket.length > 0 && <optgroup label="Market categories">{freeMarket.map((c) => <option key={c.key} value={`market:${c.key}`}>{c.name}</option>)}</optgroup>}
          </select>
          <button type="button" disabled={!pick} onClick={link}>Link</button>
        </div>
        <p className="muted small">A manuscript or category belongs to one project. Linking it here moves it from wherever it was.</p>
      </section>

      <section className="card" aria-labelledby="pd-notes">
        <h3 id="pd-notes">Notes{subs.length ? ' (this project and its subprojects)' : ''}</h3>
        <NotesPanel notes={notes} api={projectNotes(p.id)} addTo={{ label: p.name }} projectName={nameOf} act={act} onOpenModule={(m) => onGo(m as ModuleId)} />
      </section>
    </div>
  );
}

export function Projects({ studio, overview, error, clearError, act, onGo, selected, onSelect }: Props) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [archived, setArchived] = useState(false);

  const rows = useMemo(() => (studio ? outline(studio.tree, { archived }) : []), [studio, archived]);
  const current = studio && selected ? getProject(studio.tree, selected) : undefined;
  // If the remembered project is gone (deleted elsewhere), fall back to the first one.
  useEffect(() => {
    if (studio && selected && !current) onSelect(null);
  }, [studio, selected, current, onSelect]);

  if (!studio) return <p className="muted">Loading…</p>;
  const active = current ?? (rows[0]?.project as Project | undefined);

  const submit = async (name: string, kind: string) => {
    const d = dialog;
    if (!d) return;
    if (d.kind === 'new') {
      const r = await act(() => api.createProject({ name, parentId: d.parentId, kind: kind || undefined }));
      if (r.ok) {
        onSelect(r.value.id);
        setDialog(null);
      }
    } else if (d.kind === 'rename') {
      const r = await act(() => api.updateProject(d.id, { name }));
      if (r.ok) setDialog(null);
    }
  };

  const del = dialog?.kind === 'delete' ? getProject(studio.tree, dialog.id) : undefined;
  const delKids = del ? subtreeIds(studio.tree, del.id).length - 1 : 0;

  return (
    <div className="projects">
      <aside className="tree-pane" aria-label="Projects">
        <div className="tree-head">
          <button type="button" className="primary" onClick={() => setDialog({ kind: 'new', parentId: null })}>New project</button>
          <label className="inline small muted"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Archived</label>
        </div>
        {rows.length === 0 ? (
          <div className="empty">
            <p><strong>Start with a project.</strong></p>
            <p className="muted">A project is whatever you are building: usually a series, with each book as a subproject. Manuscripts, market research and notes all hang from it.</p>
          </div>
        ) : (
          <ul className="tree" role="tree">
            {rows.map(({ project: p, depth }) => (
              <li key={p.id} role="treeitem" aria-selected={active?.id === p.id} aria-level={depth + 1}>
                <button type="button" className={`tree-row${active?.id === p.id ? ' active' : ''}${p.status === 'archived' ? ' archived' : ''}`} style={{ paddingLeft: 10 + depth * 18 }} onClick={() => onSelect(p.id)}>
                  <span className="tree-name">{p.name}</span>
                  {studio.openByProject[p.id] ? <span className="count" title="Open notes">{studio.openByProject[p.id]}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <section className="detail-pane">
        {error && (
          <div className="banner error" role="alert">
            {error} <button type="button" onClick={clearError}>Dismiss</button>
          </div>
        )}
        {active ? <Detail p={active} studio={studio} overview={overview} act={act} onGo={onGo} onSelect={onSelect} openDialog={setDialog} /> : <p className="muted pad">Create a project to begin.</p>}
      </section>

      {dialog && dialog.kind !== 'delete' && (
        <NameDialog
          key={dialog.kind + (dialog.kind === 'rename' ? dialog.id : (dialog.parentId ?? ''))}
          title={dialog.kind === 'rename' ? 'Rename project' : dialog.parentId ? `New subproject of ${getProject(studio.tree, dialog.parentId)?.name}` : 'New project'}
          initialName={dialog.kind === 'rename' ? getProject(studio.tree, dialog.id)?.name ?? '' : ''}
          initialKind=""
          askKind={dialog.kind === 'new'}
          action={dialog.kind === 'rename' ? 'Rename' : 'Create'}
          onSubmit={(n, k) => void submit(n, k)}
          onCancel={() => setDialog(null)}
        />
      )}
      {del && (
        <div className="modal-backdrop" onKeyDown={(e) => e.key === 'Escape' && setDialog(null)}>
          <div className="modal" role="alertdialog" aria-modal="true" aria-label="Delete project">
            <h3>Delete “{del.name}”?</h3>
            <p>
              {delKids > 0 ? `This also deletes its ${delKids} subproject${delKids === 1 ? '' : 's'}, ` : 'This '}and every note written on {delKids > 0 ? 'them' : 'it'}. Manuscripts and market research are not touched; they just stop belonging to a project.
            </p>
            <p className="muted small">Archive instead if you may want it back.</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setDialog(null)} autoFocus>Keep it</button>
              <button type="button" className="danger" onClick={() => void act(() => api.deleteProject(del.id, true)).then((r) => r.ok && (setDialog(null), onSelect(null)))}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
