import { useState } from 'react';
import type { SyncStatus } from '../shared/api';
import { useEscape } from './useEscape';

interface Props {
  status: SyncStatus;
  onClose(): void;
}

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

/** Connect to Google Drive, see how the last sync went, and handle conflicts and held-back deletes. */
export function SyncDialog({ status, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  useEscape(onClose);
  const api = window.mdedit;
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
    } finally {
      setBusy(false);
    }
  };
  const working = busy || status.state === 'syncing';
  const sum = status.summary;

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal sync-dialog" role="dialog" aria-modal="true" aria-label="Google Drive sync">
        <h3>Google Drive</h3>

        {!status.connected ? (
          <>
            <p className="modal-hint">
              Keep your projects in a folder called <strong>MDEdit</strong> in your Google Drive, and up to date on every device you sign in on. MDEdit can only see the files it creates there, never the rest of your Drive.
            </p>
            {status.message && <div className="modal-error" role="alert">{status.message}</div>}
            <div className="modal-actions">
              <button type="button" onClick={onClose}>Not now</button>
              <button type="button" className="primary" disabled={working} onClick={() => void run(() => api.connectSync())}>
                {working ? 'Connecting…' : 'Connect Google Drive'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className={`sync-line s-${status.state}`} role="status">
              {status.state === 'syncing' ? (status.progress ? `Syncing… ${status.progress.done.toLocaleString()} of ${status.progress.total.toLocaleString()} files` : 'Syncing…') : status.state === 'error' ? 'Problem syncing' : status.state === 'confirm' ? 'Waiting for your OK' : 'Up to date'}
              <span className="muted"> · last sync {ago(status.lastSyncAt)}</span>
            </p>
            {status.message && <div className={status.state === 'error' ? 'modal-error' : 'modal-hint'} role="alert">{status.message}</div>}

            {status.state === 'confirm' && (
              <div className="sync-block">
                <strong>These files would be deleted:</strong>
                <ul className="sync-list">
                  {status.pendingDeletes.slice(0, 8).map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                  {status.pendingDeletes.length > 8 && <li>…and {status.pendingDeletes.length - 8} more</li>}
                </ul>
                <div className="modal-actions">
                  <button type="button" className="danger" disabled={working} onClick={() => void run(() => api.confirmDeletes())}>Delete them</button>
                </div>
              </div>
            )}

            {sum && (
              <p className="muted small">
                Last pass: {plural(sum.uploaded, 'file')} sent, {plural(sum.downloaded, 'file')} received
                {sum.deleted > 0 ? `, ${plural(sum.deleted, 'file')} removed` : ''}
                {sum.durationMs >= 1000 ? ` · took ${sum.durationMs < 90_000 ? `${Math.round(sum.durationMs / 1000)} s` : `${Math.round(sum.durationMs / 60_000)} min`}` : ''}.
              </p>
            )}

            {sum?.rootCreated && (
              <div className="sync-block">
                <strong>New MDEdit folder in Drive</strong>
                <p className="muted small">
                  MDEdit couldn’t see an existing <em>MDEdit</em> folder in your Drive, so it made one. If you expected projects from another device to arrive, they’re in a different folder this app can’t see.
                </p>
              </div>
            )}

            {sum && sum.conflicts.length > 0 && (
              <div className="sync-block">
                <strong>Kept both versions</strong>
                <p className="muted small">These chapters were changed on two devices. The copy named “conflict” has the other version; nothing was lost.</p>
                <ul className="sync-list">
                  {sum.conflicts.map((p) => (
                    <li key={p} title={p}>{nameOf(p)}</li>
                  ))}
                </ul>
              </div>
            )}

            {sum && sum.errors.length > 0 && (
              <div className="sync-block">
                <strong>Couldn’t sync</strong>
                <ul className="sync-list">
                  {sum.errors.slice(0, 5).map((e) => (
                    <li key={e.path} title={e.message}>{nameOf(e.path)}: {e.message}</li>
                  ))}
                </ul>
              </div>
            )}

            {sum && sum.skipped.some((s) => /text files/.test(s.reason)) && (
              <p className="muted small">Images and other non-text files aren’t synced yet.</p>
            )}

            <div className="modal-actions">
              <button
                type="button"
                disabled={working}
                onClick={() => void run(async () => {
                  if (window.confirm('Stop syncing on this device? Your files stay here and in Drive.')) await api.disconnectSync();
                })}
              >
                Disconnect
              </button>
              <button type="button" className="primary" disabled={working} onClick={() => void run(() => api.syncNow())}>
                {working ? 'Syncing…' : 'Sync now'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
