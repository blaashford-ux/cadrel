import { useEffect, useRef, useState } from 'react';
import { byRecentlyOpened, STATUS_LABELS, type ProjectSummary } from '../shared/projects';
import { Icon } from './Icon';

interface Props {
  /** Name shown on the button: the project, or the folder when it isn't one. */
  name: string;
  isProject: boolean;
  projects: ProjectSummary[];
  currentPath: string | null;
  /** Paths of the projects opened on this device, most recent first. */
  openedOrder: string[];
  onOpen(path: string): void;
  onHome(): void;
  onNew(): void;
  /** Absent where the app can't open arbitrary folders (the phone). */
  onOpenFolder?(): void;
  onSettings(): void;
  onProgress(): void;
}

/** The sidebar header: the open project's name, with a menu to jump to another project or back to the Projects home. */
export function ProjectSwitcher({ name, isProject, projects, currentPath, openedOrder, onOpen, onHome, onNew, onOpenFolder, onSettings, onProgress }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);

  // The projects opened most recently come first; ones never opened here follow, newest edit first.
  const recent = byRecentlyOpened(projects, openedOrder, currentPath).slice(0, 6);

  return (
    <div className="switcher" ref={root}>
      <button type="button" className="switcher-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title="Switch project (Ctrl+K)">
        <Icon name={isProject ? 'book' : 'folder'} size={15} />
        <span className="switcher-name">{name}</span>
        <Icon name="down" size={14} />
      </button>
      {open && (
        <div className="switcher-menu" role="menu">
          {isProject && (
            <>
              <button type="button" role="menuitem" onClick={() => (setOpen(false), onProgress())}>
                Progress…
              </button>
              <button type="button" role="menuitem" onClick={() => (setOpen(false), onSettings())}>
                Project settings…
              </button>
              <div className="mb-sep" />
            </>
          )}
          {recent.length > 0 && <div className="switcher-label">Switch to</div>}
          {recent.map((p) => (
            <button key={p.path} type="button" role="menuitem" onClick={() => (setOpen(false), onOpen(p.path))}>
              <span className="grow-text">{p.name}</span>
              <span className={`status-chip s-${p.meta.status}`}>{STATUS_LABELS[p.meta.status]}</span>
            </button>
          ))}
          <button type="button" role="menuitem" onClick={() => (setOpen(false), onHome())}>
            All projects…
          </button>
          <button type="button" role="menuitem" onClick={() => (setOpen(false), onNew())}>
            New project…
          </button>
          {onOpenFolder && (
            <button type="button" role="menuitem" onClick={() => (setOpen(false), onOpenFolder())}>
              Open folder…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
