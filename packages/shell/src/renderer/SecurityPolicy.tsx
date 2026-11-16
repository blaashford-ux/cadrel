import { useEffect, useState } from 'react';
import type { PolicyState } from '../shared/api';

const api = window.cadrel;
type Ready = Extract<PolicyState, { available: true }>;
const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/**
 * Admin → Security policy. Only what the Studio itself enforces is here (docs/PERMISSIONS.md §5): how long an invitation lasts, how long a guest's
 * access lasts when the invitation does not say, when a check-out is flagged as stale, and whether the assistant may be used at all. Everyone
 * may read it; changing it needs the right to change the Studio's settings, and the server refuses anyone else.
 */
export function SecurityPolicy() {
  const [state, setState] = useState<PolicyState | null>(null);
  const [invite, setInvite] = useState('');
  const [guestOn, setGuestOn] = useState(false);
  const [guest, setGuest] = useState('');
  const [stale, setStale] = useState('');
  const [assistant, setAssistant] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const show = (s: PolicyState) => {
    setState(s);
    if (!s.available) return;
    setInvite(String(s.policy.inviteDays));
    setGuestOn(s.policy.guestDays !== null);
    setGuest(String(s.policy.guestDays ?? 90));
    setStale(String(s.policy.staleCheckoutDays));
    setAssistant(s.policy.assistantEnabled);
  };
  useEffect(() => void api.policy.state().then(show, (e) => setError(clean(e))), []);

  if (!state) return error ? <section className="card"><h3>Security policy</h3><p className="error" role="alert">{error}</p></section> : null;
  if (!state.available) return <section className="card" aria-labelledby="sp-h"><h3 id="sp-h">Security policy</h3><p className="muted small">{state.reason}</p></section>;
  const s: Ready = state;
  const whole = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v) : NaN);
  const problems: string[] = [];
  const range = (label: string, v: string, r: { min: number; max: number }) => {
    const n = whole(v);
    if (!(n >= r.min && n <= r.max)) problems.push(`${label} must be a whole number of days from ${r.min} to ${r.max}.`);
  };
  range('The invitation lifetime', invite, s.limits.inviteDays);
  if (guestOn) range('The guest access period', guest, s.limits.guestDays);
  range('The stale check-out warning', stale, s.limits.staleCheckoutDays);
  const next = { inviteDays: whole(invite), guestDays: guestOn ? whole(guest) : null, staleCheckoutDays: whole(stale), assistantEnabled: assistant };
  const dirty = JSON.stringify(next) !== JSON.stringify(s.policy);

  const save = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      show(await api.policy.set(next));
      setNote('Saved. Invitations made from now on use these; ones already made keep the end date they were given.');
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy(false);
    }
  };
  const off = !s.may || busy;

  return (
    <section className="card" aria-labelledby="sp-h">
      <h3 id="sp-h">Security policy</h3>
      <p className="muted small">
        The few rules the Studio enforces itself. Who may invite and who may force a release are capabilities of a role (People → Roles); devices are removed from People.
        {!s.may && ' You can read these; changing them needs the right to change the Studio’s settings.'}
      </p>
      <div className="row">
        <label>Invitation lifetime{' '}
          <input type="number" inputMode="numeric" min={s.limits.inviteDays.min} max={s.limits.inviteDays.max} value={invite} disabled={off} onChange={(e) => setInvite(e.target.value)} style={{ width: '5rem' }} /> days
        </label>
        <span className="muted small">How long a new invitation can be used before it lapses.</span>
      </div>
      <div className="row">
        <label>
          <input type="checkbox" checked={guestOn} disabled={off} onChange={(e) => setGuestOn(e.target.checked)} /> Guest access ends after{' '}
          <input type="number" inputMode="numeric" min={s.limits.guestDays.min} max={s.limits.guestDays.max} value={guest} disabled={off || !guestOn} onChange={(e) => setGuest(e.target.value)} style={{ width: '5rem' }} aria-label="Days of guest access" /> days
        </label>
        <span className="muted small">For an invitation limited to one project that names no end of its own. Off: such access does not end by itself.</span>
      </div>
      <div className="row">
        <label>Flag a check-out as stale after{' '}
          <input type="number" inputMode="numeric" min={s.limits.staleCheckoutDays.min} max={s.limits.staleCheckoutDays.max} value={stale} disabled={off} onChange={(e) => setStale(e.target.value)} style={{ width: '5rem' }} /> days
        </label>
        <span className="muted small">Shown on the Files page. A lock is never released automatically.</span>
      </div>
      <div className="row">
        <label>
          <input type="checkbox" checked={assistant} disabled={off} onChange={(e) => setAssistant(e.target.checked)} /> The assistant may be used with this Studio
        </label>
        <span className="muted small">Off: its record, editorial and project tools refuse for everyone, whatever their role holds.</span>
      </div>
      {problems.length > 0 && <ul className="plain" role="alert">{problems.map((p) => <li key={p} className="error small">{p}</li>)}</ul>}
      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className="muted small" role="status">{note}</p>}
      <div className="row"><button type="button" className="primary" disabled={off || !dirty || problems.length > 0} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button></div>
    </section>
  );
}
