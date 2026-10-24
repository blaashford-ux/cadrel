import { useEffect, useState } from 'react';
import type { UpdateInfo, UpdateProgress } from '../shared/update';
import logo from './logo.png';
import { useEscape } from './useEscape';

type State =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current'; info: UpdateInfo }
  | { kind: 'available'; info: UpdateInfo }
  | { kind: 'installing'; info: UpdateInfo; progress: UpdateProgress | null }
  | { kind: 'handoff' }
  | { kind: 'error'; message: string };

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Help → About (and the ⓘ button on the phone): the version, credits, and updating from the latest GitHub release. */
export function AboutDialog({ onClose }: { onClose(): void }) {
  const api = window.mdedit;
  const [version, setVersion] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });
  useEscape(() => state.kind !== 'installing' && onClose());

  useEffect(() => {
    let live = true;
    api.getAppVersion().then((v) => live && setVersion(v), () => undefined);
    const off = api.onUpdateProgress((progress) => live && setState((s) => (s.kind === 'installing' ? { ...s, progress } : s)));
    return () => {
      live = false;
      off();
    };
  }, [api]);

  const check = async () => {
    setState({ kind: 'checking' });
    try {
      const info = await api.checkForUpdate();
      setState({ kind: info.available ? 'available' : 'current', info });
    } catch (e) {
      setState({ kind: 'error', message: `Couldn’t check for updates: ${messageOf(e)}` });
    }
  };

  const install = async (info: UpdateInfo) => {
    setState({ kind: 'installing', info, progress: null });
    try {
      await api.installUpdate(info);
      setState({ kind: 'handoff' }); // on the phone the system installer is now open; on Windows the app is closing
    } catch (e) {
      setState({ kind: 'error', message: messageOf(e) });
    }
  };

  const installing = state.kind === 'installing';
  const info = state.kind === 'available' || state.kind === 'installing' || state.kind === 'current' ? state.info : null;

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && !installing && onClose()}>
      <div className="modal about-dialog" role="dialog" aria-modal="true" aria-label="About MDEdit">
        <div className="about-head">
          <img src={logo} alt="" width={48} height={48} />
          <div>
            <h3>MDEdit</h3>
            <div className="about-version">{version ? `Version ${version}` : ' '}</div>
          </div>
        </div>
        <p className="modal-hint">A folder-based Markdown editor with KDP export.</p>
        <p className="modal-hint">Bundled fonts: EB Garamond, Crimson Pro, Libre Baskerville (SIL Open Font License 1.1). Print layout: Paged.js (MIT).</p>

        {api.capabilities.update && (
          <div className="about-update" aria-live="polite">
            {state.kind === 'checking' && <p>Checking GitHub for the latest release…</p>}
            {state.kind === 'current' && <p>You have the latest version{info ? ` (${info.latest})` : ''}.</p>}
            {(state.kind === 'available' || state.kind === 'installing') && info && (
              <>
                <p>
                  <strong>Version {info.latest}</strong> is available.
                  {info.asset ? ` (${mb(info.asset.size)})` : ''}
                </p>
                {!info.asset && <p className="modal-error">This release doesn’t include a download for this device.</p>}
                {info.notes && (
                  <details className="about-notes">
                    <summary>What’s new</summary>
                    <pre>{info.notes}</pre>
                  </details>
                )}
              </>
            )}
            {installing && (
              <p>
                {state.progress && state.progress.total > 0
                  ? `Downloading… ${Math.min(100, Math.round((state.progress.received / state.progress.total) * 100))}%`
                  : 'Downloading…'}
              </p>
            )}
            {state.kind === 'handoff' && <p>Update downloaded and verified. Follow the installer to finish; MDEdit may close first.</p>}
            {state.kind === 'error' && <p className="modal-error" role="alert">{state.message}</p>}
          </div>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={installing}>Close</button>
          {api.capabilities.update &&
            (state.kind === 'available' || (state.kind === 'error' && info) ? (
              <button type="button" className="primary" disabled={!info?.asset} onClick={() => info && void install(info)}>
                Update to {info?.latest}
              </button>
            ) : (
              <button type="button" className="primary" disabled={state.kind === 'checking' || installing} onClick={() => void check()}>
                Check for updates
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
