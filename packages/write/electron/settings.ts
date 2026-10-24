import { existingFolder as existing, sanitizeSettings, SettingsStore as SharedSettingsStore } from '../src/shared/backend/settings';
import { nodeFs } from './nodeFs';

export { sanitizeSettings };
export type { Settings, WindowState } from '../src/shared/backend/settings';

/** In-memory settings with serialized, coalesced writes (no lost updates, no torn files). */
export class SettingsStore extends SharedSettingsStore {
  constructor(file: string) {
    super(file, nodeFs);
  }
}

/** The remembered folder, but only if it still exists and is a directory. */
export const existingFolder = (folder: string | undefined): Promise<string | null> => existing(nodeFs, folder);
