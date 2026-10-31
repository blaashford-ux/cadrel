import { useEffect, useMemo, useState } from 'react';
import {
  KIND_SUGGESTIONS, ancestorsOf, childrenOf, getProject, kindLabel, linksOf, outline, queryNotes, subtreeIds, viewBooks, viewLevel, type Project, type ProjectTree
} from '@cadrel/kernel';
import type { NotesApi } from '@cadrel/ui';
import { type ManuscriptMeta, type ManuscriptTemplate, type ModuleId, type Overview, type ProjectStageView, type StageMoveOption, type StudioState, type WorkflowState } from '../shared/api';
import type { WorkflowRecord } from '@cadrel/kernel';
import { NotesPanel } from '@cadrel/ui';
import { ago, formatWords, percent } from './format';
import { factsFor } from './projectFacts';
import { WorkCard } from './WorkCard';
import { useScope } from './useScope';

const api = window.cadrel.studio;
const manage = window.cadrel.manage;
const stagesApi = window.cadrel.stages;
const workflowApi = window.cadrel.workflow;

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

function NameDialog({ title, initialName, initialKind, askKind, templates, defaultTemplate, workflows, forBook, action, onSubmit, onCancel }: { title: string; initialName: string; initialKind: string; askKind: boolean; templates?: ManuscriptTemplate[]; defaultTemplate?: string | null; workflows?: WorkflowRecord[]; forBook?: boolean; action: string; onSubmit(name: string, kind: string, template: string | null, workflowId: string | null): void; onCancel(): void }) {
  const [name, setName] = useState(initialName);
  const [kind, setKind] = useState(initialKind);
  const [template, setTemplate] = useState<string>(defaultTemplate ?? '');
  const [workflow, setWorkflow] = useState<string>(workflows?.find((w) => w.defaultFor.includes('subproject'))?.id ?? workflows?.[0]?.id ?? '');
  return (
    <div className="modal-backdrop" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <form className="modal" role="dialog" aria-modal="true" aria-label={title} onSubmit={(e) => (e.preventDefault(), onSubmit(name, kind, template || null, workflow || null))}>
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
            <span className="field-hint">{kind.trim().toLowerCase() === 'standalone' ? 'A standalone novel is a project with one book: the book is made for you, with the folder and the stage.' : 'A label for you. A series holds its books; a project can hold subprojects whatever it is called.'}</span>
          </label>
        )}
        {forBook && workflows && workflows.length > 0 && (
          <label className="field">
            <span className="field-label">Workflow</span>
            <select value={workflow} onChange={(e) => setWorkflow(e.target.value)} aria-label="Workflow">
              {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}{w.defaultFor.includes('subproject') ? ' (default)' : ''}</option>)}
            </select>
            <span className="field-hint">The stages this book moves through. Chosen now, and it can’t be changed afterwards.</span>
          </label>
        )}
        {templates && (
          <label className="field">
            <span className="field-label">Manuscript folder</span>
            <select value={template} onChange={(e) => setTemplate(e.target.value)} aria-label="Manuscript folder">
              <option value="">None yet (just the project)</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}: {t.description}</option>)}
            </select>
            <span className="field-hint">A folder in your Projects folder, set up from this template (the templates are set by your studio’s administrators). Write opens it from here.</span>
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

/** What the project's manuscript folder is: its notes, and the way into Write (which only opens it and lets you write). */
function ManuscriptCard({ p, linked, act }: { p: Project; linked: boolean; act: Props['act'] }) {
  const [m, setM] = useState<{ folder: string; meta: ManuscriptMeta & { templateId: string } } | null | undefined>(undefined);
  const [notes, setNotes] = useState('');
  const [templates, setTemplates] = useState<ManuscriptTemplate[]>([]);
  const [template, setTemplate] = useState('novel');
  const [added, setAdded] = useState('');
  useEffect(() => {
    let live = true;
    setM(undefined);
    setAdded('');
    void manage.manuscript(p.id).then((x) => live && (setM(x), setNotes(x?.meta.notes ?? '')), () => live && setM(null));
    return () => {
      live = false;
    };
  }, [p.id, linked]);
  useEffect(() => {
    void manage.templates().then(setTemplates, () => undefined);
  }, []);

  if (m === undefined) return null;
  if (!m) {
    return (
      <section className="card" aria-labelledby="pd-ms">
        <h3 id="pd-ms">Manuscript folder</h3>
        <p className="muted">This project has no folder to write in yet. Add one and Write can open it.</p>
        <div className="row">
          <select value={template} onChange={(e) => setTemplate(e.target.value)} aria-label="Template for the manuscript folder">
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button type="button" className="primary" onClick={() => void act(() => manage.addManuscript(p.id, template))}>Add a manuscript folder</button>
        </div>
      </section>
    );
  }
  const save = (patch: { notes?: string }) => void act(() => manage.setManuscript(p.id, patch)).then(() => manage.manuscript(p.id).then(setM));
  return (
    <section className="card" aria-labelledby="pd-ms">
      <div className="card-head">
        <h3 id="pd-ms">Manuscript folder</h3>
        <button type="button" className="primary" onClick={() => void act(() => manage.open(p.id))}>Open in Write</button>
      </div>
      <p className="muted small" title={m.folder}>{m.folder} · made from {m.meta.templateName}</p>
      <div className="row">
        <button type="button" onClick={() => void act(() => manage.reveal(p.id))}>Show folder</button>
        <button type="button" title="Create any folders from the template that this project is missing" onClick={() => void act(() => manage.addMissingParts(p.id).then((a) => setAdded(a.length ? `Added ${a.join(', ')}.` : 'Nothing was missing.')))}>Add missing folders</button>
        {added && <span role="status" className="muted small">{added}</span>}
      </div>
      <label className="field">
        <span className="field-label">Notes about the project</span>
        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== m.meta.notes && save({ notes })} placeholder="Where it stands, what comes next…" />
      </label>
    </section>
  );
}

/** Where the project is in the workflow it was made with, and the moves open from here (each checked against the gates). */
function StageCard({ p, studio, act }: { p: Project; studio: StudioState; act: Props['act'] }) {
  const [info, setInfo] = useState<{ workflowName: string; current: ProjectStageView['stage']; options: StageMoveOption[] } | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setInfo(undefined);
    void stagesApi.options(p.id).then((x) => live && setInfo(x), () => live && setInfo(null));
    return () => {
      live = false;
    };
  }, [p.id, p.stage, p.workflowId, studio.notes, studio.tree]);
  if (info === undefined) return null;
  if (!info) return <section className="card" aria-labelledby="pd-stage"><h3 id="pd-stage">Stage</h3><p className="muted">This book has no workflow.</p></section>;
  return (
    <section className="card" aria-labelledby="pd-stage">
      <h3 id="pd-stage">Stage of this book</h3>
      <p className="row">
        {info.current ? <span className="stage-chip" style={{ borderColor: info.current.color, color: info.current.color }}>{info.current.name}</span> : <span className="muted">no stage</span>}
        <span className="muted small">in the “{info.workflowName}” workflow, fixed when the book was made{info.current?.category === 'done' ? ' · closed' : ''}</span>
      </p>
      {info.current?.category !== 'done' && info.options.some((o) => o.category === 'done') && (
        <p><button type="button" onClick={() => void act(() => stagesApi.close(p.id))} title="Move it to its closing stage and hide it from the scope">Close book</button></p>
      )}
      {info.options.length === 0 ? <p className="muted small">No moves are set up from here.</p> : (
        <ul className="plain stage-moves" aria-label="Move to">
          {info.options.map((o) => (
            <li key={o.key}>
              <button type="button" disabled={!o.allowed} onClick={() => void act(() => stagesApi.move(p.id, o.key))}>Move to {o.name}</button>
              {!o.allowed && o.reasons.length > 0 && <span className="muted small"> {o.reasons.join(' · ')}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A Project's Books: each with its stage, closing and reopening, and the way to add the first one. A Project has no stage of its own. */
function BooksCard({ p, studio, act, onSelect, openDialog }: { p: Project; studio: StudioState; act: Props['act']; onSelect: Props['onSelect']; openDialog: (d: Dialog) => void }) {
  const scope = useScope();
  const [stageOf, setStageOf] = useState<Record<string, ProjectStageView>>({});
  const [firstName, setFirstName] = useState(p.name);
  const [reopening, setReopening] = useState<{ id: string; options: StageMoveOption[] } | null>(null);
  useEffect(() => setFirstName(p.name), [p.id, p.name]);
  useEffect(() => {
    let live = true;
    void stagesApi.views().then((v) => live && setStageOf(v), () => undefined);
    return () => {
      live = false;
    };
  }, [studio.tree]);
  const books = viewBooks(studio.tree, p.id);
  const closedIds = new Set(books.filter((b) => stageOf[b.id]?.stage?.category === 'done').map((b) => b.id));
  const showClosed = scope?.project === p.id ? scope.showClosed : false;
  const shown = books.filter((b) => showClosed || !closedIds.has(b.id));
  const hasFolder = linksOf(studio.tree, p.id, 'write').length > 0;
  const reopen = async (id: string) => {
    const info = await stagesApi.options(id).catch(() => null);
    setReopening(info ? { id, options: info.options.filter((o) => o.category !== 'done') } : null);
  };
  return (
    <section className="card" aria-labelledby="pd-books">
      <div className="card-head">
        <h3 id="pd-books">Books</h3>
        <span className="muted small">A project has no stage; each of its books does.</span>
        {(closedIds.size > 0 || showClosed) && (
          <label className="inline small muted"><input type="checkbox" checked={showClosed} onChange={(e) => void window.cadrel.scope.set({ project: p.id, showClosed: e.target.checked })} /> Show closed books</label>
        )}
      </div>
      {books.length === 0 ? (
        <div>
          <p className="muted">No books yet. {hasFolder ? 'Add the first one: this project’s manuscript folder becomes the book’s, and nothing in it is moved or copied.' : 'Add the first one to start writing.'}</p>
          <div className="row">
            <input aria-label="Name of the first book" value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={120} />
            <button type="button" className="primary" disabled={!firstName.trim() || p.status === 'archived'} onClick={() => void act(() => manage.addFirstBook(p.id, firstName.trim()))}>Add first book</button>
            <button type="button" disabled={p.status === 'archived'} onClick={() => openDialog({ kind: 'new', parentId: p.id })}>Add a book with a new folder…</button>
          </div>
          {p.workflowId && <p className="muted small">This project has a stage from before stages moved to books; the first book starts in it, and the project is left without one.</p>}
        </div>
      ) : (
        <ul className="plain book-list">
          {shown.map((b) => {
            const st = stageOf[b.id]?.stage;
            const closed = closedIds.has(b.id);
            return (
              <li key={b.id} className={`row${closed ? ' closed' : ''}`}>
                <button type="button" className="link grow-text" onClick={() => onSelect(b.id)}>{b.name}</button>
                {st && <span className="stage-chip" style={{ borderColor: st.color, color: st.color }}>{st.name}</span>}
                {closed ? <span className="chip">closed</span> : null}
                {b.status === 'archived' ? null : closed
                  ? <button type="button" onClick={() => void reopen(b.id)}>Reopen…</button>
                  : <button type="button" onClick={() => void act(() => stagesApi.close(b.id))} title="Move it to its closing stage and hide it from the scope">Close book</button>}
              </li>
            );
          })}
          {shown.length === 0 && <li className="muted small">Every book is closed. Turn on “Show closed books” to see them, or add a new one.</li>}
        </ul>
      )}
      {reopening && (
        <div className="row" role="group" aria-label="Reopen into">
          <span className="muted small">Reopen “{nameOf(studio.tree, reopening.id)}” into:</span>
          {reopening.options.length === 0 && <span className="muted small">no stage can be reached from here</span>}
          {reopening.options.map((o) => (
            <button key={o.key} type="button" disabled={!o.allowed} title={o.reasons.join(' · ') || undefined} onClick={() => void act(() => stagesApi.reopen(reopening.id, o.key)).then(() => setReopening(null))}>{o.name}</button>
          ))}
          <button type="button" className="quiet" onClick={() => setReopening(null)}>Cancel</button>
        </div>
      )}
      {p.workflowId && books.length > 0 && (
        <p className="row small">
          <span className="muted">This project still has a stage from before stages moved to books.</span>
          <button type="button" className="link" onClick={() => void act(() => stagesApi.clear(p.id))}>Remove it</button>
        </p>
      )}
    </section>
  );
}

const nameOf = (tree: ProjectTree, id: string): string => getProject(tree, id)?.name ?? '';

function Detail({ p, studio, overview, act, onGo, onSelect, openDialog }: { p: Project; studio: StudioState; overview: Overview | null; act: Props['act']; onGo: Props['onGo']; onSelect: Props['onSelect']; openDialog: (d: Dialog) => void }) {
  const tree = studio.tree;
  const [workTick, setWorkTick] = useState(0); // work changes what a stage gate sees
  const facts = factsFor(tree, overview, p.id);
  const pct = percent(facts.words, facts.goalWords);
  const path = [...ancestorsOf(tree, p.id), p];
  const subs = childrenOf(tree, p.id);
  const mine = linksOf(tree, p.id);
  const ids = useMemo(() => subtreeIds(tree, p.id), [tree, p.id]);
  const notes = useMemo(() => queryNotes(studio.notes, { projectIds: ids, status: 'any' }), [studio.notes, ids]);
  const nameOf = (id: string) => getProject(tree, id)?.name ?? null;
  const level = viewLevel(tree, p.id);

  const takenWrite = new Set(tree.links.filter((l) => l.module === 'write').map((l) => l.ref));
  const ownMarket = new Set(mine.filter((l) => l.module === 'market').map((l) => l.ref)); // a category can be in several projects; only this project's own are not offered again
  const freeWrite = (overview?.write.projects ?? []).filter((w) => !takenWrite.has(w.name));
  const freeMarket = (overview?.market.categories ?? []).filter((c) => !ownMarket.has(c.key));
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
        <button type="button" className="primary" disabled={p.status === 'archived'} onClick={() => openDialog({ kind: 'new', parentId: p.id })}>{level === 'project' ? 'Add book' : 'Add subproject'}</button>
        <button type="button" onClick={() => openDialog({ kind: 'rename', id: p.id })}>Rename</button>
        <button type="button" onClick={() => void act(() => manage.duplicate(p.id))}>Duplicate</button>
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
        <button type="button" onClick={() => void act(() => manage.archive(p.id, p.status !== 'archived'))}>{p.status === 'archived' ? 'Restore' : 'Archive'}</button>
        <button type="button" className="quiet" onClick={() => openDialog({ kind: 'delete', id: p.id })}>Delete…</button>
      </div>

      {level === 'project' && <BooksCard p={p} studio={studio} act={act} onSelect={onSelect} openDialog={openDialog} />}
      {level === 'book' && <StageCard key={workTick} p={p} studio={studio} act={act} />}

      <WorkCard projectId={p.id} projectName={p.name} act={act} onChanged={() => setWorkTick((n) => n + 1)} />

      <ManuscriptCard p={p} linked={mine.some((l) => l.module === 'write')} act={act} />

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
                {w && <span className="muted small">{w.stage ? `${w.stage} · ` : null}{w.words === null ? 'no active manuscript' : `${formatWords(w.words)} words`}</span>}
                {gone && <span className="warn small">not found any more</span>}
                {l.module === 'market' && (() => {
                  const others = tree.links.filter((x) => x.module === 'market' && x.ref === l.ref && x.projectId !== p.id).map((x) => nameOf(x.projectId)).filter((n): n is string => !!n);
                  return others.length ? <span className="muted small">also in {others.join(', ')}</span> : null;
                })()}
                <button type="button" className="link" onClick={() => onGo(l.module as ModuleId)}>Open {l.module === 'write' ? 'Write' : 'Market'}</button>
                <button type="button" className="quiet" onClick={() => void act(() => api.unlink(l.module, l.ref, p.id))}>Unlink</button>
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
        <p className="muted small">A manuscript belongs to one project: linking it here moves it from wherever it was. A Market category can belong to several projects (books in the same genre share one), so linking it here keeps it in the others.</p>
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
  const [templates, setTemplates] = useState<ManuscriptTemplate[]>([]);
  const [wf, setWf] = useState<WorkflowState | null>(null);
  const [stageOf, setStageOf] = useState<Record<string, ProjectStageView>>({});
  const [unfiled, setUnfiled] = useState<{ projects: { name: string }[]; folders: { name: string }[] }>({ projects: [], folders: [] });
  useEffect(() => {
    void manage.templates().then(setTemplates, () => undefined);
  }, []);
  useEffect(() => {
    void workflowApi.state().then(setWf, () => undefined);
  }, [studio]);
  useEffect(() => {
    void stagesApi.views().then(setStageOf, () => undefined);
  }, [studio]);
  // Folders in the Projects folder that the tree does not know yet (made outside Cadrel, or by an older version).
  useEffect(() => {
    void manage.unfiled().then(setUnfiled, () => undefined);
  }, [studio]);

  const rows = useMemo(() => (studio ? outline(studio.tree, { archived }) : []), [studio, archived]);
  const current = studio && selected ? getProject(studio.tree, selected) : undefined;
  // If the remembered project is gone (deleted elsewhere), fall back to the first one.
  useEffect(() => {
    if (studio && selected && !current) onSelect(null);
  }, [studio, selected, current, onSelect]);

  if (!studio) return <p className="muted">Loading…</p>;
  const active = current ?? (rows[0]?.project as Project | undefined);

  const submit = async (name: string, kind: string, template: string | null, workflowId: string | null) => {
    const d = dialog;
    if (!d) return;
    if (d.kind === 'new') {
      const r = await act(() => manage.create({ name, parentId: d.parentId, kind: kind || undefined, template, workflowId }));
      if (r.ok) {
        onSelect(r.value.id);
        setDialog(null);
      }
    } else if (d.kind === 'rename') {
      const r = await act(() => manage.rename(d.id, name));
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
                <button type="button" className={`tree-row${active?.id === p.id ? ' active' : ''}${p.status === 'archived' ? ' archived' : ''}${stageOf[p.id]?.stage?.category === 'done' && viewLevel(studio.tree, p.id) === 'book' ? ' closed' : ''}`} style={{ paddingLeft: 10 + depth * 18 }} onClick={() => onSelect(p.id)}>
                  <span className="tree-name">{p.name}</span>
                  {stageOf[p.id]?.stage && <span className="stage-dot" title={stageOf[p.id]!.stage!.name} style={{ background: stageOf[p.id]!.stage!.color }} aria-label={`Stage: ${stageOf[p.id]!.stage!.name}`} />}
                  {studio.openByProject[p.id] ? <span className="count" title="Open notes">{studio.openByProject[p.id]}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
        {(unfiled.projects.length > 0 || unfiled.folders.length > 0) && (
          <div className="unfiled" aria-label="Folders in your Projects folder that are not projects yet">
            <h4>In your Projects folder</h4>
            <p className="muted small">Not part of a project yet.</p>
            <ul>
              {[...unfiled.projects, ...unfiled.folders].map((f) => (
                <li key={f.name}>
                  <span className="tree-name" title={f.name}>{f.name}</span>
                  <button type="button" onClick={() => void act(() => manage.adopt(f.name, current?.id ?? null)).then((r) => r.ok && onSelect(r.value))}>Add</button>
                </li>
              ))}
            </ul>
          </div>
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
          title={dialog.kind === 'rename' ? 'Rename project' : dialog.parentId ? `New ${viewLevel(studio.tree, dialog.parentId) === 'project' ? 'book' : 'subproject'} of ${getProject(studio.tree, dialog.parentId)?.name}` : 'New project'}
          initialName={dialog.kind === 'rename' ? getProject(studio.tree, dialog.id)?.name ?? '' : ''}
          initialKind={dialog.kind === 'new' && dialog.parentId && viewLevel(studio.tree, dialog.parentId) === 'project' ? 'Book' : ''}
          askKind={dialog.kind === 'new'}
          templates={dialog.kind === 'new' ? templates : undefined}
          defaultTemplate={dialog.kind === 'new' ? (dialog.parentId ? 'novel' : 'series') : null}
          workflows={dialog.kind === 'new' && wf?.available ? wf.workflows : undefined}
          forBook={dialog.kind === 'new' && !!dialog.parentId && viewLevel(studio.tree, dialog.parentId) === 'project'}
          action={dialog.kind === 'rename' ? 'Rename' : 'Create'}
          onSubmit={(n, k, t, w) => void submit(n, k, t, w)}
          onCancel={() => setDialog(null)}
        />
      )}
      {del && (
        <div className="modal-backdrop" onKeyDown={(e) => e.key === 'Escape' && setDialog(null)}>
          <div className="modal" role="alertdialog" aria-modal="true" aria-label="Delete project">
            <h3>Delete “{del.name}”?</h3>
            <p>
              {delKids > 0 ? `This also deletes its ${delKids} subproject${delKids === 1 ? '' : 's'}, ` : 'This '}and every note written on {delKids > 0 ? 'them' : 'it'}. Their manuscript folders go to the recycle bin, so nothing is lost for good. Market research is not touched; it just stops belonging to a project.
            </p>
            <p className="muted small">Archive instead if you may want it back.</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setDialog(null)} autoFocus>Keep it</button>
              <button type="button" className="danger" onClick={() => void act(() => manage.remove(del.id)).then((r) => r.ok && (setDialog(null), onSelect(null)))}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
