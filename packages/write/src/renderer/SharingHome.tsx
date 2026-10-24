import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SyncStatus } from '../shared/api';
import type { ProjectsConfig, RootListing } from '../shared/projects';
import { parseReviewFile } from '../shared/review/comments';
import type { ShareSummary } from '../shared/review/share';
import { Icon } from './Icon';
import { ShareDialog } from './ShareDialog';
import { timeAgo } from './ProjectsHome';

interface Props {
  config: ProjectsConfig | null;
  listing: RootListing | null;
  sync: SyncStatus | null;
  onBack(): void;
  onConnect(): void;
}

interface Row extends ShareSummary {
  /** The project's folder, when it still exists in the Root Folder. */
  path: string | null;
  open: number;
}

/** Every project that has share links, with a way into each one's sharing settings (and to share another project). */
export function SharingHome({ config, listing, sync, onBack, onConnect }: Props) {
  const api = window.mdedit;
  const [shares, setShares] = useState<ShareSummary[] | null>(null);
  const [open, setOpen] = useState<Record<string, number>>({});
  const [managing, setManaging] = useState<{ path: string; name: string } | null>(null);

  const projects = listing?.projects ?? [];
  const pathOf = useCallback((name: string) => projects.find((p) => p.name === name)?.path ?? null, [projects]);

  const load = useCallback(() => {
    void api.listShares().then(async (list) => {
      setShares(list);
      const counts: Record<string, number> = {};
      for (const s of list) {
        const path = pathOf(s.project);
        if (!path) continue;
        const files = await api.listReviews(path).catch(() => []);
        counts[s.project] = files.reduce((n, f) => n + (parseReviewFile(f.text)?.items.filter((i) => i.status === 'open').length ?? 0), 0);
      }
      setOpen(counts);
    }).catch(() => setShares([]));
  }, [api, pathOf]);
  useEffect(load, [load]);

  const rows: Row[] = useMemo(() => (shares ?? []).map((s) => ({ ...s, path: pathOf(s.project), open: open[s.project] ?? 0 })), [shares, open, pathOf]);
  const sharedNames = new Set(rows.map((r) => r.project));
  const others = projects.filter((p) => !sharedNames.has(p.name) && !p.meta.archived);
  const connected = sync?.connected === true;

  return (
    <main className="home" aria-label="Sharing">
      <div className="home-inner">
        <header className="home-head">
          <div>
            <h1>Sharing</h1>
            <p className="muted small">Projects you’ve invited people to review. Each reviewer has their own link.</p>
          </div>
          <div className="home-head-actions">
            <button type="button" onClick={onBack}>← Projects</button>
          </div>
        </header>

        {!connected && (
          <div className="banner warn" role="alert">
            Sharing uses Google Drive. <button type="button" onClick={onConnect}>Connect Google Drive…</button>
          </div>
        )}

        {shares === null && <p className="muted">Loading…</p>}
        {shares !== null && rows.length === 0 && (
          <div className="home-empty">
            <h2>Nothing shared yet</h2>
            <p className="muted small">Pick a project below to create its first link, or open a project and choose Notes → Share….</p>
          </div>
        )}

        <div className="project-grid">
          {rows.map((r) => (
            <div key={r.project} className="project-card" role="group" aria-label={r.project}>
              <div className="card-top">
                <span className="card-name">{r.project}</span>
              </div>
              <div className="card-meta">
                <span className="muted small">
                  {r.reviewers.length} reviewer{r.reviewers.length === 1 ? '' : 's'}: {r.reviewers.map((x) => x.name).join(', ')}
                </span>
              </div>
              <div className="card-words">
                <strong>{r.open}</strong> <span className="muted">open note{r.open === 1 ? '' : 's'}</span>
              </div>
              <div className="card-foot muted small">{r.publishedAt ? `Text shared ${timeAgo(Date.parse(r.publishedAt))}` : 'Not shared yet'}</div>
              {r.path ? (
                <button type="button" className="primary" onClick={() => setManaging({ path: r.path!, name: r.project })}>Manage links…</button>
              ) : (
                <>
                  <div className="muted small">The project folder wasn’t found (renamed or deleted).</div>
                  <button
                    type="button"
                    onClick={() => config && void api.stopSharing(`${config.root.replace(/[\\/]+$/, '')}/${r.project}`).then(load)}
                  >
                    Remove its links
                  </button>
                </>
              )}
            </div>
          ))}
        </div>

        {others.length > 0 && (
          <section className="other-folders">
            <h3>Not shared yet</h3>
            {others.map((p) => (
              <div className="other-folder" key={p.path}>
                <Icon name="folder" size={15} className="kind-dir" /> <span className="grow-text">{p.name}</span>
                <button type="button" onClick={() => setManaging({ path: p.path, name: p.name })}>Share…</button>
              </div>
            ))}
          </section>
        )}
      </div>

      {managing && (
        <ShareDialog
          project={managing.path}
          projectName={managing.name}
          sync={sync}
          onConnect={() => {
            setManaging(null);
            onConnect();
          }}
          onClose={() => {
            setManaging(null);
            load();
          }}
        />
      )}
    </main>
  );
}
