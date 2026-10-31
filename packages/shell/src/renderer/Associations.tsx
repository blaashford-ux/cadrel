import { useEffect, useState } from 'react';
import { childrenOf, getProject, viewLevel, type Project } from '@cadrel/kernel';
import type { ModuleId, Overview, StudioState } from '../shared/api';
import { formatWords } from './format';
import { appliesTo } from './associationText';

const api = window.cadrel.studio;

interface Props {
  p: Project;
  studio: StudioState;
  overview: Overview | null;
  act: <T>(job: () => Promise<T>) => Promise<{ ok: true; value: T } | { ok: false }>;
  onGo: (m: ModuleId) => void;
  onSelect: (id: string | null) => void;
}

/**
 * What is brought in to a Project: Market categories first, then manuscripts. An association is what makes a thing appear in the Project's
 * scope in Write and Market. A category can be attached to the whole Project, or to one Book only (so a Book in another genre has its own).
 */
export function Associations({ p, studio, overview, act, onGo, onSelect }: Props) {
  const tree = studio.tree;
  const level = viewLevel(tree, p.id);
  const books: Project[] = level === 'project' ? childrenOf(tree, p.id).filter((b) => b.status !== 'archived') : [];
  const here = new Set([p.id, ...books.map((b) => b.id)]);
  const mine = tree.links.filter((l) => here.has(l.projectId));
  const categories = mine.filter((l) => l.module === 'market');
  const manuscripts = mine.filter((l) => l.module === 'write');
  const inherited = level === 'book' && p.parentId ? tree.links.filter((l) => l.projectId === p.parentId && l.module === 'market') : [];
  const parent = p.parentId ? getProject(tree, p.parentId) : undefined;

  const [target, setTarget] = useState(p.id);
  const [pick, setPick] = useState('');
  const [msManuscript, setMsManuscript] = useState('');
  useEffect(() => {
    setTarget(p.id);
    setPick('');
    setMsManuscript('');
  }, [p.id]);

  const nameOfCat = (key: string) => overview?.market.categories.find((c) => c.key === key)?.name ?? key;
  const gone = (key: string) => !!overview?.market.ok && !!overview.market.libraryRoot && !overview.market.categories.some((c) => c.key === key);
  const taken = new Set(categories.filter((l) => l.projectId === target).map((l) => l.ref));
  const freeCategories = (overview?.market.categories ?? []).filter((c) => !taken.has(c.key));
  const takenWrite = new Set(tree.links.filter((l) => l.module === 'write').map((l) => l.ref));
  const freeWrite = (overview?.write.projects ?? []).filter((w) => !takenWrite.has(w.name));

  const assign = () => void act(() => api.link(target, 'market', pick)).then((r) => r.ok && setPick(''));
  const attach = () => void act(() => api.link(p.id, 'write', msManuscript)).then((r) => r.ok && setMsManuscript(''));

  return (
    <section className="card associations" aria-labelledby="pd-assoc">
      <h3 id="pd-assoc">Associations</h3>
      <p className="muted small">
        What you bring in here is what {p.name} shows in Write and Market. Anything not brought in is still in the Studio; use the <strong>Project | All</strong> switch on a page to see it.
      </p>

      <h4>Market categories</h4>
      {categories.length === 0 && inherited.length === 0 && (
        <p className="muted">No categories yet, so Market shows everything for {p.name}. Assign the genres this {level === 'book' ? 'book' : 'project'} sells in.</p>
      )}
      <ul className="links">
        {inherited.map((l) => (
          <li key={`inh:${l.ref}`}>
            <span className="chip">Category</span>
            <strong>{nameOfCat(l.ref)}</strong>
            <span className="muted small">from {parent?.name ?? 'the project'}</span>
            {parent && <button type="button" className="link" onClick={() => onSelect(parent.id)}>Change on the project</button>}
          </li>
        ))}
        {categories.map((l) => {
          const others = tree.links.filter((x) => x.module === 'market' && x.ref === l.ref && !here.has(x.projectId)).map((x) => getProject(tree, x.projectId)?.name).filter((n): n is string => !!n);
          return (
            <li key={`${l.projectId}:${l.ref}`}>
              <span className="chip">Category</span>
              <strong>{nameOfCat(l.ref)}</strong>
              <span className="muted small">for {appliesTo(tree, l.projectId, p.id)}</span>
              {gone(l.ref) && <span className="warn small">not found any more</span>}
              {others.length > 0 && <span className="muted small">also in {others.join(', ')}</span>}
              <button type="button" className="link" onClick={() => onGo('market')}>Open Market</button>
              <button type="button" className="quiet" onClick={() => void act(() => api.unlink('market', l.ref, l.projectId))}>Remove</button>
            </li>
          );
        })}
      </ul>
      <div className="row">
        <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Market category to assign">
          <option value="">Assign a category…</option>
          {freeCategories.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
        </select>
        {books.length > 0 && (
          <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Where it applies">
            <option value={p.id}>For the whole project</option>
            {books.map((b) => <option key={b.id} value={b.id}>For {b.name} only</option>)}
          </select>
        )}
        <button type="button" disabled={!pick} onClick={assign}>Assign</button>
      </div>
      <p className="muted small">A category can belong to several projects (books in the same genre share one). One assigned to a book shows in that book and in the project, not in the project’s other books.</p>

      <h4>Manuscripts</h4>
      {manuscripts.length === 0 && <p className="muted">No manuscript folder is attached.</p>}
      <ul className="links">
        {manuscripts.map((l) => {
          const w = overview?.write.projects.find((x) => x.name === l.ref);
          const missing = !!overview?.write.ok && !w;
          return (
            <li key={`${l.projectId}:${l.ref}`}>
              <span className="chip">Manuscript</span>
              <strong>{l.ref}</strong>
              <span className="muted small">for {appliesTo(tree, l.projectId, p.id)}</span>
              {w && <span className="muted small">{w.stage ? `${w.stage} · ` : null}{w.words === null ? 'no active manuscript' : `${formatWords(w.words)} words`}</span>}
              {missing && <span className="warn small">not found any more</span>}
              <button type="button" className="link" onClick={() => onGo('write')}>Open Write</button>
              <button type="button" className="quiet" onClick={() => void act(() => api.unlink('write', l.ref, l.projectId))}>Remove</button>
            </li>
          );
        })}
      </ul>
      <div className="row">
        <select value={msManuscript} onChange={(e) => setMsManuscript(e.target.value)} aria-label="Manuscript to attach">
          <option value="">Attach a manuscript from Write…</option>
          {freeWrite.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
        </select>
        <button type="button" disabled={!msManuscript} onClick={attach}>Attach</button>
      </div>
      <p className="muted small">A manuscript belongs to one project or book: attaching it here moves it from wherever it was.</p>
    </section>
  );
}
