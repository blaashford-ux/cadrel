import logo from './logo.png';

interface Props {
  /** What is open, e.g. "Chapter 3 — book.md". */
  title: string;
  dirty: boolean;
  /** The file list can be opened (a project is open). */
  showFiles: boolean;
  onFiles(): void;
  /** Back to the Projects home (absent when already there). */
  onHome?(): void;
  onSave(): void;
  canSave: boolean;
  /** The Google Drive button (absent where sync isn't available). */
  /** Find & replace in the open file (absent when nothing is open). */
  find?: { open: boolean; onToggle(): void };
  /** Opens About (version and updates). */
  onAbout?(): void;
  sync?: { state: 'off' | 'idle' | 'syncing' | 'error' | 'confirm'; onOpen(): void };
}

/** The phone's top bar: file list, the open chapter, and Save (there are no menus or window buttons). */
export function MobileBar({ title, dirty, showFiles, onFiles, onHome, onSave, canSave, find, sync, onAbout }: Props) {
  return (
    <header className="mobilebar">
      {showFiles ? (
        <button type="button" className="mb-btn" aria-label="Files" onClick={onFiles}>
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 5h14M3 10h14M3 15h14" /></svg>
        </button>
      ) : (
        <img className="tb-logo" src={logo} alt="" width={24} height={24} />
      )}
      <div className="mb-title" title={title}>
        {showFiles ? title : 'MDEdit'}
        {dirty && <span className="dirty" aria-label="unsaved changes"> ●</span>}
      </div>
      {find && (
        <button type="button" className={`mb-btn${find.open ? ' on' : ''}`} aria-label="Find and replace" aria-pressed={find.open} onClick={find.onToggle}>
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="10.5" cy="10.5" r="6" />
            <path d="m15 15 5 5" />
          </svg>
        </button>
      )}
      {sync && (
        <button type="button" className={`mb-btn sync-btn s-${sync.state}`} aria-label={`Google Drive sync: ${sync.state === 'off' ? 'not connected' : sync.state}`} onClick={sync.onOpen}>
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 18a4 4 0 0 1-.6-7.96A6 6 0 0 1 18 9.5a4.25 4.25 0 0 1-.5 8.5H7Z" />
            {sync.state === 'off' && <path d="m4 4 16 16" />}
          </svg>
          {sync.state !== 'off' && sync.state !== 'idle' && <span className="sync-dot" aria-hidden />}
        </button>
      )}
      {onAbout && (
        <button type="button" className="mb-btn" aria-label="About MDEdit" onClick={onAbout}>
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5M12 8h.01" />
          </svg>
        </button>
      )}
      {onHome && (
        <button type="button" className="mb-btn text" onClick={onHome}>
          Projects
        </button>
      )}
      {showFiles && (
        <button type="button" className="mb-btn text primary" onClick={onSave} disabled={!canSave}>
          Save
        </button>
      )}
    </header>
  );
}
