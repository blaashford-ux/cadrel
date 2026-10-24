import { useEffect, useMemo, useRef, useState } from 'react';
import { STATUS_LABELS, type ProjectSummary } from '../shared/projects';
import { useEscape } from './useEscape';

interface Props {
  projects: ProjectSummary[];
  currentPath: string | null;
  onOpen(path: string): void;
  onHome(): void;
  onNew(): void;
  onClose(): void;
}

interface Entry {
  key: string;
  label: string;
  detail?: string;
  run(): void;
}

/** Ctrl+K: type a few letters of a project's name and press Enter. */
export function QuickSwitcher({ projects, currentPath, onOpen, onHome, onNew, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEscape(onClose);
  useEffect(() => input.current?.focus(), []);

  const entries = useMemo<Entry[]>(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...projects].filter((p) => !p.meta.archived).sort((a, b) => (b.lastEdited ?? 0) - (a.lastEdited ?? 0));
    const matching = sorted.filter((p) => q === '' || p.name.toLowerCase().includes(q) || p.meta.templateName.toLowerCase().includes(q));
    const list: Entry[] = matching.map((p) => ({
      key: p.path,
      label: p.name,
      detail: `${STATUS_LABELS[p.meta.status]} · ${p.words.toLocaleString()} words${p.path === currentPath ? ' · open' : ''}`,
      run: () => onOpen(p.path)
    }));
    if ('projects home all projects'.includes(q) || q === '') list.push({ key: '#home', label: 'All projects…', run: onHome });
    if ('new project'.includes(q) || q === '') list.push({ key: '#new', label: 'New project…', run: onNew });
    return list;
  }, [projects, query, currentPath, onOpen, onHome, onNew]);

  useEffect(() => setIndex(0), [query]);
  const pick = (e: Entry | undefined) => {
    if (!e) return;
    onClose();
    e.run();
  };

  return (
    <div className="modal-backdrop quick">
      <div
        className="modal quick-switcher"
        role="dialog"
        aria-modal="true"
        aria-label="Switch project"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setIndex((i) => Math.min(entries.length - 1, i + 1)));
          else if (e.key === 'ArrowUp') (e.preventDefault(), setIndex((i) => Math.max(0, i - 1)));
          else if (e.key === 'Enter') (e.preventDefault(), pick(entries[index]));
        }}
      >
        <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Switch to a project…" aria-label="Project name" spellCheck={false} />
        <div className="quick-list" role="listbox">
          {entries.length === 0 && <div className="muted pad">No projects match.</div>}
          {entries.map((e, i) => (
            <button key={e.key} type="button" role="option" aria-selected={i === index} className={'quick-item' + (i === index ? ' hot' : '')} onMouseMove={() => setIndex(i)} onClick={() => pick(e)}>
              <span className="grow-text">{e.label}</span>
              {e.detail && <span className="muted small">{e.detail}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
