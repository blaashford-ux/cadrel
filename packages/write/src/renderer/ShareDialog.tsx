import { useEffect, useState } from 'react';
import type { SyncStatus } from '../shared/api';
import { parseReviewFile } from '../shared/review/comments';
import { inviteMessage } from '../shared/review/link';
import type { ShareChapters, ShareStatus } from '../shared/review/share';
import { useEscape } from './useEscape';

interface Props {
  project: string;
  projectName: string;
  /** The project's active manuscript (relative path), the only file reviewers get. */
  manuscript?: string | null;
  sync: SyncStatus | null;
  /** Opens the Google Drive dialog, for when this device isn't connected yet. */
  onConnect(): void;
  onClose(): void;
}

const copy = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
};

/** Manage a project's reviewers: one link per person. Copy the plain link or a short invitation message, or withdraw it. */
export function ShareDialog({ project, projectName, manuscript: given, sync, onConnect, onClose }: Props) {
  const api = window.mdedit;
  const [loaded, setLoaded] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (given === undefined) void api.getProjectMeta(project).then((m) => setLoaded(m?.activeManuscript ?? null)).catch(() => setLoaded(null));
  }, [project, given]);
  const manuscript = given !== undefined ? given : (loaded ?? null);
  const [status, setStatus] = useState<ShareStatus | null>(null);
  const [list, setList] = useState<ShareChapters | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [level, setLevel] = useState(1);
  const [counts, setCounts] = useState<Map<string, { open: number; total: number }>>(new Map());
  const [name, setName] = useState('');
  const [role, setRole] = useState<'review' | 'edit'>('review');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  useEscape(onClose);

  // The manuscript's chapters, with the ticks from the last invitation (every chapter the first time).
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [meta, defaults] = await Promise.all([api.getProjectMeta(project).catch(() => null), api.getAppDefaults().catch(() => null)]);
        const lv = meta?.overrides?.chapterLevel ?? defaults?.chapterLevel ?? 1;
        const res = await api.getShareChapters(project, lv);
        if (!live) return;
        setLevel(lv);
        setList(res);
        setTicked(new Set(res.selected));
      } catch {
        /* no chapter list: the invitation covers the whole manuscript */
      }
    })();
    return () => {
      live = false;
    };
  }, [project, manuscript]);
  const chapters = list?.chapters ?? [];
  const limited = chapters.length > 1;
  const toggle = (key: string) =>
    setTicked((t) => {
      const n = new Set(t);
      if (!n.delete(key)) n.add(key);
      return n;
    });

  const load = () => {
    void api.getShareStatus(project).then(setStatus).catch(() => undefined);
    void api
      .listReviews(project)
      .then((list) => {
        const m = new Map<string, { open: number; total: number }>();
        for (const { id, text } of list) {
          const items = (parseReviewFile(text)?.items ?? []).filter((i) => i.status !== 'deleted');
          m.set(id, { open: items.filter((i) => i.status === 'open').length, total: items.length });
        }
        setCounts(m);
      })
      .catch(() => undefined);
  };
  useEffect(load, [project]);

  const connected = sync?.connected === true;

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await f();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      load();
    }
  };

  const copyNote = async (text: string, what: string) => setNote((await copy(text)) ? `${what} copied.` : 'Couldn’t copy to the clipboard.');

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal share-dialog" role="dialog" aria-modal="true" aria-label="Share for review">
        <h3>Share “{projectName}”</h3>
        {!connected ? (
          <>
            <p className="modal-hint">Reviewers get their invitations through Google Drive. Connect Google Drive first.</p>
            <div className="modal-actions">
              <button type="button" onClick={onClose}>Close</button>
              <button type="button" className="primary" onClick={onConnect}>Connect Google Drive…</button>
            </div>
          </>
        ) : (
          <>
            <p className="modal-hint">
              {manuscript ? (
                <>
                  Reviewers see only the active manuscript, <strong>{manuscript}</strong>, and nothing else in the project. To share a different file, make it the active manuscript first (right-click it → Active Manuscript).{' '}
                </>
              ) : (
                <>Reviewers see only one file, the project’s <strong>active manuscript</strong>. Choose it first: right-click the file → Active Manuscript. </>
              )}
              Each person gets their own link. A <strong>reviewer</strong> can read the active manuscript and leave comments and suggestions; they can’t change your text, and they can’t see each other’s notes.
              A <strong>collaborator</strong> gets every Markdown file in the project, can edit them and create new ones: their changes and yours are merged each time either of you syncs, and anything you both changed is kept side by side for you to settle.
              <strong> Copy link</strong> gives just the link; <strong>Copy invitation</strong> adds a short note with where to download MDEdit.
            </p>
            <ul className="share-list">
              {status?.reviewers.length === 0 && <li className="muted">No reviewers yet.</li>}
              {status?.reviewers.map((r) => {
                const c = counts.get(r.id);
                return (
                  <li key={r.id}>
                    <span className="grow-text">
                      {r.name}
                      <span className="muted small share-sub">
                        {' '}
                        {r.role === 'edit' ? 'can edit · ' : ''}
                        {r.chapters ? `${r.chapters.length} chapter${r.chapters.length === 1 ? '' : 's'} · ` : ''}
                        {c ? `${c.open} open of ${c.total} note${c.total === 1 ? '' : 's'}` : 'no notes yet'}
                        {when(r.createdAt) ? ` · invited ${when(r.createdAt)}` : ''}
                      </span>
                    </span>
                    <button type="button" onClick={() => void copyNote(r.link, `Link for ${r.name}`)}>Copy link</button>
                    <button type="button" onClick={() => void copyNote(inviteMessage(projectName, r.link, r.name, r.role), `Invitation for ${r.name}`)}>Copy invitation</button>
                    <button type="button" disabled={busy} onClick={() => void run(() => api.revokeReviewer(project, r.id))}>Remove</button>
                  </li>
                );
              })}
            </ul>
            {limited && (
              <fieldset className="share-chapters">
                <legend>
                  {role === 'edit' ? 'Chapters of the active manuscript this collaborator can edit (other files are shared whole)' : 'Chapters this reviewer can see'} <span className="muted small">({ticked.size} of {chapters.length})</span>
                </legend>
                <div className="share-chapters-tools small">
                  <button type="button" className="link" onClick={() => setTicked(new Set(chapters.map((c) => c.key)))}>All</button>
                  <button type="button" className="link" onClick={() => setTicked(new Set())}>None</button>
                  <span className="muted">Remembered for this manuscript.</span>
                </div>
                <div className="share-chapter-list" role="group" aria-label="Chapters">
                  {chapters.map((c) => (
                    <label key={c.key}>
                      <input type="checkbox" checked={ticked.has(c.key)} onChange={() => toggle(c.key)} />
                      <span>{c.title || 'Front matter'}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <form
              className="share-add"
              onSubmit={(e) => {
                e.preventDefault();
                if (!name.trim() || (limited && ticked.size === 0)) return;
                void run(async () => {
                  const r = await api.inviteReviewer(project, name.trim(), limited ? { keys: [...ticked], level } : null, role === 'edit' ? 'edit' : undefined);
                  setName('');
                  setNote((await copy(inviteMessage(projectName, r.link, r.name, r.role))) ? `Invitation for ${r.name} copied. Send it to them (use Copy link above for the link alone).` : r.link);
                });
              }}
            >
              <select value={role} onChange={(e) => setRole(e.target.value === 'edit' ? 'edit' : 'review')} aria-label="What they can do">
                <option value="review">Reviewer (comments)</option>
                <option value="edit">Collaborator (can edit)</option>
              </select>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Their name" maxLength={40} />
              <button type="submit" className="primary" disabled={busy || !name.trim() || (limited && ticked.size === 0)}>{busy ? 'Working…' : role === 'edit' ? 'Create editable link' : 'Create link'}</button>
            </form>
            {note && <div className="share-note" role="status">{note}</div>}
            {error && <div className="modal-error" role="alert">{error}</div>}
            <div className="modal-actions">
              {(status?.reviewers.length ?? 0) > 0 &&
                (confirmStop ? (
                  <button type="button" className="danger" disabled={busy} onClick={() => void run(async () => { await api.stopSharing(project); setConfirmStop(false); })}>
                    Yes, remove all {status!.reviewers.length} links
                  </button>
                ) : (
                  <button type="button" onClick={() => setConfirmStop(true)}>Stop sharing…</button>
                ))}
              <button type="button" onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
