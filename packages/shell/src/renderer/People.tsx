import { useCallback, useEffect, useMemo, useState } from 'react';
import { defaultRole, STUDIO_SCHEMA_VERSION, STUDIO_WORKER_REVISION } from '@cadrel/kernel';
import type { StudioEntry, StudioPeople } from '../shared/api';
import { PeopleRoles } from './PeopleRoles';
import { useStudios } from './useStudios';

const api = window.cadrel.studios;
const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
type Opens = 'studio' | 'reader';

/** What an older member holds: the role their invitation named. A roleless one holds nothing until it is given one below. */
const heldRole = (role: string) => {
  if (role === '_none') return 'no role of its own: see below';
  try {
    return defaultRole(role as never).name;
  } catch {
    return role;
  }
};

/**
 * The Studio's people in one place: invite someone (a name and an email, no role), see who has joined, and give each person a role on each
 * project below. An invitation only brings a person in; what they can see is decided here, per project, by the same check the server runs
 * on every request, so a person sees nothing until they have been given something.
 */
export function People() {
  const studios = useStudios();
  const studio = studios?.studios.find((s) => s.id === studios.activeId) ?? null;
  const [people, setPeople] = useState<StudioPeople | null>(null);
  const [emails, setEmails] = useState<Record<string, string>>({});
  const owns = !!studio && studio.role === 'owner' && studio.status === 'ready' && studio.recordsOnServer;
  /** The Studio's server is older than this app: it does not know invitations without a role yet. */
  const behind = owns && !!studio?.server && (studio.server.schema < STUDIO_SCHEMA_VERSION || (studio.server.revision ?? 0) < STUDIO_WORKER_REVISION);

  const reload = useCallback(() => {
    if (!studio || !owns) return setPeople(null);
    void api.people(studio.id).then(setPeople, () => undefined);
    void window.cadrel.people.state().then((s) => s.available && setEmails(Object.fromEntries([...s.people].filter((p) => p.email).map((p) => [p.id, p.email as string]))), () => undefined);
  }, [studio?.id, owns]);
  useEffect(reload, [reload]);

  /** Who has joined or been invited, by person, so the list of people below can say so. */
  const statuses = useMemo(() => {
    const out: Record<string, string> = {};
    for (const i of people?.invites ?? []) if (i.personId) out[i.personId] = 'invited';
    for (const m of people?.members ?? []) if (m.personId && !m.revokedAt) out[m.personId] = 'joined';
    return out;
  }, [people]);

  if (!studios || !studio) return <section className="card"><p className="muted">Loading…</p></section>;
  return (
    <div className="settings people-page">
      {owns && behind ? <NeedsUpgrade /> : owns ? <Invite studio={studio} people={people} emails={emails} reload={reload} /> : <NoInvites studio={studio} />}
      <PeopleRoles statuses={statuses} />
    </div>
  );
}

function NeedsUpgrade() {
  return (
    <section className="card" aria-labelledby="pp-invite">
      <h3 id="pp-invite">Invite people</h3>
      <p className="muted small">This Studio’s server is older than this version of Cadrel, so it cannot make invitations this way yet. Upgrade it first: <strong>Admin → Studio Manager → Upgrade</strong>. Roles for the people already here can be given below as usual.</p>
    </section>
  );
}

function NoInvites({ studio }: { studio: StudioEntry }) {
  return (
    <section className="card" aria-labelledby="pp-invite">
      <h3 id="pp-invite">Invite people</h3>
      <p className="muted small">
        {studio.role !== 'owner'
          ? 'Only the Studio’s owner can invite people to it.'
          : 'Invitations need a Studio built in Cloudflare whose records are kept on its server. Build it, and move its records there, in Admin → Studio Manager.'}
      </p>
    </section>
  );
}

function Invite({ studio, people, emails, reload }: { studio: StudioEntry; people: StudioPeople | null; emails: Record<string, string>; reload: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [opens, setOpens] = useState<Opens>('studio');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [made, setMade] = useState<{ link: string; to: string; who: string } | null>(null);
  const [sendNow, setSendNow] = useState(true);
  const serverMail = !!studio.mailFrom; // the Studio's own server sends the email (turned on in Studio Manager)

  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await job();
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy(false);
    }
  };
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => setNote('Invitation link copied.'), () => setNote('Could not copy: select the link and copy it.'));
  const mail = (to: string, link: string) => run(async () => (await api.emailInvite(studio.id, { to, link }), setNote('Your mail app has opened with the invitation. Press Send there.')));
  /** The Studio's server emails it, to the address on the person's record. A failure leaves the link to be copied or sent from the mail app. */
  const sendFromStudio = async (link: string, to: string) => {
    try {
      await api.sendInviteEmail(studio.id, { link });
      setNote(`Emailed to ${to}.`);
    } catch (e) {
      setError(`The invitation was made, but the email did not send: ${clean(e)} You can copy the link, or open it in your mail app.`);
    }
  };

  const create = () =>
    run(async () => {
      const r = await api.invitePerson(studio.id, { name: name.trim(), email: email.trim(), opens });
      setMade({ link: r.link, to: email.trim(), who: name.trim() });
      const to = email.trim();
      setName('');
      setEmail('');
      reload();
      if (serverMail && sendNow && looksLikeEmail(to)) await sendFromStudio(r.link, to);
    });
  /** A fresh link for someone already invited: the old link's code is not kept anywhere, so it cannot be shown again. The old one is cancelled once the new one exists. */
  const renew = (inviteId: string, personId: string, who: string) =>
    run(async () => {
      const r = await api.invitePerson(studio.id, { personId, opens });
      await api.revokeInvite(studio.id, inviteId);
      setMade({ link: r.link, to: emails[personId] ?? '', who });
      reload();
      if (serverMail && sendNow && looksLikeEmail(emails[personId] ?? '')) await sendFromStudio(r.link, emails[personId] as string);
    });

  const pending = people?.invites ?? [];
  const joined = (people?.members ?? []).filter((m) => !m.revokedAt);
  const label = (personId: string | null | undefined, fallback: string) => fallback || (personId ? emails[personId] : '') || 'Someone';

  return (
    <section className="card" aria-labelledby="pp-invite">
      <h3 id="pp-invite">Invite people</h3>
      <p className="muted small">
        An invitation only brings a person in: they see nothing until you give them a role on a project, below. Send the link yourself, or have it written into an email in your own mail app.
      </p>
      <form className="row" onSubmit={(e) => (e.preventDefault(), name.trim() && void create())}>
        <input aria-label="Name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input aria-label="Email" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <select aria-label="The link opens" value={opens} onChange={(e) => setOpens(e.target.value as Opens)}>
          <option value="studio">Opens in Cadrel (authors, co-authors)</option>
          <option value="reader">Opens in Cadrel Reader (readers)</option>
        </select>
        <button type="submit" disabled={busy || !name.trim()}>{serverMail && sendNow && looksLikeEmail(email) ? 'Create and email invitation' : 'Create invitation'}</button>
      </form>
      {serverMail && <label className="check small"><input type="checkbox" checked={sendNow} onChange={(e) => setSendNow(e.target.checked)} /> Email it as soon as it is made (from {studio.mailFrom}), to the address above</label>}
      {error && <div className="banner error" role="alert">{error} <button type="button" className="link" onClick={() => setError(null)}>Dismiss</button></div>}
      {made && (
        <div className="banner info" role="status">
          <p>Invitation for <strong>{made.who}</strong>. It works once, for 7 days, and is not shown again.</p>
          <div className="row">
            <input readOnly aria-label="Invitation link" className="grow" value={made.link} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" onClick={() => void copy(made.link)}>Copy link</button>
            {serverMail && looksLikeEmail(made.to) && <button type="button" disabled={busy} onClick={() => void run(() => sendFromStudio(made.link, made.to))}>Send email to {made.to}</button>}
            {looksLikeEmail(made.to) && <button type="button" disabled={busy} onClick={() => void mail(made.to, made.link)}>Open in my mail app</button>}
            <button type="button" className="link" onClick={() => setMade(null)}>Done</button>
          </div>
        </div>
      )}
      {note && <p className="muted small" role="status">{note}</p>}
      {people && !people.reachable && <p className="muted small" role="status">Could not reach the Studio to list its people: {people.error}</p>}
      {pending.length > 0 && (
        <ul className="studio-list" aria-label="Invitations waiting">
          {pending.map((i) => (
            <li key={i.id}>
              <span className="grow-text">
                <strong>{label(i.personId, i.label)}</strong> <span className="muted small">invited · waiting until {new Date(i.expiresAt).toLocaleDateString()}{i.role !== '_none' ? ` · as ${heldRole(i.role)}` : ''}</span>
              </span>
              {i.personId && <button type="button" disabled={busy} aria-label={`Make a new link for ${label(i.personId, i.label)}`} onClick={() => void renew(i.id, i.personId as string, label(i.personId, i.label))}>New link</button>}
              <button type="button" disabled={busy} aria-label={`Cancel the invitation for ${label(i.personId, i.label)}`} onClick={() => void run(async () => (await api.revokeInvite(studio.id, i.id), reload()))}>Cancel</button>
            </li>
          ))}
        </ul>
      )}
      {joined.length > 0 && (
        <ul className="studio-list" aria-label="People who have joined">
          {joined.map((m) => (
            <li key={m.id}>
              <span className="grow-text"><strong>{m.name}</strong> <span className="muted small">joined {new Date(m.joinedAt).toLocaleDateString()} · {heldRole(m.role)}</span></span>
              <button type="button" disabled={busy} aria-label={`Remove ${m.name} from the Studio`} onClick={() => void run(async () => (await api.removeMember(studio.id, m.id), reload()))}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {people?.reachable && pending.length === 0 && joined.length === 0 && <p className="muted small">No one has joined or been invited yet.</p>}
    </section>
  );
}
