import { useEffect, useState } from 'react';
import type { StudioInfo, SyncStatus } from '../shared/api';
import { useEscape } from './useEscape';

const ago = (ms: number | null, now = Date.now()): string => {
  if (ms === null) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : new Date(ms).toLocaleDateString();
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Paste an invitation link and say who you are: joins a Cadrel Studio (or, with the owner's own link, signs this phone in as the owner). Used on the first screen and in the Studio dialog. */
export function StudioJoinForm({ onJoined, onCancel, initialLink = '' }: { onJoined(studio: StudioInfo): void; onCancel?: () => void; initialLink?: string }) {
  const [link, setLink] = useState(initialLink);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A link made with "Link a phone" on the owner's computer makes this phone the owner: no name to give, it is already theirs.
  const device = /^cadrel:\/\/join\?(?:.*&)?d=1(?:&|$)/i.test(link.trim());
  const ready = link.trim().length > 0 && (device || name.trim().length > 0) && !busy;
  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      onJoined(await window.cadrelWrite.studio!.join(link.trim(), name.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="studio-join"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void join();
      }}
    >
      <label>
        Invitation link
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="cadrel://join?…" autoCapitalize="off" autoCorrect="off" spellCheck={false} inputMode="url" />
      </label>
      {device ? (
        <p className="modal-hint">This link signs this phone in as you, the Studio’s owner, the same as on your computer.</p>
      ) : (
        <label>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="What the Studio should call you" autoComplete="name" />
        </label>
      )}
      {error && <div className="modal-error" role="alert">{error}</div>}
      <div className="modal-actions">
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
        <button type="submit" className="primary" disabled={!ready}>{busy ? 'Joining…' : device ? 'Sign in as me' : 'Join this Studio'}</button>
      </div>
    </form>
  );
}

interface Props {
  status: SyncStatus;
  onClose(): void;
}

/** The Studio this phone is working in: who you are there, how the files are keeping up, and joining, switching and leaving Studios. */
export function StudioDialog({ status, onClose }: Props) {
  const api = window.cadrelWrite;
  const [studios, setStudios] = useState<StudioInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEscape(onClose);
  const reload = () => void api.studio!.list().then(setStudios);
  useEffect(reload, []); // eslint-disable-line react-hooks/exhaustive-deps
  const here = studios.find((s) => s.active);
  const others = studios.filter((s) => !s.active);
  const working = busy || status.state === 'syncing';
  const sum = status.summary;
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal sync-dialog studio-dialog" role="dialog" aria-modal="true" aria-label="Studio">
        <h3>{here?.name ?? 'Studio'}</h3>
        {here && (
          <p className="modal-hint">
            You are <strong>{here.me}</strong>, {/^[aeiou]/i.test(here.role) ? 'an' : 'a'} {here.role}. Owner’s key <code>{here.fingerprint}</code>.
          </p>
        )}

        <p className={`sync-line s-${status.state}`} role="status">
          {status.state === 'syncing'
            ? status.progress ? `Syncing… ${status.progress.done.toLocaleString()} of ${status.progress.total.toLocaleString()} files` : 'Syncing…'
            : status.state === 'error' ? 'Not up to date' : 'Up to date'}
          <span className="muted"> · last sync {ago(status.lastSyncAt)}</span>
        </p>
        {status.message && <div className={status.state === 'error' ? 'modal-error' : 'modal-hint'} role="alert">{status.message}</div>}
        {error && <div className="modal-error" role="alert">{error}</div>}

        {sum && (
          <p className="muted small">
            Last pass: {plural(sum.uploaded, 'file')} saved to the Studio, {plural(sum.downloaded, 'file')} received.
          </p>
        )}
        {sum?.checkedOut && sum.checkedOut.length > 0 && api.fileLock && (
          <div className="sync-block">
            <strong>Checked out on this phone</strong>
            <p className="muted small">Nobody else can change these until you check them in. Check them in when you finish, before you carry on in Cadrel on your computer: that is what makes the new version.</p>
            <ul className="sync-list">
              {sum.checkedOut.map((u) => (
                <li key={u.id}>
                  {u.name}{u.changed ? ' · changed' : ''}{' '}
                  <button
                    type="button"
                    disabled={working}
                    onClick={() => void run(async () => {
                      await api.fileLock!.checkIn(u.path);
                      setNotice(`${u.name} is checked in.`);
                    })}
                  >
                    Check in
                  </button>
                </li>
              ))}
            </ul>
            {notice && <p className="muted small" role="status">{notice}</p>}
          </div>
        )}
        {sum?.unprotected && sum.unprotected.length > 0 && api.fileLock && (
          <div className="sync-block">
            <strong>Changed without a check-out</strong>
            <p className="muted small">These are left exactly as they are and never overwritten. Check one out keeping your changes, then check it in to make a version.</p>
            <ul className="sync-list">
              {sum.unprotected.map((u) => (
                <li key={u.id}>
                  {u.name}{' '}
                  <button type="button" disabled={working} onClick={() => void run(async () => { await api.fileLock!.checkOut(u.path, { keepChanges: true }); })}>Check out, keeping my changes</button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {sum && sum.conflicts.length > 0 && (
          <div className="sync-block">
            <strong>Kept both versions</strong>
            <p className="muted small">These files were changed in two places (or held by someone else). The file named “conflict” has what you wrote here; it is also on the Studio. Nothing was lost.</p>
            <ul className="sync-list">{sum.conflicts.map((p) => <li key={p} title={p}>{nameOf(p)}</li>)}</ul>
          </div>
        )}
        {sum && sum.errors.length > 0 && (
          <div className="sync-block">
            <strong>Couldn’t sync</strong>
            <ul className="sync-list">{sum.errors.slice(0, 5).map((e) => <li key={e.path} title={e.message}>{nameOf(e.path)}: {e.message}</li>)}</ul>
          </div>
        )}
        {sum && sum.skipped.length > 0 && <p className="muted small">{sum.skipped.map((s) => s.reason).join('. ')}.</p>}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Close</button>
          <button type="button" className="primary" disabled={working} onClick={() => void run(() => api.syncNow())}>{working ? 'Syncing…' : 'Sync now'}</button>
        </div>

        <h4>Studios on this phone</h4>
        {others.length === 0 && !adding && <p className="muted small">Only this one. Join another with an invitation link.</p>}
        {others.map((s) => (
          <div key={s.id} className="studio-row">
            <span>{s.name} <span className="muted">· {s.role}</span></span>
            <button type="button" disabled={busy} onClick={() => void run(() => api.studio!.switchTo(s.id))}>Open</button>
          </div>
        ))}
        {adding ? (
          <StudioJoinForm onJoined={() => undefined} onCancel={() => setAdding(false)} />
        ) : (
          <div className="modal-actions">
            {here && (
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Leave “${here.name}” on this phone? Its files here are removed; the Studio keeps everything. The owner can remove you there too.`)) void run(() => api.studio!.leave(here.id));
                }}
              >
                Leave this Studio
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => setAdding(true)}>Join another Studio</button>
          </div>
        )}
      </div>
    </div>
  );
}
