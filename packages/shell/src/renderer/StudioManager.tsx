import { useEffect, useState } from 'react';
import { STUDIO_SCHEMA_VERSION, STUDIO_WORKER_REVISION } from '@cadrel/kernel';
import type { StudioEntry, StudiosView } from '../shared/api';
import { useStudios } from './useStudios';

const api = window.cadrel.studios;
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
      <div className="banner info" role="note">Back up this Studio, or restore from a backup, under Settings → Backup and import.</div>

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

function StudioDetail({ studio, studios, act, setNote, onGone }: { studio: StudioEntry; studios: StudiosView; act: <T>(job: () => Promise<T>, after?: (r: T) => void) => Promise<void>; setNote(n: string | null): void; onGone(): void }) {
  const [account, setAccount] = useState('');
  const [token, setToken] = useState('');
  const [keep, setKeep] = useState(false);
  const [rename, setRename] = useState(studio.name);
  const [confirmMove, setConfirmMove] = useState(false);
  const [moving, setMoving] = useState(false);
  const [devices, setDevices] = useState<{ id: string; label: string; linkedAt: string }[]>([]);
  const [deviceLink, setDeviceLink] = useState<string | null>(null);
  const [deviceLabel, setDeviceLabel] = useState('');
  const [upToken, setUpToken] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const ready = studio.status === 'ready';
  const building = studio.status === 'provisioning';
  const behind = ready && studio.server !== null && (studio.server.schema < STUDIO_SCHEMA_VERSION || (studio.server.revision ?? 0) < STUDIO_WORKER_REVISION);

  const loadDevices = () => {
    void api.devices(studio.id).then(setDevices, () => setDevices([]));
  };
  useEffect(() => {
    setDeviceLink(null);
    setDevices([]);
    setConfirmMove(false);
    if (ready) loadDevices();
  }, [studio.id, ready, studio.recordsOnServer]);

  return (
    <div className="studio-detail" role="region" aria-label={`${studio.name} settings`}>
      <h4>{studio.name}</h4>
      <dl className="kv">
        <dt>Status</dt><dd>{STATUS_LABEL[studio.status]}</dd>
        <dt>Address</dt><dd>{studio.url ?? 'none yet'}</dd>
        <dt>Cloudflare account</dt><dd>{mask(studio.accountId)}</dd>
        <dt>Folder</dt><dd>{studio.folderName}</dd>
        <dt>Created</dt><dd>{new Date(studio.createdAt).toLocaleDateString()}</dd>
      </dl>
      {studio.note && <p className={`small ${studio.status === 'error' ? 'warn-text' : 'muted'}`} role="status">{studio.note}</p>}

      {!ready && (
        <form className="provision" aria-label="Provision in Cloudflare" onSubmit={(e) => (e.preventDefault(), void act(() => api.provision(studio.id, { accountId: account, apiToken: token, keepToken: keep }), () => (setToken(''), setNote('Your Studio is built.'))))}>
          <h5>Build it in your Cloudflare account</h5>
          <p className="muted small">
            This Studio gets its own Worker, database and file store in your account, shared with no one. Create an API token in Cloudflare (My Profile → API Tokens) with <b>Workers Scripts: Edit</b>, <b>D1: Edit</b> and <b>R2: Edit</b>.
            Use a Cloudflare account for Cadrel alone if you can: the token reaches anything of those kinds in the account.
          </p>
          <label className="field"><span className="field-label">Account ID</span><input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="32 letters and numbers" autoComplete="off" spellCheck={false} disabled={building} /></label>
          <label className="field"><span className="field-label">API token</span><input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} disabled={building} /></label>
          <label className="check"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} disabled={building} /> Keep this token on this computer (encrypted), so upgrades do not ask for it again</label>
          <button type="submit" className="primary" disabled={!account.trim() || !token.trim() || building}>{building ? 'Building…' : 'Provision'}</button>
        </form>
      )}

      {ready && (
        <>
          <h5>People</h5>
          <p className="muted small">You are the Owner. Invite people, and give them roles on projects, on the <strong>People</strong> page.</p>
          <h5>Your phone</h5>
          <p className="muted small">Sign in to this Studio on your phone as yourself, the owner. Make a link here, open Cadrel Write on the phone and paste it: the phone makes its own key, so yours never leaves this computer. You can remove a phone below.</p>
          <div className="row">
            <input aria-label="Name for the phone" placeholder="Which phone? (a label only you see)" value={deviceLabel} onChange={(e) => setDeviceLabel(e.target.value)} />
            <button type="button" onClick={() => void act(() => api.linkDevice(studio.id, deviceLabel), (r) => (setDeviceLink(r.link), setDeviceLabel(''), loadDevices()))}>Link a phone</button>
          </div>
          {deviceLink && (
            <div className="banner info" role="status">
              <p>Paste this link into Cadrel Write on your phone. It works once, for an hour, and is not shown again. Anyone who opens it first becomes you in this Studio, so send it only to yourself.</p>
              <div className="row"><input readOnly aria-label="Phone link" className="grow" value={deviceLink} onFocus={(e) => e.currentTarget.select()} /><button type="button" onClick={() => void navigator.clipboard.writeText(deviceLink).then(() => setNote('Phone link copied.'), () => undefined)}>Copy</button></div>
            </div>
          )}
          {devices.length > 0 && (
            <ul className="studio-list" aria-label="Your linked phones">
              {devices.map((d) => (
                <li key={d.id}>
                  <span className="grow-text"><strong>{d.label || 'Phone'}</strong> <span className="muted small">linked {d.linkedAt ? new Date(d.linkedAt).toLocaleDateString() : ''}</span></span>
                  <button type="button" aria-label={`Remove ${d.label || 'phone'}`} onClick={() => void act(() => api.removeDevice(studio.id, d.id), setDevices)}>Remove</button>
                </li>
              ))}
            </ul>
          )}

          <h5>Where the Studio’s records are</h5>
          {studio.recordsOnServer ? (
            <p className="muted small">The people, roles, books, work and files of this Studio are kept on its server. Everyone, you included, uses them there, and what a role may do is decided there.</p>
          ) : (
            <>
              <p className="muted small">The people, roles, books, work and files of this Studio are on this computer only. Move them to the Studio’s server so the people you invite can work in the same records and the same files, with check-out locking decided by the server. Nothing is deleted here: the file on this computer is kept as a copy.</p>
              {studios.activeId !== studio.id ? (
                <p className="muted small">Open this Studio first (Studio menu on Home); its records are on this computer only while it is the one in use.</p>
              ) : !confirmMove ? (
                <button type="button" onClick={() => setConfirmMove(true)}>Move this Studio’s records to its server…</button>
              ) : (
                <div className="banner warn" role="alert">
                  This sends everything in this Studio (its people, roles, books, work, vault files and projects) to its server, then restarts Cadrel into it. It can take a while for a large vault. The server’s own records are replaced.{' '}
                  <button type="button" className="primary" disabled={moving} onClick={() => { setMoving(true); void act(() => api.moveRecords(studio.id), (r) => setNote(`Moved ${r.rows} records and ${r.files} files. Cadrel is restarting into the Studio’s server.`)).finally(() => setMoving(false)); }}>{moving ? 'Moving…' : 'Move them'}</button>{' '}
                  <button type="button" disabled={moving} onClick={() => setConfirmMove(false)}>Cancel</button>
                </div>
              )}
            </>
          )}

          <h5>Looking after it</h5>
          <div className="row">
            {studio.recordsOnServer
              ? <button type="button" onClick={() => void act(() => api.backupServer(studio.id), (r) => r && setNote(`Saved ${r.rows} records to ${r.file}. The files’ contents stay in the Studio’s file store, where no version is ever deleted.`))}>Back up the server’s records</button>
              : <button type="button" disabled title="Move the records to the server first, or use Settings → Backup and import">Back up the server’s records</button>}
            <button type="button" disabled={!behind || (!studio.tokenKept && !upToken.trim())} onClick={() => void act(() => api.upgrade(studio.id, studio.tokenKept ? undefined : upToken), () => (setUpToken(''), setNote('Upgraded.')))}>Upgrade the server{behind ? '' : ' (up to date)'}</button>
            {studio.recordsOnServer && <button type="button" onClick={() => { if (window.confirm('Replace the records on the server with a saved copy? Anything done since that copy was made is lost. Cadrel restarts afterwards.')) void act(() => api.restoreServer(studio.id), (r) => r && setNote(`Put back ${r.rows} records. Cadrel is restarting.`)); }}>Put back from a backup…</button>}
            <button type="button" disabled title="Not available yet">Recovery code</button>
          </div>
          {behind && !studio.tokenKept && (
            <label className="field"><span className="field-label">Cloudflare API token, to upgrade (not kept)</span><input type="password" aria-label="Token for the upgrade" value={upToken} onChange={(e) => setUpToken(e.target.value)} autoComplete="off" /></label>
          )}
          {studio.tokenKept && (
            <p className="muted small">Your Cloudflare token is kept on this computer, encrypted. <button type="button" className="link" onClick={() => void act(() => api.forgetToken(studio.id))}>Forget it</button></p>
          )}
        </>
      )}

      <h5>Name and removal</h5>
      <form className="row" onSubmit={(e) => (e.preventDefault(), void act(() => api.rename(studio.id, rename)))}>
        <input aria-label="Studio name" value={rename} onChange={(e) => setRename(e.target.value)} maxLength={60} />
        <button type="submit" disabled={!rename.trim() || rename.trim() === studio.name}>Rename</button>
      </form>
      <p className="muted small">A Studio’s folder keeps the name it was made with.</p>
      {!confirmRemove ? (
        <button type="button" className="quiet" onClick={() => setConfirmRemove(true)}>Remove from this computer…</button>
      ) : (
        <div className="banner warn" role="alert">
          Remove “{studio.name}” from this computer? Anything already built in Cloudflare stays there, and its files stay in the <b>{studio.folderName}</b> folder; you would need your account ID and token to connect it again.{' '}
          <button type="button" className="danger" onClick={() => void act(() => api.remove(studio.id), onGone)}>Remove</button>{' '}
          <button type="button" onClick={() => setConfirmRemove(false)}>Keep it</button>
        </div>
      )}
    </div>
  );
}
