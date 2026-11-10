import { mergeReviewFiles, newReviewFile, type ReviewFile } from './comments';

/** A project somebody shared with this person (a Beta Reader's manuscript), as it sits on this device. */
export interface SharedProject {
  /** The local folder the project lives in. */
  dir: string;
  project: string;
  /** This person in the Studio: what their notes file is named. */
  reviewerId: string;
}

/** The reader's notes as the Studio has them, joined with the ones on this device. */
export function mergeFiles(remote: ReviewFile | null, local: ReviewFile | null, project: string, who: { id: string; name: string }): ReviewFile {
  const base = newReviewFile(project, { id: who.id, name: who.name });
  const r = remote ?? base;
  return local ? mergeReviewFiles(r, local) : r;
}
