import type { FsPort } from '../fsPort';
import { sidecarPathFor } from '../export/sidecar';

/** Export-settings files (`<name>.export.json`) must travel with their manuscript when it is renamed or deleted. */
export function makeSidecars(fs: FsPort) {
  const exists = async (p: string) => (await fs.stat(p)) !== null;

  /** Keeps the sidecar with its manuscript when the file is renamed. Never overwrites someone else's export settings. */
  async function renameSidecar(oldMd: string, newMd: string): Promise<void> {
    const from = sidecarPathFor(oldMd);
    const to = sidecarPathFor(newMd);
    if (from === to || !(await exists(from)) || (await exists(to))) return;
    await fs.rename(from, to);
  }

  /** Path of the sidecar if one exists. */
  async function existingSidecar(mdPath: string): Promise<string | null> {
    const p = sidecarPathFor(mdPath);
    return (await exists(p)) ? p : null;
  }

  return { renameSidecar, existingSidecar };
}
