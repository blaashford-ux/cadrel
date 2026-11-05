import { useEffect, useState } from 'react';
import { childrenOf, getProject, viewLevel, type Project } from '@cadrel/kernel';
import type { ModuleId, Overview, PeopleState, StudioState } from '../shared/api';
import { formatWords } from './format';
import { appliesTo } from './associationText';

const api = window.cadrel.studio;
const peopleApi = window.cadrel.people;
type Ready = Extract<PeopleState, { available: true }>;

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
  const [asin, setAsin] = useState('');
  const [titles, setTitles] = useState<Record<string, string | null>>({});
  const [people, setPeople] = useState<PeopleState | null>(null);
  const [who, setWho] = useState({ subject: '', roleId: '', scope: p.id, until: '' });
  useEffect(() => {
    setTarget(p.id);
    setPick('');
    setMsManuscript('');
    setAsin('');
    setWho({ subject: '', roleId: '', scope: p.id, until: '' });
  }, [p.id]);
  const loadPeople = () => peopleApi.state().then(setPeople, () => setPeople({ available: false, reason: 'People and roles could not be read.' }));
  useEffect(() => {
    void loadPeople();
  }, [p.id, studio.tree]);
  const comps = mine.filter((l) => l.module === 'comp');
  const compKey = comps.map((l) => l.ref).sort().join(',');
  useEffect(() => {
    let live = true;
    for (const ref of new Set(comps.map((l) => l.ref))) {
      if (titles[ref] !== undefined) continue;
      void window.cadrel.myBooks.book(ref).then((b) => live && setTitles((t) => ({ ...t, [ref]: b?.title ?? null })), () => live && setTitles((t) => ({ ...t, [ref]: null })));
    }
    return () => {
      live = false;
    };
  }, [compKey]);

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

      <h4>Comparable titles</h4>
      {comps.length === 0 && <p className="muted">No comps yet. A comp is a book readers of this {level === 'book' ? 'book' : 'project'} also buy; add it by its ASIN.</p>}
      <ul className="links">
        {comps.map((l) => (
          <li key={`${l.projectId}:${l.ref}`}>
            <span className="chip">Comp</span>
            <strong>{titles[l.ref] ?? l.ref}</strong>
            {titles[l.ref] && <span className="muted small">{l.ref}</span>}
            <span className="muted small">for {appliesTo(tree, l.projectId, p.id)}</span>
            <button type="button" className="quiet" onClick={() => void act(() => api.unlink('comp', l.ref, l.projectId))}>Remove</button>
          </li>
        ))}
      </ul>
      <div className="row">
        <input aria-label="ASIN of the comparable title" placeholder="ASIN, such as B0ABC12345" value={asin} maxLength={10} onChange={(e) => setAsin(e.target.value)} />
        {books.length > 0 && (
          <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Where the comp applies">
            <option value={p.id}>For the whole project</option>
            {books.map((b) => <option key={b.id} value={b.id}>For {b.name} only</option>)}
          </select>
        )}
        <button type="button" disabled={!asin.trim()} onClick={() => void act(() => api.link(target, 'comp', asin)).then((r) => r.ok && setAsin(''))}>Add comp</button>
      </div>
      <p className="muted small">A comp can be a comp for several projects. Its title shows when Market has captured the book.</p>

      <PeopleAssociation p={p} books={books} here={here} people={people} who={who} setWho={setWho} act={act} reload={loadPeople} parentName={parent?.name} onSelect={onSelect} />
    </section>
  );
}

interface PeopleProps {
  p: Project;
  books: Project[];
  here: Set<string>;
  people: PeopleState | null;
  who: { subject: string; roleId: string; scope: string; until: string };
  setWho: (w: PeopleProps['who']) => void;
  act: Props['act'];
  reload: () => Promise<unknown>;
  parentName?: string;
  onSelect: Props['onSelect'];
}

/**
 * Who works on this Project, and with what role: the assignments scoped to it. This is how access is controlled: a role given here applies
 * to the Project and everything under it (a role given on one Book applies to that Book only), and the same permission check that
 * enforces it everywhere is the one that refuses a change someone may not make.
 */
function PeopleAssociation({ p, books, here, people, who, setWho, act, reload, parentName, onSelect }: PeopleProps) {
  if (!people) return <><h4>People</h4><p className="muted">Loading…</p></>;
  if (!people.available) return <><h4>People</h4><p className="muted">{people.reason}</p></>;
  const s: Ready = people;
  const parentId = p.parentId;
  const nameOfSubject = (a: Ready['assignments'][number]) => (a.subject.kind === 'person' ? [...s.people, ...s.deactivated].find((x) => x.id === a.subject.id)?.name : s.teams.find((x) => x.id === a.subject.id)?.name) ?? a.subject.id;
  const roleName = (id: string) => s.roles.find((r) => r.id === id)?.name ?? id;
  const mine = s.assignments.filter((a) => a.scope.kind === 'project' && here.has(a.scope.id));
  const inherited = parentId ? s.assignments.filter((a) => a.scope.kind === 'project' && a.scope.id === parentId) : [];
  const studioWide = new Set(s.assignments.filter((a) => a.scope.kind === 'studio').map((a) => `${a.subject.kind}:${a.subject.id}`)).size;
  const scopeName = (id: string) => (id === p.id ? (parentId ? 'this book' : 'the whole project') : books.find((b) => b.id === id)?.name ?? id);
  const until = (a: Ready['assignments'][number]) => (a.expiresAt ? ` until ${a.expiresAt.slice(0, 10)}` : '');
  const [subjectKind, subjectId] = who.subject.split(':');
  const give = () =>
    void act(() =>
      peopleApi.grant({ subject: { kind: subjectKind === 'team' ? 'team' : 'person', id: subjectId ?? '' }, roleId: who.roleId, scope: { kind: 'project', id: who.scope }, expiresAt: who.until ? `${who.until}T23:59:59.000Z` : null })
    ).then((r) => {
      if (r.ok) setWho({ ...who, subject: '', roleId: '', until: '' });
      return reload();
    });
  return (
    <>
      <h4>People</h4>
      {mine.length === 0 && inherited.length === 0 && <p className="muted">Nobody is given a role on {p.name} itself yet.</p>}
      <ul className="links">
        {inherited.map((a) => (
          <li key={`inh:${a.id}`}>
            <span className="chip">{a.subject.kind === 'team' ? 'Team' : 'Person'}</span>
            <strong>{nameOfSubject(a)}</strong>
            <span>{roleName(a.roleId)}</span>
            <span className="muted small">from {parentName ?? 'the project'}{until(a)}</span>
            {parentId && <button type="button" className="link" onClick={() => onSelect(parentId)}>Change on the project</button>}
          </li>
        ))}
        {mine.map((a) => (
          <li key={a.id}>
            <span className="chip">{a.subject.kind === 'team' ? 'Team' : 'Person'}</span>
            <strong>{nameOfSubject(a)}</strong>
            <span>{roleName(a.roleId)}</span>
            <span className="muted small">for {scopeName(a.scope.id)}{until(a)}</span>
            {s.may.roles && <button type="button" className="quiet" onClick={() => void act(() => peopleApi.revoke(a.id)).then(() => reload())}>Remove</button>}
          </li>
        ))}
      </ul>
      {s.may.roles ? (
        <div className="row">
          <select value={who.subject} onChange={(e) => setWho({ ...who, subject: e.target.value })} aria-label="Person or team">
            <option value="">Give someone a role…</option>
            <optgroup label="People">{s.people.map((x) => <option key={x.id} value={`person:${x.id}`}>{x.name}</option>)}</optgroup>
            {s.teams.length > 0 && <optgroup label="Teams">{s.teams.map((x) => <option key={x.id} value={`team:${x.id}`}>{x.name}</option>)}</optgroup>}
          </select>
          <select value={who.roleId} onChange={(e) => setWho({ ...who, roleId: e.target.value })} aria-label="Role on this project">
            <option value="">Role…</option>
            {s.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          {books.length > 0 && (
            <select value={who.scope} onChange={(e) => setWho({ ...who, scope: e.target.value })} aria-label="Where the role applies">
              <option value={p.id}>On the whole project</option>
              {books.map((b) => <option key={b.id} value={b.id}>On {b.name} only</option>)}
            </select>
          )}
          <label className="inline small muted">until <input type="date" aria-label="Role ends on" value={who.until} onChange={(e) => setWho({ ...who, until: e.target.value })} /></label>
          <button type="button" disabled={!who.subject || !who.roleId} onClick={give}>Give role</button>
        </div>
      ) : (
        <p className="muted small">Only someone who can manage roles can change who has access here.</p>
      )}
      <p className="muted small">
        A role given here applies to {p.name}{books.length ? ' and its books, or to one book if you choose' : ''}, and nothing else; it only ever grants. {studioWide > 0 ? `${studioWide} ${studioWide === 1 ? 'person or team has' : 'people or teams have'} a studio-wide role that reaches this too (see Admin).` : ''}
      </p>
    </>
  );
}
