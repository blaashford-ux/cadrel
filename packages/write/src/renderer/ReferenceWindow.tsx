import { useEffect, useMemo, useRef, useState } from 'react';
import type { TreeNode } from '../shared/api';
import { relativeTo } from '../shared/projects';
import { Icon } from './Icon';
import { rowsFiles } from './treeRows';

interface Props {
  root: TreeNode | null;
  /** The folder the files are named relative to (the project, or the folder that is open). */
  base: string;
  /** A file to show at once, if one was asked for. */
  initial?: string | null;
  onClose(): void;
}

const W = 460;
const H = 520;

/**
 * Check Reference: another file, read-only, in a window that floats over the app. It is not a modal: nothing is dimmed or blocked, it keeps
 * its place in front when the editor has focus, and it can be dragged and resized, so the writer can read it while typing into their own document.
 */
export function ReferenceWindow({ root, base, initial = null, onClose }: Props) {
  const [file, setFile] = useState<string | null>(initial);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState(() => ({ x: Math.max(8, window.innerWidth - W - 24), y: 72 }));
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  const files = useMemo(() => rowsFiles(root).map((p) => ({ path: p, rel: relativeTo(base, p) })), [root, base]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return files.filter((f) => !q || f.rel.toLowerCase().includes(q)).slice(0, 200);
  }, [files, query]);

  // Read the file, and again when the window regains focus, so a reference someone else just changed is not out of date. Read only: nothing is written.
  useEffect(() => {
    if (!file) return;
    let live = true;
    const read = () =>
      window.cadrelWrite.readFile(file).then(
        (r) => live && (setText(r.text), setError('')),
        (e) => live && setError(String((e as Error)?.message ?? e))
      );
    void read();
    window.addEventListener('focus', read);
    return () => {
      live = false;
      window.removeEventListener('focus', read);
    };
  }, [file]);

  const clamp = (x: number, y: number) => ({
    x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth - 80)),
    y: Math.min(Math.max(0, y), Math.max(0, window.innerHeight - 40))
  });
  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (drag.current) setPos(clamp(e.clientX - drag.current.dx, e.clientY - drag.current.dy));
  };
  const onUp = () => (drag.current = null);

  return (
    <div ref={box} className="ref-window" role="dialog" aria-label="Reference" style={{ left: pos.x, top: pos.y, width: W, height: H }}>
      <div className="ref-head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <strong className="ref-title">{file ? relativeTo(base, file) : 'Check Reference'}</strong>
        {file && <button type="button" title="Choose another file" onClick={() => (setFile(null), setText(''))}>Change</button>}
        <button type="button" aria-label="Close reference" title="Close" onClick={onClose}><Icon name="close" size={14} /></button>
      </div>
      {!file ? (
        <div className="ref-pick">
          <input autoFocus aria-label="Find a file" placeholder="Find a file to read…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && shown[0] && setFile(shown[0].path)} />
          {shown.length === 0 ? <p className="muted">No files match.</p> : shown.map((f) => <button key={f.path} type="button" className="ref-item" onClick={() => setFile(f.path)}>{f.rel}</button>)}
        </div>
      ) : (
        <>
          {error && <div className="banner error" role="alert">{error}</div>}
          <pre className="ref-text" tabIndex={0} aria-label={`${relativeTo(base, file)} (read only)`}>{text}</pre>
        </>
      )}
    </div>
  );
}
