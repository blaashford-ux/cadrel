interface Props {
  chapterIndex: number;
  chapterCount: number;
  words: number;
  dirty: boolean;
  autosaved: boolean;
  eol: '\n' | '\r\n';
  mode: 'visual' | 'source';
  /** The action Undo would reverse (null when there is none), how many are stacked, and what Redo would re-apply. */
  undoLabel: string | null;
  undoCount: number;
  redoLabel: string | null;
  onUndo(): void;
  onRedo(): void;
  /** The open project's totals, shown as a button that opens the Progress window. */
  project?: { total: number | null; goal: number | null; today: number } | null;
  onProgress?(): void;
  /** Google Drive sync (absent where it isn't available). */
  sync?: { state: 'off' | 'idle' | 'syncing' | 'error' | 'confirm'; progress?: { done: number; total: number } | null; onOpen(): void };
}

export function StatusBar(p: Props) {
  return (
    <footer className="statusbar" role="status">
      <span>
        Chapter {p.chapterIndex + 1} of {p.chapterCount}
      </span>
      <span>{p.words.toLocaleString()} {p.words === 1 ? 'word' : 'words'}</span>
      <span className={p.dirty ? 'unsaved' : ''}>
        {p.dirty ? (p.autosaved ? 'Unsaved changes · draft autosaved' : 'Unsaved changes') : 'All changes saved'}
      </span>
      <span className="spacer" />
      {p.project && (
        <button type="button" className="sb-undo sb-project" onClick={p.onProgress} title="Project progress">
          {p.project.total === null ? '-' : p.project.total.toLocaleString()}
          {p.project.total !== null && p.project.goal ? ` / ${p.project.goal.toLocaleString()} (${Math.min(100, Math.round((p.project.total / p.project.goal) * 100))}%)` : ''} words
          {p.project.total !== null && p.project.today > 0 ? ` · +${p.project.today.toLocaleString()} today` : ''}
        </button>
      )}
      {p.sync && (
        <button type="button" className={`sb-undo sb-sync s-${p.sync.state}`} onClick={p.sync.onOpen} title="Google Drive sync">
          {p.sync.state === 'off' ? 'Sync off' : p.sync.state === 'syncing' ? (p.sync.progress ? `Syncing ${p.sync.progress.done}/${p.sync.progress.total}` : 'Syncing…') : p.sync.state === 'error' ? 'Sync problem' : p.sync.state === 'confirm' ? 'Sync needs OK' : 'Synced'}
        </button>
      )}
      {p.undoLabel && (
        <button type="button" className="sb-undo" onClick={p.onUndo} title={`Undo: ${p.undoLabel} (Ctrl+Alt+Z)${p.undoCount > 1 ? ` — ${p.undoCount} steps available` : ''}`}>
          Undo{p.undoCount > 1 ? ` (${p.undoCount})` : ''}: {p.undoLabel}
        </button>
      )}
      {p.redoLabel && (
        <button type="button" className="sb-undo" onClick={p.onRedo} title={`Redo: ${p.redoLabel} (Ctrl+Alt+Y)`}>
          Redo
        </button>
      )}
      <span>{p.mode === 'source' ? 'Source' : 'Visual'}</span>
      <span>{p.eol === '\r\n' ? 'CRLF' : 'LF'}</span>
    </footer>
  );
}
