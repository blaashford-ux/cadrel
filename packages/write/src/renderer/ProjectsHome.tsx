import { useMemo, useState } from 'react';
import { StageChip } from './StageChip';
import { goalFor, type ProjectSummary, type ProjectsConfig, type RootListing } from '../shared/projects';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { Icon } from './Icon';
import type { SharedProject } from '../shared/review/share';
import { justLongPressed, longPressProps } from './longPress';

interface Props {
  config: ProjectsConfig | null;
  listing: RootListing | null;
  loading: boolean;
  onOpen(path: string): void;
  /** Absent where Cadrel's Projects page creates and manages projects. */
  onNew?(): void;
  onChangeRoot?(): void;
  onOpenFolder?(): void;
  onRetry(): void;
  onConvert?(path: string): void;
  onRename?(p: ProjectSummary): void;
  onDuplicate?(p: ProjectSummary): void;
  onDelete?(p: ProjectSummary): void;
  onArchive?(p: ProjectSummary, archived: boolean): void;
  onProperties?(p: ProjectSummary): void;
  onReveal?(path: string): void;
  /** Projects other people shared with this person (only where sharing is available). */
  shared?: SharedProject[];
  onOpenShared?(dir: string): void;
  onJoin?(): void;
  /** Opens the Sharing page (where sharing is available). */
  onSharing?(): void;
}

export function timeAgo(ms: number | null, now = Date.now()): string {
  if (ms === null) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} day${d === 1 ? '' : 's'} ago`;
  if (d < 90) return `${Math.round(d / 7)} weeks ago`;
  return new Date(ms).toLocaleDateString();
}

type Sort = 'recent' | 'name' | 'words';

/** The Projects home: every project in the Root Folder as a card, plus the folders that could become projects. */
export function ProjectsHome(p: Props) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const [showArchived, setShowArchived] = useState(false);
  const [status, setStatus] = useState<string>('all');
  const [menu, setMenu] = useState<{ x: number; y: number; project: ProjectSummary } | null>(null);

  const all = p.listing?.projects ?? [];
  const stages = useMemo(() => {
    const seen = new Map<string, string>();
    for (const x of all) if (x.meta.stage) seen.set(x.meta.stage.key, x.meta.stage.name);
    return [...seen].map(([key, name]) => ({ key, name }));
  }, [all]);
  const archivedCount = all.filter((x) => x.meta.archived).length;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = all.filter((x) => x.meta.archived === showArchived && (status === 'all' || x.meta.stage?.key === status) && (q === '' || x.name.toLowerCase().includes(q) || x.meta.templateName.toLowerCase().includes(q)));
    return list.sort((a, b) =>
      sort === 'name' ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : sort === 'words' ? (b.words ?? -1) - (a.words ?? -1) : (b.lastEdited ?? 0) - (a.lastEdited ?? 0)
    );
  }, [all, query, sort, showArchived, status]);

  const items = (x: ProjectSummary): MenuItem[] => [
    { label: 'Open', onClick: () => p.onOpen(x.path) },
    ...(p.onProperties ? [{ label: 'Project settings…', onClick: () => p.onProperties!(x) }] : []),
    ...(p.onRename ? [{ label: 'Rename…', onClick: () => p.onRename!(x) }] : []),
    ...(p.onDuplicate ? [{ label: 'Duplicate…', onClick: () => p.onDuplicate!(x) }] : []),
    ...(p.onArchive ? [{ label: x.meta.archived ? 'Unarchive' : 'Archive', onClick: () => p.onArchive!(x, !x.meta.archived) }] : []),
    ...(p.onReveal ? [{ label: 'Show in File Explorer', onClick: () => p.onReveal!(x.path) }] : []),
    ...(p.onDelete ? [{ label: 'Delete…', danger: true, onClick: () => p.onDelete!(x) }] : [])
  ];

  const missingRoot = p.listing && !p.listing.exists;

  return (
    <main className="home" aria-label="Projects">
      <div className="home-inner">
        <header className="home-head">
          <div>
            <h1>Projects</h1>
            <div className="home-root">
              <Icon name="folder" size={14} />
              <code className="path" title="Root Folder">
                {p.config?.root ?? '…'}
              </code>
              {p.onChangeRoot && (
                <button type="button" className="link-btn" onClick={p.onChangeRoot}>
                  Change…
                </button>
              )}
              {p.onReveal && p.config?.rootExists && (
                <button type="button" className="link-btn" onClick={() => p.onReveal!(p.config!.root)}>
                  Show in Explorer
                </button>
              )}
            </div>
          </div>
          <div className="home-head-actions">
            {p.onOpenFolder && (
              <button type="button" onClick={p.onOpenFolder} title="Open any folder of Markdown files, even outside the Root Folder (Ctrl+O)">
                Open Folder…
              </button>
            )}
            {p.onSharing && (
              <button type="button" onClick={p.onSharing} title="Projects you've shared for review, and their links">
                Sharing
              </button>
            )}
            {p.onNew && (
              <button type="button" className="primary big" onClick={p.onNew}>
                <Icon name="plus" /> New Project
              </button>
            )}
          </div>
        </header>

        {missingRoot && (
          <div className="banner warn" role="alert">
            The Root Folder <code className="path">{p.config?.root}</code> can’t be found (renamed, on a drive that isn’t connected, or not created yet).{' '}
            {p.onChangeRoot && <button onClick={p.onChangeRoot}>Choose Root Folder…</button>} <button onClick={p.onRetry}>Try again</button> {p.onNew && <button onClick={p.onNew}>Create it with a new project</button>}
          </div>
        )}

        {all.length > 0 && (
          <div className="home-tools">
            <input type="search" className="filter" placeholder="Search projects" aria-label="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort projects">
              <option value="recent">Recently edited</option>
              <option value="name">Name</option>
              <option value="words">Most words</option>
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by stage">
              <option value="all">All stages</option>
              {stages.map((st) => (
                <option key={st.key} value={st.key}>
                  {st.name}
                </option>
              ))}
            </select>
            {archivedCount > 0 && (
              <button type="button" className={showArchived ? 'on' : ''} onClick={() => setShowArchived(!showArchived)} aria-pressed={showArchived}>
                {showArchived ? 'Showing archived' : `Archived (${archivedCount})`}
              </button>
            )}
          </div>
        )}

        {p.loading && !p.listing && <p className="muted">Loading…</p>}

        {p.listing?.exists && all.length === 0 && (
          <div className="home-empty">
            <h2>{p.onNew ? 'Start your first project' : 'Nothing to write in yet'}</h2>
            {p.onNew ? (
              <>
                <p className="muted">A project is a folder with the structure you choose: manuscript, characters, research and exports. Pick a template to begin.</p>
                <div className="template-tiles">
                  {(p.config?.templates ?? []).map((t) => (
                    <button key={t.id} type="button" className="template-tile" onClick={p.onNew}>
                      <strong>{t.name}</strong>
                      <span className="muted small">{t.description}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p className="muted">Projects are created and managed on the Projects page. Create one there and choose Open in Write.</p>
            )}
          </div>
        )}

        <div className="project-grid">
          {shown.map((x) => {
            const g = goalFor(x.meta);
            const pct = g && x.words !== null ? Math.min(100, Math.round((x.words / g.targetWords) * 100)) : null;
            return (
              <div
                key={x.path}
                className={'project-card' + (x.meta.archived ? ' archived' : '')}
                role="button"
                tabIndex={0}
                aria-label={`Open ${x.name}`}
                onClick={() => !justLongPressed() && p.onOpen(x.path)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') p.onOpen(x.path);
                  else if (e.key === 'F2') p.onRename?.(x);
                  else if (e.key === 'ContextMenu') setMenu({ x: 200, y: 200, project: x });
                }}
                {...longPressProps((mx, my) => setMenu({ x: mx, y: my, project: x }))}
              >
                <div className="card-top">
                  <span className="card-name">{x.name}</span>
                  <button
                    type="button"
                    className="card-more"
                    aria-label={`Actions for ${x.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setMenu({ x: r.left, y: r.bottom, project: x });
                    }}
                  >
                    ⋯
                  </button>
                </div>
                <div className="card-meta">
                  {x.meta.stage && <StageChip stage={x.meta.stage} />}
                  <span className="muted small">{x.meta.templateName}</span>
                </div>
                {x.meta.activeManuscript && (
                  <div className="card-ms" title="Active manuscript">
                    <Icon name="target" size={12} /> {x.meta.activeManuscript.split('/').pop()}
                  </div>
                )}
                <div className="card-words">
                  <strong>{x.words === null ? '-' : x.words.toLocaleString()}</strong> <span className="muted">words{g ? ` of ${g.targetWords.toLocaleString()}` : ''}</span>
                </div>
                {pct !== null && (
                  <div className="goal-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${pct}% of the word goal`}>
                    <div className="goal-fill" style={{ width: `${pct}%` }} />
                  </div>
                )}
                <div className="card-foot muted small">Edited {timeAgo(x.lastEdited)}</div>
              </div>
            );
          })}
        </div>
        {all.length > 0 && shown.length === 0 && <p className="muted">{query ? `No projects match “${query}”.` : status !== 'all' ? `No projects in ${stages.find((st) => st.key === status)?.name ?? 'that stage'}.` : showArchived ? 'No archived projects.' : 'No active projects.'}</p>}

        {(p.listing?.folders.length ?? 0) > 0 && (
          <section className="other-folders">
            <h3>Other folders in the Root Folder</h3>
            <p className="muted small">{p.onConvert ? 'These aren’t projects yet. Converting one only adds a hidden marker; your files aren’t touched.' : 'These aren’t projects yet. Adopt one on the Projects page to manage it there.'}</p>
            {p.listing!.folders.map((f) => (
              <div className="other-folder" key={f.path}>
                <Icon name="folder" size={15} className="kind-dir" /> <span className="grow-text">{f.name}</span>
                {p.onConvert && (
                  <button type="button" onClick={() => p.onConvert!(f.path)}>
                    Convert to project
                  </button>
                )}
                <button type="button" onClick={() => p.onOpen(f.path)} title="Open it as a plain folder">
                  Open
                </button>
              </div>
            ))}
          </section>
        )}
        {p.onJoin && (
          <section className="other-folders shared-with-me">
            <h3>Shared with me</h3>
            {(p.shared ?? []).length === 0 && <p className="muted small">Projects other people ask you to review appear here.</p>}
            {(p.shared ?? []).map((sp) => (
              <div className="other-folder" key={sp.dir}>
                <Icon name="folder" size={15} className="kind-dir" /> <span className="grow-text">{sp.project}</span>
                <button type="button" onClick={() => p.onOpenShared?.(sp.dir)}>Open</button>
              </div>
            ))}
            <button type="button" onClick={p.onJoin}>Open invitation…</button>
          </section>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items(menu.project)} onClose={() => setMenu(null)} />}
    </main>
  );
}
