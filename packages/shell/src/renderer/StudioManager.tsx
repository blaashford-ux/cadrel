import { useState } from 'react';
import { ROLE_KEYS, defaultRole } from '@cadrel/kernel';
import type { StudioEntry, StudiosView } from '../shared/api';
import { useStudios } from './useStudios';

const api = window.cadrel.studios;
const INVITE_ROLES = ROLE_KEYS.filter((k) => k !== 'owner');
const STATUS_LABEL: Record<StudioEntry['status'], string> = { local: 'On this computer', 'not-provisioned': 'Not built yet', provisioning: 'Building…', ready: 'Ready', error: 'Needs attention' };
const mask = (id: string | null) => (id ? `${id.slice(0, 4)}…${id.slice(-4)}` : 'not set');

/** Admin → Studio Manager: where an owner makes Studios, builds them in their own Cloudflare account, and looks after who is in them. */
export function StudioManager() {
  const studios = useStudios();
  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  if (!studios) return null;
  /** Runs a change; a refusal is shown as text. */
  const act = async <T,>(job: () => Promise<T>, after?: (r: T) => void): Promise<void> => {
    setError(null);
    setNote(null);
    try {
      const result = await job(); // (not `after?.(await job())`: an absent `after` would skip evaluating the argument)
      after?.(result);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!studios.managerEnabled) {
    return (
      <section className="card" aria-labelledby="sm-title">
        <h3 id="sm-title">Studio Manager</h3>
        <p className="muted small">
          Make Studios of your own: separate, independent workspaces, each with its own database and file store in your own Cloudflare account, walled off from every other Studio. You can also invite people into the Studios you own.
          Until you turn this on, Cadrel works as a Studio for one person, on this computer.
        </p>
        <button type="button" className="primary" onClick={() => void act(() => api.enableManager(true))}>Enable Studio Manager</button>
        {error && <div className="banner error" role="alert">{error}</div>}
      </section>
    );
  }

  const owned = studios.studios.filter((s) => s.role === 'owner' && s.status !== 'local');
  const invited = studios.studios.filter((s) => s.role === 'member');
  const selected = owned.find((s) => s.id === picked) ?? null;

  return (
    <section className="card studio-manager" aria-labelledby="sm-title">
      <div className="card-head">
        <h3 id="sm-title">Studio Manager</h3>
        <button type="button" className="link" onClick={() => void act(() => api.enableManager(false))}>Turn off</button>
      </div>
      <div className="banner info" role="note">Preview: creating a Studio and checking its Cloudflare details work. Building it in Cloudflare, invitations and backup are not connected yet.</div>

      <h4>Your Studios</h4>
      <ul className="studio-list">
        <li>
          <span className="grow-text"><strong>{studios.studios.find((s) => s.status === 'local')!.name}</strong> <span className="muted small">the Studio on this computer, for one person</span></span>
          <span className="chip">{STATUS_LABEL.local}</span>
        </li>
        {owned.map((s) => (
          <li key={s.id}>
            <button type="button" className={`link grow-text${s.id === picked ? ' on' : ''}`} aria-pressed={s.id === picked} onClick={() => setPicked(s.id === picked ? null : s.id)}>{s.name}</button>
            <span className={`chip${s.status === 'error' ? ' warn' : ''}`}>{STATUS_LABEL[s.status]}</span>
          </li>
        ))}
        {invited.map((s) => (
          <li key={s.id}>
            <span className="grow-text">{s.name} <span className="muted small">you were invited</span></span>
            <button type="button" onClick={() => void act(() => api.remove(s.id))}>Leave</button>
          </li>
        ))}
      </ul>

      <form className="row" onSubmit={(e) => (e.preventDefault(), void act(() => api.create(name), (v) => (setName(''), setPicked(v.studios[v.studios.length - 1]!.id))))}>
        <input aria-label="New Studio name" placeholder="Name of a new Studio" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        <button type="submit" className="primary" disabled={!name.trim()}>Create Studio</button>
      </form>
      {error && <div className="banner error" role="alert">{error}</div>}
      {note && <div className="banner info" role="status">{note}</div>}

      {selected && <StudioDetail studio={selected} studios={studios} act={act} setNote={setNote} onGone={() => setPicked(null)} />}
    </section>
  );
}

function StudioDetail({ studio, act, setNote, onGone }: { studio: StudioEntry; studios: StudiosView; act: <T>(job: () => Promise<T>, after?: (r: T) => void) => Promise<void>; setNote(n: string | null): void; onGone(): void }) {
  const [account, setAccount] = useState('');
  const [token, setToken] = useState('');
  const [rename, setRename] = useState(studio.name);
  const [role, setRole] = useState<string>('author');
  const [label, setLabel] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const ready = studio.status === 'ready';

  return (
    <div className="studio-detail" role="region" aria-label={`${studio.name} settings`}>
      <h4>{studio.name}</h4>
      <dl className="kv">
        <dt>Status</dt><dd>{STATUS_LABEL[studio.status]}</dd>
        <dt>Address</dt><dd>{studio.url ?? 'none yet'}</dd>
        <dt>Cloudflare account</dt><dd>{mask(studio.accountId)}</dd>
        <dt>Created</dt><dd>{new Date(studio.createdAt).toLocaleDateString()}</dd>
      </dl>
      {studio.note && <p className="muted small" role="status">{studio.note}</p>}

      {!ready && (
        <form className="provision" aria-label="Provision in Cloudflare" onSubmit={(e) => (e.preventDefault(), void act(() => window.cadrel.studios.provision(studio.id, { accountId: account, apiToken: token }), () => (setToken(''), setNote('Details checked. The token was used once and not kept.'))))}>
          <h5>Build it in your Cloudflare account</h5>
          <p className="muted small">
            This Studio gets its own Worker, database and file store in your account, shared with no one. Create an API token in Cloudflare (My Profile → API Tokens) with <b>Workers Scripts: Edit</b>, <b>D1: Edit</b> and <b>R2: Edit</b>.
            Use a Cloudflare account for Cadrel alone if you can: the token reaches anything of those kinds in the account. It is used once, now, and never saved.
          </p>
          <label className="field"><span className="field-label">Account ID</span><input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="32 letters and numbers" autoComplete="off" spellCheck={false} /></label>
          <label className="field"><span className="field-label">API token</span><input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} /></label>
          <button type="submit" className="primary" disabled={!account.trim() || !token.trim()}>Provision</button>
        </form>
      )}

      <h5>People</h5>
      <p className="muted small">You are the Owner. Invite people by role; they connect with Cadrel, never with your Cloudflare account.</p>
      <div className="row">
        <select aria-label="Role for the invitation" value={role} onChange={(e) => setRole(e.target.value)} disabled={!ready}>
          {INVITE_ROLES.map((k) => <option key={k} value={k}>{defaultRole(k).name}</option>)}
        </select>
        <input aria-label="Who the invitation is for" placeholder="Who is it for? (a label only you see)" value={label} onChange={(e) => setLabel(e.target.value)} disabled={!ready} />
        <button type="button" disabled={!ready} onClick={() => void act(() => window.cadrel.studios.createInvite(studio.id, { role, label }))}>Create invitation</button>
      </div>
      {!ready && <p className="muted small">Available once the Studio has been built.</p>}

      <h5>Looking after it</h5>
      <div className="row">
        <button type="button" disabled={!ready} title={ready ? '' : 'Available once the Studio has been built'} onClick={() => void act(() => window.cadrel.studios.backup(studio.id))}>Back up this Studio</button>
        <button type="button" disabled title="Not available yet">Upgrade</button>
        <button type="button" disabled title="Not available yet">Recovery code</button>
      </div>

      <h5>Name and removal</h5>
      <form className="row" onSubmit={(e) => (e.preventDefault(), void act(() => window.cadrel.studios.rename(studio.id, rename)))}>
        <input aria-label="Studio name" value={rename} onChange={(e) => setRename(e.target.value)} maxLength={60} />
        <button type="submit" disabled={!rename.trim() || rename.trim() === studio.name}>Rename</button>
      </form>
      {!confirmRemove ? (
        <button type="button" className="quiet" onClick={() => setConfirmRemove(true)}>Remove from this computer…</button>
      ) : (
        <div className="banner warn" role="alert">
          Remove “{studio.name}” from this computer? Anything already built in Cloudflare stays there; you would need your account ID and token to connect it again.{' '}
          <button type="button" className="danger" onClick={() => void act(() => window.cadrel.studios.remove(studio.id), onGone)}>Remove</button>{' '}
          <button type="button" onClick={() => setConfirmRemove(false)}>Keep it</button>
        </div>
      )}
    </div>
  );
}
