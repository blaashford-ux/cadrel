import type { SharedProject } from '../shared/review/share';
import type { ProjectSummary } from '../shared/projects';
import type { SyncStatus } from '../shared/api';
import { Icon } from './Icon';

interface Props {
  shared: SharedProject[];
  /** Null until the first answer. */
  sync: SyncStatus | null;
  onOpen(dir: string): void;
  onJoin(): void;
  onConnect(): void;
}

/** The projects people shared with this reader, as the project switchers list them (they are not the reader's own projects). */
export function sharedAsSummaries(shared: SharedProject[]): ProjectSummary[] {
  return shared.map((sp) => ({
    path: sp.dir,
    name: sp.project,
    words: null,
    files: 0,
    lastEdited: null,
    meta: {
      version: 1, id: sp.dir, name: sp.project, templateId: '', templateName: '', createdAt: '', notes: '', archived: false, goal: null,
      activeManuscript: null, manuscriptGoals: {}, excludedFolders: [], editedChapters: {}, overrides: { chapterLevel: null, book: {} }
    }
  }));
}

/** Cadrel Reader's first screen: the projects shared with you, and the way to open another invitation. */
export function ReaderHome({ shared, sync, onOpen, onJoin, onConnect }: Props) {
  const needsGoogle = sync !== null && !sync.connected;
  return (
    <main className="home" aria-label="Shared with me">
      <div className="home-inner">
        <header className="home-head">
          <div>
            <h1>Shared with me</h1>
            <p className="muted small">Read a manuscript someone asked you about, and leave comments and suggestions for them.</p>
          </div>
          <div className="home-head-actions">
            <button type="button" className="primary big" onClick={onJoin}>
              <Icon name="plus" /> Open invitation…
            </button>
          </div>
        </header>
        {needsGoogle && (
          <div className="banner info" role="status">
            <span>Connect Google Drive so your comments reach the author.</span> <button type="button" onClick={onConnect}>Connect Google Drive</button>
          </div>
        )}
        {shared.length === 0 ? (
          <section className="empty-home">
            <h2>Nothing shared with you yet</h2>
            <p>When an author invites you, click the link in their message, or choose <strong>Open invitation…</strong> and paste it here.</p>
          </section>
        ) : (
          <section className="other-folders shared-with-me">
            {shared.map((sp) => (
              <div className="other-folder" key={sp.dir}>
                <Icon name="folder" size={15} className="kind-dir" /> <span className="grow-text">{sp.project}</span>
                <button type="button" onClick={() => onOpen(sp.dir)}>Open</button>
              </div>
            ))}
          </section>
        )}
      </div>
    </main>
  );
}
