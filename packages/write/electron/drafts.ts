import { DraftStore as SharedDraftStore } from '../src/shared/backend/drafts';
import { nodeFs } from './nodeFs';

/** Autosaved unsaved edits, one JSON file per source file, for recovery after a crash. */
export class DraftStore extends SharedDraftStore {
  constructor(dir: string) {
    super(dir, nodeFs);
  }
}
