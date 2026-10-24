import { Icon } from './Icon';
import { basename, dirname } from '../shared/paths';
import type { Tab } from './workspace';

interface Props {
  tabs: Tab[];
  activeId: string | null;
  onActivate(id: string): void;
  onClose(id: string): void;
}

/** File name, plus the parent folder when two open files share a name. */
export function tabLabels(tabs: Pick<Tab, 'id' | 'file'>[]): Map<string, string> {
  const counts = new Map<string, number>();
  tabs.forEach((t) => counts.set(basename(t.file), (counts.get(basename(t.file)) ?? 0) + 1));
  return new Map(
    tabs.map((t) => {
      const name = basename(t.file);
      return [t.id, (counts.get(name) ?? 0) > 1 ? `${name} — ${basename(dirname(t.file))}` : name] as const;
    })
  );
}

export function Tabs({ tabs, activeId, onActivate, onClose }: Props) {
  const labels = tabLabels(tabs);
  if (tabs.length === 0) return null;
  return (
    <div className="tabs" role="tablist" aria-label="Open files">
      {tabs.map((t) => {
        const active = t.id === activeId;
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            className={'tab' + (active ? ' active' : '')}
            title={t.file}
            onClick={() => onActivate(t.id)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(t.id);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onActivate(t.id);
            }}
          >
            <span className="tab-name">{labels.get(t.id)}</span>
            {t.draft !== null && (
              <span className="dirty" title="Unsaved changes" aria-label="unsaved changes">
                ●
              </span>
            )}
            <button
              className="tab-close"
              aria-label={`Close ${basename(t.file)}`}
              title="Close (Ctrl+W)"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
