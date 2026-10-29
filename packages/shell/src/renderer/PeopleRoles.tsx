import { useCallback, useEffect, useMemo, useState } from 'react';
import { AREAS, CAPABILITY_INFO, PERSON_KINDS, type AssignmentRecord, type Person, type RoleRecord, type Team } from '@cadrel/kernel';
import type { PeopleState } from '../shared/api';

const api = window.cadrel.people;
type Ready = Extract<PeopleState, { available: true }>;
type Tab = 'people' | 'teams' | 'roles';
const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const AREA_CAPS = AREAS.map((a) => ({ id: a.id, label: a.label, caps: [...new Set((['R', 'C', 'W', 'A', 'M'] as const).flatMap((l) => a.caps[l] ?? []))] })).filter((a) => a.caps.length);
const ALL_AREA_CAPS = AREA_CAPS.flatMap((a) => a.caps);

/** People, teams, roles and who holds what: the studio's access, edited here and enforced everywhere by the same permission check. */
export function PeopleRoles() {
  const [s, setS] = useState<PeopleState | null>(null);
  const [tab, setTab] = useState<Tab>('people');
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);

  const load = useCallback(() => api.state().then(setS, (e) => setError(clean(e))), []);
  useEffect(() => {
    void load();
    void window.cadrel.studio.state().then((st) => setProjects(st.tree.projects.map((p) => ({ id: p.id, name: p.name }))), () => undefined);
  }, [load]);

  /** Runs a change, reloads, and shows a refusal in words instead of failing silently. */
  const act = useCallback(async <T,>(job: () => Promise<T>): Promise<T | undefined> => {
    setError(null);
    try {
      const v = await job();
      await load();
      return v;
    } catch (e) {
      setError(clean(e));
      return undefined;
    }
  }, [load]);

  if (!s) return <section className="card"><p className="muted">Loading…</p></section>;
  if (!s.available) return <section className="card" aria-labelledby="pr-title"><h3 id="pr-title">People and roles</h3><p className="muted">{s.reason}</p></section>;

  const where = (a: { kind: string; id: string }) => (a.kind === 'studio' ? 'the whole studio' : a.kind === 'project' ? projects.find((p) => p.id === a.id)?.name ?? a.id : `file ${a.id}`);
  const nameOf = (a: AssignmentRecord) => (a.subject.kind === 'person' ? [...s.people, ...s.deactivated].find((p) => p.id === a.subject.id)?.name : s.teams.find((t) => t.id === a.subject.id)?.name) ?? a.subject.id;
  const roleName = (id: string) => s.roles.find((r) => r.id === id)?.name ?? id;
  const until = (a: AssignmentRecord) => (a.expiresAt ? `until ${a.expiresAt.slice(0, 10)}` : '');

  return (
    <section className="card people-roles" aria-labelledby="pr-title">
      <div className="card-head"><h3 id="pr-title">People and roles</h3></div>
      <p className="muted small">
        Roles only ever grant. A person has no role until you give them one, and it can apply to the whole studio or to one project (and everything under it). The same check runs on every request, so what you set here is what is enforced.
      </p>
      {s.review.length > 0 && (
        <div className="banner info" role="status">
          <strong>New capabilities to review.</strong> A newer version added {s.review.map((c) => CAPABILITY_INFO[c]?.toLowerCase() ?? c).join('; ')}. Until you put {s.review.length === 1 ? 'it' : 'them'} in a role, only the Owner has {s.review.length === 1 ? 'it' : 'them'}.{' '}
          <button type="button" className="link" onClick={() => void act(() => api.acknowledgeCapabilities(s.review))}>Mark as reviewed</button>
        </div>
      )}
      <div className="subtabs" role="tablist" aria-label="People and roles">
        {(['people', 'teams', 'roles'] as const).map((t) => <button key={t} type="button" role="tab" className="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t === 'people' ? 'People' : t === 'teams' ? 'Teams' : 'Roles'}</button>)}
      </div>
      {error && <div className="banner error" role="alert">{error} <button type="button" className="link" onClick={() => setError(null)}>Dismiss</button></div>}
      {tab === 'people' && <PeopleTab s={s} act={act} projects={projects} where={where} roleName={roleName} until={until} />}
      {tab === 'teams' && <TeamsTab s={s} act={act} projects={projects} where={where} roleName={roleName} until={until} />}
      {tab === 'roles' && <RolesTab s={s} act={act} where={where} nameOf={nameOf} until={until} />}
    </section>
  );
}

type Act = <T>(job: () => Promise<T>) => Promise<T | undefined>;
interface Common { s: Ready; act: Act; where: (a: { kind: string; id: string }) => string; until: (a: AssignmentRecord) => string; roleName: (id: string) => string; projects: { id: string; name: string }[] }

/** "Give a role" for a person or a team: which role, where it applies, and until when. */
function GiveRole({ s, act, projects, subject }: { s: Ready; act: Act; projects: Common['projects']; subject: { kind: 'person' | 'team'; id: string } }) {
  const [roleId, setRoleId] = useState('');
  const [scope, setScope] = useState('studio');
  const [date, setDate] = useState('');
  if (!s.may.roles) return null;
  return (
    <div className="row" aria-label="Give a role">
      <select aria-label="Role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
        <option value="">Give a role…</option>
        {s.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      <select aria-label="Where it applies" value={scope} onChange={(e) => setScope(e.target.value)}>
        <option value="studio">Whole studio</option>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <label className="inline small muted">until <input type="date" aria-label="Expires on" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <button type="button" disabled={!roleId} onClick={() => void act(() => api.grant({ subject, roleId, scope: scope === 'studio' ? { kind: 'studio', id: s.studioId } : { kind: 'project', id: scope }, expiresAt: date ? `${date}T23:59:59.000Z` : null })).then(() => (setRoleId(''), setDate('')))}>Give</button>
    </div>
  );
}
/** The only Owner: nothing can remove, expire or deactivate them, so the page does not offer to. */
const lastOwner = (s: Ready, a: AssignmentRecord) => { const r = s.roles.find((x) => x.id === a.roleId); return !!r?.all && r.holders <= 1; };

function Assignments({ list, s, act, where, until, label }: { list: AssignmentRecord[]; s: Ready; act: Act; where: Common['where']; until: Common['until']; label: (a: AssignmentRecord) => string }) {
  if (!list.length) return <p className="muted small">No role yet, so this can do nothing.</p>;
  return (
    <ul className="plain">
      {list.map((a) => (
        <li key={a.id}>
          <span className="grow-text"><strong>{label(a)}</strong> <span className="muted small">for {where(a.scope)} {until(a)}</span></span>
          {s.may.roles && !lastOwner(s, a) && <button type="button" className="link" onClick={() => void act(() => api.revoke(a.id))}>Remove</button>}
          {lastOwner(s, a) && <span className="muted small">the last Owner</span>}
        </li>
      ))}
    </ul>
  );
}

function PeopleTab({ s, act, projects, where, roleName, until }: Common) {
  const [pick, setPick] = useState<string | null>(s.people[0]?.id ?? null);
  const [form, setForm] = useState({ name: '', email: '', kind: 'employee' });
  const person = s.people.find((p) => p.id === pick) ?? null;
  return (
    <div className="pr-cols">
      <div>
        <ul className="plain pr-list" aria-label="People">
          {s.people.map((p) => (
            <li key={p.id}>
              <button type="button" className={`link grow-text${p.id === pick ? ' on' : ''}`} aria-pressed={p.id === pick} onClick={() => setPick(p.id)}>{p.name}{p.id === s.me ? ' (you)' : ''}</button>
              <span className="chip">{p.kind}</span>
            </li>
          ))}
        </ul>
        {s.may.people && (
          <form className="pr-add" onSubmit={(e) => { e.preventDefault(); void act(() => api.createPerson({ name: form.name, email: form.email || null, kind: form.kind })).then((p) => { if (p) { setPick(p.id); setForm({ name: '', email: '', kind: 'employee' }); } }); }}>
            <input aria-label="Name" placeholder="Add a person: name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input aria-label="Email" placeholder="Email (optional)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <select aria-label="Kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{PERSON_KINDS.map((k) => <option key={k}>{k}</option>)}</select>
            <button type="submit" disabled={!form.name.trim()}>Add</button>
          </form>
        )}
        {s.deactivated.length > 0 && (
          <details>
            <summary className="small muted">Deactivated ({s.deactivated.length})</summary>
            <ul className="plain">{s.deactivated.map((p) => <li key={p.id}><span className="grow-text">{p.name}</span>{s.may.people && <button type="button" className="link" onClick={() => void act(() => api.setPersonActive(p.id, true))}>Reactivate</button>}</li>)}</ul>
          </details>
        )}
      </div>
      {person ? <PersonDetail key={person.id} person={person} s={s} act={act} projects={projects} where={where} roleName={roleName} until={until} /> : <p className="muted">Choose a person.</p>}
    </div>
  );
}

function PersonDetail({ person, s, act, projects, where, roleName, until }: Common & { person: Person }) {
  const [edit, setEdit] = useState({ name: person.name, email: person.email ?? '', kind: person.kind });
  const [pen, setPen] = useState('');
  const [explain, setExplain] = useState({ cap: 'manuscript.write', scope: 'studio' });
  const [verdict, setVerdict] = useState<{ allowed: boolean; reason: string } | null>(null);
  const mine = s.assignments.filter((a) => a.subject.kind === 'person' && a.subject.id === person.id);
  const myTeams = s.teams.filter((t) => t.memberIds.includes(person.id));
  const myPens = s.penNames.filter((n) => n.personIds.includes(person.id));
  const dirty = edit.name !== person.name || edit.email !== (person.email ?? '') || edit.kind !== person.kind;
  return (
    <div className="pr-detail">
      <h4>{person.name}</h4>
      <div className="row">
        <input aria-label="Name" value={edit.name} disabled={!s.may.people} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
        <input aria-label="Email" placeholder="Email" value={edit.email} disabled={!s.may.people} onChange={(e) => setEdit({ ...edit, email: e.target.value })} />
        <select aria-label="Kind" value={edit.kind} disabled={!s.may.people} onChange={(e) => setEdit({ ...edit, kind: e.target.value as Person['kind'] })}>{PERSON_KINDS.map((k) => <option key={k}>{k}</option>)}</select>
        {s.may.people && <button type="button" disabled={!dirty} onClick={() => void act(() => api.updatePerson(person.id, { name: edit.name, email: edit.email || null, kind: edit.kind }))}>Save</button>}
        {s.may.people && !mine.some((a) => lastOwner(s, a)) && <button type="button" onClick={() => void act(() => api.setPersonActive(person.id, false))}>Deactivate</button>}
      </div>

      <h5>Roles</h5>
      <Assignments list={mine} s={s} act={act} where={where} until={until} label={(a) => roleName(a.roleId)} />
      <GiveRole s={s} act={act} projects={projects} subject={{ kind: 'person', id: person.id }} />

      <h5>Teams</h5>
      {s.teams.length === 0 ? <p className="muted small">No teams yet.</p> : (
        <div className="row">{s.teams.map((t) => (
          <label key={t.id} className="inline small"><input type="checkbox" disabled={!s.may.teams} checked={myTeams.some((x) => x.id === t.id)} onChange={(e) => void act(() => api.setTeamMember(t.id, person.id, e.target.checked))} /> {t.name}</label>
        ))}</div>
      )}

      <h5>Pen names</h5>
      <div className="row">
        {myPens.map((n) => <span key={n.id} className="chip">{n.displayName}</span>)}
        {myPens.length === 0 && <span className="muted small">None.</span>}
      </div>
      {s.may.people && (
        <div className="row">
          <input aria-label="New pen name" placeholder="Add a pen name" value={pen} onChange={(e) => setPen(e.target.value)} />
          <button type="button" disabled={!pen.trim()} onClick={() => void act(() => api.createPenName({ displayName: pen, personIds: [person.id] })).then(() => setPen(''))}>Add</button>
          {s.penNames.filter((n) => !n.personIds.includes(person.id)).length > 0 && (
            <select aria-label="Share an existing pen name" value="" onChange={(e) => { const n = s.penNames.find((x) => x.id === e.target.value); if (n) void act(() => api.setPenNamePeople(n.id, [...n.personIds, person.id])); }}>
              <option value="">Share an existing one…</option>
              {s.penNames.filter((n) => !n.personIds.includes(person.id)).map((n) => <option key={n.id} value={n.id}>{n.displayName}</option>)}
            </select>
          )}
        </div>
      )}

      {s.may.roles && (
        <>
          <h5>Explain access</h5>
          <div className="row">
            <select aria-label="Action" value={explain.cap} onChange={(e) => setExplain({ ...explain, cap: e.target.value })}>
              {AREA_CAPS.map((a) => <optgroup key={a.id} label={a.label}>{a.caps.map((c) => <option key={c} value={c}>{CAPABILITY_INFO[c] ?? c}</option>)}</optgroup>)}
            </select>
            <select aria-label="On" value={explain.scope} onChange={(e) => setExplain({ ...explain, scope: e.target.value })}>
              <option value="studio">the studio</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button type="button" onClick={() => void api.explainAccess(person.id, explain.cap, explain.scope === 'studio' ? null : explain.scope).then(setVerdict, (e) => setVerdict({ allowed: false, reason: clean(e) }))}>Explain</button>
          </div>
          {verdict && <div className={`banner ${verdict.allowed ? 'info' : ''}`} role="status"><strong>{verdict.allowed ? 'Allowed' : 'Not allowed'}</strong>: {verdict.reason}</div>}
        </>
      )}
    </div>
  );
}

function TeamsTab({ s, act, projects, where, roleName, until }: Common) {
  const [name, setName] = useState('');
  return (
    <div>
      {s.teams.length === 0 && <p className="muted">No teams yet. A team gets a role once, and its members have it.</p>}
      {s.teams.map((t) => <TeamCard key={t.id} team={t} s={s} act={act} projects={projects} where={where} roleName={roleName} until={until} />)}
      {s.may.teams && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void act(() => api.createTeam(name)).then(() => setName('')); }}>
          <input aria-label="Team name" placeholder="New team" value={name} onChange={(e) => setName(e.target.value)} />
          <button type="submit" disabled={!name.trim()}>Add team</button>
        </form>
      )}
    </div>
  );
}

function TeamCard({ team, s, act, projects, where, roleName, until }: Common & { team: Team }) {
  const [name, setName] = useState(team.name);
  const mine = s.assignments.filter((a) => a.subject.kind === 'team' && a.subject.id === team.id);
  return (
    <div className="pr-team">
      <div className="row">
        <input aria-label={`Name of ${team.name}`} value={name} disabled={!s.may.teams} onChange={(e) => setName(e.target.value)} />
        {s.may.teams && <button type="button" disabled={name === team.name} onClick={() => void act(() => api.renameTeam(team.id, name))}>Rename</button>}
        {s.may.teams && <button type="button" className="link" onClick={() => { if (window.confirm(`Delete the team “${team.name}”? Its members stay; they just lose anything the team gave them.`)) void act(() => api.deleteTeam(team.id)); }}>Delete</button>}
      </div>
      <div className="row">{s.people.map((p) => (
        <label key={p.id} className="inline small"><input type="checkbox" disabled={!s.may.teams} checked={team.memberIds.includes(p.id)} onChange={(e) => void act(() => api.setTeamMember(team.id, p.id, e.target.checked))} /> {p.name}</label>
      ))}</div>
      <Assignments list={mine} s={s} act={act} where={where} until={until} label={(a) => roleName(a.roleId)} />
      <GiveRole s={s} act={act} projects={projects} subject={{ kind: 'team', id: team.id }} />
    </div>
  );
}

function RolesTab({ s, act, where, until, nameOf }: { s: Ready; act: Act; where: Common['where']; until: Common['until']; nameOf: (a: AssignmentRecord) => string }) {
  const [pick, setPick] = useState(s.roles.find((r) => r.templateKey === 'author')?.id ?? s.roles[0]?.id ?? '');
  const [newName, setNewName] = useState('');
  const role = s.roles.find((r) => r.id === pick) ?? null;
  return (
    <div className="pr-cols">
      <div>
        <ul className="plain pr-list" aria-label="Roles">
          {s.roles.map((r) => (
            <li key={r.id}>
              <button type="button" className={`link grow-text${r.id === pick ? ' on' : ''}`} aria-pressed={r.id === pick} onClick={() => setPick(r.id)}>{r.name}</button>
              <span className="muted small" title="People and teams who hold it">{r.holders}</span>
              {r.templateKey && <span className="chip">default</span>}
            </li>
          ))}
        </ul>
        {s.may.roles && (
          <form className="pr-add" onSubmit={(e) => { e.preventDefault(); void act(() => api.createRole({ name: newName })).then((r) => { if (r) { setPick(r.id); setNewName(''); } }); }}>
            <input aria-label="New role name" placeholder="New role" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button type="submit" disabled={!newName.trim()}>Add</button>
          </form>
        )}
      </div>
      {role ? <RoleEditor key={role.id + role.capabilities.join(',')} role={role} s={s} act={act} onPick={setPick} where={where} until={until} nameOf={nameOf} /> : null}
    </div>
  );
}

function RoleEditor({ role, s, act, onPick, where, until, nameOf }: { role: RoleRecord; s: Ready; act: Act; onPick: (id: string) => void; where: Common['where']; until: Common['until']; nameOf: (a: AssignmentRecord) => string }) {
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description);
  const [caps, setCaps] = useState<Set<string>>(new Set(role.capabilities));
  const [replacement, setReplacement] = useState('');
  const holders = s.assignments.filter((a) => a.roleId === role.id);
  const owner = !!role.all;
  const editable = s.may.roles && !owner;
  const dirty = name !== role.name || description !== role.description || [...caps].sort().join() !== [...role.capabilities].sort().join();
  const toggleArea = (list: string[], on: boolean) => setCaps((c) => { const n = new Set(c); list.forEach((x) => (on ? n.add(x) : n.delete(x))); return n; });
  const others = useMemo(() => s.roles.filter((r) => r.id !== role.id), [s.roles, role.id]);
  return (
    <div className="pr-detail">
      <h4>{role.name}</h4>
      {owner && <p className="muted small">The Owner holds every capability, including ones added later, and cannot be changed or deleted. There must always be at least one Owner.</p>}
      <div className="row">
        <input aria-label="Role name" value={name} disabled={!editable} onChange={(e) => setName(e.target.value)} />
        <input aria-label="Description" className="grow-text" placeholder="What this role is for" value={description} disabled={!editable} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {!owner && (
        <div className="pr-caps" aria-label="Capabilities">
          {AREA_CAPS.map((a) => {
            const all = a.caps.every((c) => caps.has(c));
            const some = a.caps.some((c) => caps.has(c));
            return (
              <fieldset key={a.id}>
                <legend>
                  <label className="inline"><input type="checkbox" disabled={!editable} checked={all} ref={(el) => { if (el) el.indeterminate = some && !all; }} onChange={(e) => toggleArea(a.caps, e.target.checked)} /> <strong>{a.label}</strong></label>
                </legend>
                {a.caps.map((c) => (
                  <label key={c} className="inline pr-cap"><input type="checkbox" disabled={!editable} checked={caps.has(c)} onChange={(e) => toggleArea([c], e.target.checked)} /> {CAPABILITY_INFO[c] ?? c} <code className="muted small">{c}</code></label>
                ))}
              </fieldset>
            );
          })}
        </div>
      )}
      {editable && (
        <div className="row">
          <button type="button" className="primary" disabled={!dirty} onClick={() => void act(() => api.updateRole(role.id, { name, description, capabilities: ALL_AREA_CAPS.filter((c) => caps.has(c)) }))}>Save role</button>
          <button type="button" disabled={!dirty} onClick={() => { setName(role.name); setDescription(role.description); setCaps(new Set(role.capabilities)); }}>Discard</button>
        </div>
      )}
      {s.may.roles && !owner && (
        <div className="row">
          <button type="button" onClick={() => { const n = window.prompt('Name for the copy', `${role.name} (copy)`); if (n) void act(() => api.createRole({ name: n, copyFrom: role.id })).then((r) => r && onPick(r.id)); }}>Copy…</button>
          {role.templateKey && <button type="button" onClick={() => { if (window.confirm(`Put “${role.name}” back to what Cadrel ships?`)) void act(() => api.resetRole(role.id)); }}>Reset to default</button>}
          {role.holders > 0 && (
            <select aria-label="Move its people to" value={replacement} onChange={(e) => setReplacement(e.target.value)}>
              <option value="">Move its people to…</option>
              {others.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}
          <button type="button" className="link" disabled={role.holders > 0 && !replacement} onClick={() => { if (window.confirm(`Delete “${role.name}”?${role.holders ? ` Its ${role.holders} assignment${role.holders === 1 ? '' : 's'} move to the role you chose.` : ''}`)) void act(() => api.deleteRole(role.id, replacement || undefined)).then(() => onPick(others[0]?.id ?? '')); }}>Delete</button>
        </div>
      )}
      <h5>Who holds it</h5>
      <Assignments list={holders} s={s} act={act} where={where} until={until} label={nameOf} />
    </div>
  );
}
