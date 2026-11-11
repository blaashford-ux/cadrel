import type { SharedProject } from '../shared/review/sharedProject';
import type { ProjectSummary } from '../shared/projects';
import { Icon } from './Icon';

interface Props {
  shared: SharedProject[];
  onOpen(dir: string): void;
  /** Without it there is no Open invitation button: Cadrel joins Studios from its Studio menu, and shows what is shared with you in the one in use. */
  onJoin?(): void;
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
      activeManuscript: null, manuscriptGoals: {}, excludedFolders: [], editedChapters: {}, rewriteLinks: [], overrides: { chapterLevel: null, book: {} }
    }
  }));
}

/** Cadrel Reader's first screen: the projects shared with you, and the way to open another invitation. */
export function ReaderHome({ shared, onOpen, onJoin }: Props) {
  return (
    <main className="home" aria-label="Shared with me">
      <div className="home-inner">
        <header className="home-head">
          <div>
            <h1>Shared with me</h1>
            <p className="muted small">Read a manuscript someone asked you about, and leave comments and suggestions for them.</p>
          </div>
          {onJoin && (
            <div className="home-head-actions">
              <button type="button" className="primary big" onClick={onJoin}>
                <Icon name="plus" /> Open invitation…
              </button>
            </div>
          )}
        </header>
        {shared.length === 0 ? (
          <section className="empty-home">
            <h2>Nothing shared with you yet</h2>
            {onJoin ? (
              <p>When an author invites you, click the link in their message, or choose <strong>Open invitation…</strong> and paste it here.</p>
            ) : (
              <p>When the owner of a Studio you were invited to opens a manuscript to you, it appears here. Join a Studio from the Studio menu on Home, then switch to it.</p>
            )}
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
