import { Icon } from './Icon';
import { useEffect, useRef } from 'react';
import { navigate, type NavKey, type Row } from './treeRows';

interface Props {
  /** True for the file that goals follow (the project's active manuscript). */
  isManuscript?(row: Row): boolean;
  rows: Row[];
  focusKey: string | null;
  /** Key of the chapter row shown in the active tab. */
  activeKey: string | null;
  /** Files whose tab has unsaved edits. */
  dirtyFiles: Set<string>;
  onFocusKey(key: string): void;
  /** Click / Enter on a row. */
  onActivate(row: Row): void;
  onToggle(row: Row): void;
  onContextMenu(row: Row, x: number, y: number): void;
  onRename(row: Row): void;
  onDelete(row: Row): void;
  onMoveChapter(row: Row, delta: -1 | 1): void;
}

const NAV_KEYS = new Set<string>(['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter']);

export function Tree(p: Props) {
  const host = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLDivElement>());

  // Keep DOM focus on the focused row, but only if the tree already has focus (don't steal it).
  useEffect(() => {
    if (!p.focusKey || !host.current?.contains(document.activeElement)) return;
    els.current.get(p.focusKey)?.focus();
  }, [p.focusKey]);

  const rowByKey = (key: string | null) => p.rows.find((r) => r.key === key) ?? null;
  const tabbable = rowByKey(p.focusKey)?.key ?? p.rows[0]?.key ?? null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    const row = rowByKey(p.focusKey);
    if (e.altKey && row?.kind === 'chapter' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      p.onMoveChapter(row, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (row && e.key === 'F2' && row.kind !== 'chapter') {
      e.preventDefault();
      p.onRename(row);
    } else if (row && e.key === 'Delete') {
      e.preventDefault();
      p.onDelete(row);
    } else if (row && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
      e.preventDefault();
      const r = els.current.get(row.key)?.getBoundingClientRect();
      p.onContextMenu(row, (r?.left ?? 0) + 24, (r?.bottom ?? 0) - 4);
    } else if (NAV_KEYS.has(e.key) || e.key === ' ') {
      e.preventDefault();
      const res = navigate(p.rows, p.focusKey ?? tabbable, e.key === ' ' ? 'Enter' : (e.key as NavKey));
      if (res.focus) p.onFocusKey(res.focus);
      const target = rowByKey(res.expand ?? res.collapse ?? res.activate ?? null);
      if (target && (res.expand || res.collapse)) p.onToggle(target);
      else if (target && res.activate) p.onActivate(target);
    }
  };

  return (
    <div className="tree" role="tree" aria-label="Markdown files" ref={host} onKeyDown={onKeyDown}>
      {p.rows.map((r) => {
        const active = r.key === p.activeKey;
        const dirty = r.kind === 'file' && p.dirtyFiles.has(r.path);
        return (
          <div
            key={r.key}
            ref={(el) => {
              if (el) els.current.set(r.key, el);
              else els.current.delete(r.key);
            }}
            role="treeitem"
            aria-level={r.depth + 1}
            aria-expanded={r.expandable ? r.expanded : undefined}
            aria-selected={active}
            tabIndex={r.key === tabbable ? 0 : -1}
            className={'row ' + r.kind + (active ? ' active' : '') + (r.key === p.focusKey ? ' focused' : '')}
            style={{ paddingLeft: 8 + r.depth * 14 }}
            onFocus={() => p.onFocusKey(r.key)}
            onClick={() => p.onActivate(r)}
            onContextMenu={(e) => {
              e.preventDefault();
              p.onContextMenu(r, e.clientX, e.clientY);
            }}
          >
            {r.expandable ? (
              <span
                className="caret"
                aria-hidden
                onClick={(e) => {
                  e.stopPropagation();
                  p.onFocusKey(r.key);
                  p.onToggle(r);
                }}
              >
                <Icon name="chevron" size={14} className={r.expanded ? 'open' : ''} />
              </span>
            ) : (
              <span className="caret" aria-hidden />
            )}
            <span className="label">
              {r.kind !== 'chapter' && <Icon name={r.kind === 'dir' ? 'folder' : 'file'} size={15} className={'kind-' + r.kind} />}
              <span className="text">{r.label}</span>
            </span>
            {p.isManuscript?.(r) && (
              <span className="ms-badge" title="Active manuscript: word-count goals follow this file" aria-label="active manuscript">
                <Icon name="target" size={14} />
              </span>
            )}
            {r.marked && (
              <span className="book-badge" title="Marked for export" aria-label="marked for export">
                <Icon name="book" size={14} />
              </span>
            )}
            {dirty && (
              <span className="dirty" aria-label="unsaved changes">
                ●
              </span>
            )}
            {r.words !== undefined && <span className="words">{r.words.toLocaleString()}</span>}
          </div>
        );
      })}
    </div>
  );
}
