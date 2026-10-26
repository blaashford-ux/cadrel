import { descendantsOf, linksOf, type ProjectTree } from '@cadrel/kernel';
import type { Overview } from '../shared/api';

export interface ProjectFacts {
  /** Words in the manuscripts linked to this project and everything under it. */
  words: number;
  /** The goals of those manuscripts, added up; null if none has a goal. */
  goalWords: number | null;
  lastEdited: number | null;
  manuscripts: number;
  categories: number;
  /** Links whose Write project or Market category no longer exists. */
  missing: number;
}

/** What a project (with its subprojects) adds up to, from the modules' current state. */
export function factsFor(tree: ProjectTree, overview: Overview | null, projectId: string): ProjectFacts {
  const ids = [projectId, ...descendantsOf(tree, projectId).map((p) => p.id)];
  const out: ProjectFacts = { words: 0, goalWords: null, lastEdited: null, manuscripts: 0, categories: 0, missing: 0 };
  for (const id of ids) {
    for (const l of linksOf(tree, id)) {
      if (l.module === 'write') {
        const w = overview?.write.projects.find((p) => p.name === l.ref);
        if (!w) {
          if (overview?.write.ok) out.missing++;
          continue;
        }
        out.manuscripts++;
        out.words += w.words ?? 0;
        if (w.goalWords) out.goalWords = (out.goalWords ?? 0) + w.goalWords;
        if (w.lastEdited !== null) out.lastEdited = Math.max(out.lastEdited ?? 0, w.lastEdited);
      } else if (l.module === 'market') {
        if (overview?.market.categories.some((c) => c.key === l.ref)) out.categories++;
        else if (overview?.market.ok && overview.market.libraryRoot) out.missing++;
      }
    }
  }
  return out;
}
