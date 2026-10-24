import { useEffect, useState } from 'react';
import { basename } from '../shared/paths';
import type { ProjectsConfig } from '../shared/projects';

interface Props {
  config: ProjectsConfig | null;
  /** The folder the previous version had open, offered once as a project. */
  lastFolder: string | null;
  /** Finished; `opened` is a project to open straight away. */
  onDone(opened: string | null): void | Promise<void>;
}

/** First run: pick the Root Folder where projects live, and (for upgrades) adopt the folder that was open before. */
export function WelcomeDialog({ config, lastFolder, onDone }: Props) {
  const [root, setRoot] = useState<string | null>(null);
  const [adopt, setAdopt] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (config) setRoot(config.rootFolder ?? config.defaultRoot);
  }, [config]);

  const pick = async () => {
    const f = await window.mdedit.pickFolder();
    if (f) setRoot(f);
  };

  const finish = async () => {
    if (!root || busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.mdedit.setProjectsConfig({ rootFolder: root, setupDone: true });
      let opened: string | null = null;
      if (lastFolder && adopt) {
        await window.mdedit.scanFolder(lastFolder); // lets the app work with a folder outside the Root
        const existing = await window.mdedit.getProjectMeta(lastFolder);
        if (!existing) await window.mdedit.convertFolder(lastFolder);
        opened = lastFolder;
      }
      await onDone(opened);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal welcome" role="dialog" aria-modal="true" aria-label="Welcome to MDEdit">
        <h3>Welcome to MDEdit</h3>
        <p>
          Your writing is organised into <strong>projects</strong>: a folder for each book, with subfolders for the manuscript, notes and research. All of them live inside one{' '}
          <strong>Root Folder</strong>.
        </p>
        <div className="field">
          <span className="field-label">Root Folder</span>
          <div className="root-pick">
            <code className="root-path" title={root ?? ''}>
              {root ?? '…'}
            </code>
            <button type="button" onClick={() => void pick()}>
              Change…
            </button>
          </div>
          <span className="field-hint">It will be created if it doesn’t exist. You can change it later in Settings → Projects.</span>
        </div>
        {lastFolder && (
          <label className="check-row">
            <input type="checkbox" checked={adopt} onChange={(e) => setAdopt(e.target.checked)} /> Also keep working on “{basename(lastFolder)}” as a project
            <span className="field-hint">It stays where it is; MDEdit adds a small hidden .mdedit folder to it.</span>
          </label>
        )}
        {error && <div className="banner error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="primary" onClick={() => void finish()} disabled={!root || busy}>
            {busy ? 'Setting up…' : 'Get started'}
          </button>
        </div>
      </div>
    </div>
  );
}
