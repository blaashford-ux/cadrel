import { useEffect, useState } from 'react';
import { chapterKeys, splitChapters } from '../shared/chapters';
import { useEscape } from './useEscape';

interface Props {
  /** The manuscript (absolute path). */
  file: string;
  fileName: string;
  /** The heading level chapters are split at. */
  level: number;
  onClose(): void;
}

/**
 * Which chapters of the active manuscript the Studio's Beta Readers are sent. A Beta Reader has no access until the author gives them the
 * project (People, in the Studio); this says what they may read once they have it. A chapter that is off, or added later, is never sent.
 */
export function BetaReadDialog({ file, fileName, level, onClose }: Props) {
  const lock = window.cadrelWrite.fileLock;
  const [chapters, setChapters] = useState<{ key: string; title: string }[] | null>(null);
  const [on, setOn] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEscape(onClose);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        if (!lock?.betaRead) throw new Error('Beta reading needs the Studio.');
        const [{ text }, state] = await Promise.all([window.cadrelWrite.readFile(file), lock.betaRead(file)]);
        if (!state) throw new Error('This file is not in the Studio’s vault yet, so it cannot be shared. Check it in first.');
        const list = chapterKeys(splitChapters(text, level));
        if (!live) return;
        const keys = new Set(list.map((c) => c.key));
        // a switch for a chapter that no longer exists is dropped, so a renamed chapter comes back off
        const current = new Set(state.chapters.filter((k) => keys.has(k)));
        setChapters(list);
        setOn(current);
        setSaved(current);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [file, level]);

  const toggle = (key: string) => {
    setDone(false);
    setOn((t) => {
      const n = new Set(t);
      if (!n.delete(key)) n.add(key);
      return n;
    });
  };
  const dirty = chapters !== null && (on.size !== saved.size || [...on].some((k) => !saved.has(k)));

  const save = async () => {
    if (!lock?.setBetaRead || !chapters) return;
    setBusy(true);
    setError(null);
    try {
      const keys = chapters.filter((c) => on.has(c.key)).map((c) => c.key);
      const r = await lock.setBetaRead(file, level, keys);
      const now = new Set(r.chapters);
      setOn(now);
      setSaved(now);
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal share-dialog" role="dialog" aria-modal="true" aria-label="Manage Beta Read">
        <h3>Beta read “{fileName}”</h3>
        <p className="modal-hint">
          Beta Readers are invited to the Studio like anyone else and see nothing until they are given this project. They then read this manuscript in the chapters switched on here and leave notes; they cannot change the text. A chapter that is off, or that you add later, is never sent to them.
        </p>
        {chapters === null && !error && <p className="muted">Loading…</p>}
        {chapters !== null && (
          <fieldset className="share-chapters">
            <legend>
              Chapters Beta Readers can read <span className="muted small">({on.size} of {chapters.length})</span>
            </legend>
            <div className="share-chapters-tools small">
              <button type="button" className="link" onClick={() => { setDone(false); setOn(new Set(chapters.map((c) => c.key))); }}>All on</button>
              <button type="button" className="link" onClick={() => { setDone(false); setOn(new Set()); }}>All off</button>
            </div>
            <div className="share-chapter-list" role="group" aria-label="Chapters">
              {chapters.map((c) => (
                <label key={c.key}>
                  <input type="checkbox" checked={on.has(c.key)} onChange={() => toggle(c.key)} />
                  <span>{c.title || 'Front matter'}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {done && <div className="share-note" role="status">Saved. Beta Readers see the chapters switched on the next time they open the project.</div>}
        {error && <div className="modal-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>{dirty ? 'Cancel' : 'Close'}</button>
          <button type="button" className="primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
