import { useCallback, useEffect, useState } from 'react';
import { type Project, type ProjectTree } from '@cadrel/kernel';
import type { PeopleState } from '../shared/api';
import { accessOn, type HeldOn } from './projectAccess';

const api = window.cadrel.people;
type Ready = Extract<PeopleState, { available: true }>;
const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/**
 * Who can work on this project, and with which role: add a person from the Studio's people with a role (and an end date, if it should lapse),
 * and take a role away. A role given on a project reaches everything under it, so a Series' people appear on its Books marked as coming from
 * above; those can only be changed where they were given. Someone new is invited on the People page.
 */
export function ProjectPeople({ p, tree }: { p: Project; tree: ProjectTree }) {
  const [s, setS] = useState<PeopleState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [personId, setPersonId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.state().then(setS, () => setS(null)), []);
  useEffect(() => {
    setPersonId('');
    setRoleId('');
    setDate('');
    setError(null);
    void load();
  }, [p.id, load]);

  if (!s || !s.available) return null; // the people are not there to show, or this person may not see them
  const ready: Ready = s;

  const nameOf = (a: HeldOn['assignment']) => (a.subject.kind === 'person' ? ready.people.find((x) => x.id === a.subject.id)?.name : ready.teams.find((t) => t.id === a.subject.id)?.name) ?? 'Someone';
  const roleName = (id: string) => ready.roles.find((r) => r.id === id)?.name ?? id;
  const projectName = (id: string | null) => tree.projects.find((x) => x.id === id)?.name ?? 'a project above';
  const held = accessOn(tree, ready.assignments, p.id, ready.studioId);
  const grantable = ready.roles.filter((r) => !r.all); // the Owner role is for the whole Studio, not for a project
  const betaOnly = (id: string) => ready.roles.find((r) => r.id === id)?.templateKey === 'beta_reader';

  const run = async (job: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await job();
      await load();
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="pd-people">
      <h3 id="pd-people">People on this project</h3>
      <p className="muted small">What each person can do here is their role. A role given on a project reaches everything under it. Someone with no role here sees nothing of this project.</p>
      {error && <div className="banner error" role="alert">{error} <button type="button" className="link" onClick={() => setError(null)}>Dismiss</button></div>}
      {held.length === 0 ? (
        <p className="muted small">No one has been given a role on this project yet.</p>
      ) : (
        <ul className="plain" aria-label={`People on ${p.name}`}>
          {held.map((h) => (
            <li key={h.assignment.id}>
              <span className="grow-text">
                <strong>{nameOf(h.assignment)}</strong>{h.assignment.subject.kind === 'team' ? ' (team)' : ''} <span className="chip">{roleName(h.assignment.roleId)}</span>{' '}
                <span className="muted small">
                  {h.source === 'above' ? `from ${projectName(h.from)}` : h.source === 'studio' ? 'the whole Studio' : 'this project'}
                  {h.assignment.expiresAt ? ` · until ${h.assignment.expiresAt.slice(0, 10)}` : ''}
                </span>
              </span>
              {h.source === 'here' && ready.may.roles && <button type="button" className="link" disabled={busy} aria-label={`Remove ${nameOf(h.assignment)} from ${p.name}`} onClick={() => void run(() => api.revoke(h.assignment.id))}>Remove</button>}
            </li>
          ))}
        </ul>
      )}
      {ready.may.roles && (
        <form className="row" aria-label="Add someone to this project" onSubmit={(e) => (e.preventDefault(), personId && roleId && void run(async () => (await api.grant({ subject: { kind: 'person', id: personId }, roleId, scope: { kind: 'project', id: p.id }, expiresAt: date ? `${date}T23:59:59.000Z` : null }), setPersonId(''), setRoleId(''), setDate(''))))}>
          <select aria-label="Person" value={personId} onChange={(e) => setPersonId(e.target.value)}>
            <option value="">Add a person…</option>
            {ready.people.map((x) => <option key={x.id} value={x.id}>{x.name}{x.id === ready.me ? ' (you)' : ''}</option>)}
          </select>
          <select aria-label="Role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            <option value="">with the role…</option>
            {grantable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <label className="inline small muted">until <input type="date" aria-label="Ends on" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <button type="submit" disabled={busy || !personId || !roleId}>Add</button>
        </form>
      )}
      {roleId && betaOnly(roleId) && <p className="muted small">A Beta Reader reads this project’s active manuscript, in the chapters you switch on for beta reading (right-click the manuscript in Write).</p>}
      {ready.may.people && <p className="muted small">Someone not in the list? <button type="button" className="link" onClick={() => void window.cadrel.navigate('people')}>Invite them on the People page</button>.</p>}
    </section>
  );
}
