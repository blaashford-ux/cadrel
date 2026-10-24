/**
 * Notes shared among the people editing a manuscript together (the owner and the collaborators).
 *
 * Each collaborator's comments file in Drive carries their own notes as before (`items`) and also a `team` list: every other
 * review file the editing group shares, including AI notes. The owner and the collaborator each merge that list with their own
 * copies on every sync (by note id, newest edit wins, replies united), so a note, a reply or a resolution made by anyone reaches
 * everyone. Reviewers' files are never put in it: people invited only to comment keep their notes to the owner.
 */
import { splitChapters } from '../chapters';
import { flattenMarkdown } from '../agent/flatten';
import { locateAnchor, mergeReviewFiles, parseReviewFile, type ReviewFile } from './comments';
import { selectChapters, type ChapterSelection } from './package';

/** The shared files carried inside a comments file (none when it has no `team` list or it can't be read). */
export function parseTeam(raw: string): ReviewFile[] {
  try {
    const list = (JSON.parse(raw) as { team?: unknown }).team;
    if (!Array.isArray(list)) return [];
    return list.map((f) => parseReviewFile(JSON.stringify(f))).filter((f): f is ReviewFile => !!f);
  } catch {
    return [];
  }
}

/** A comments file's text with the team's files inside it (files with no notes are left out). */
export function serializeWithTeam(file: ReviewFile, team: ReviewFile[]): string {
  const files = team.filter((f) => f.items.length > 0).sort((a, b) => a.reviewer.id.localeCompare(b.reviewer.id));
  return JSON.stringify(files.length ? { ...file, team: files } : file, null, 2) + '\n';
}

/** Two sets of files united by reviewer id; a file in both is merged note by note. */
export function mergeTeam(a: ReviewFile[], b: ReviewFile[]): ReviewFile[] {
  const byId = new Map<string, ReviewFile>();
  for (const f of [...a, ...b]) {
    const have = byId.get(f.reviewer.id);
    byId.set(f.reviewer.id, have ? mergeReviewFiles(have, f) : f);
  }
  return [...byId.values()];
}

/** Whether a file written by this reviewer id may be shared among the editing group, given who the collaborators are. */
export function sharedAmongEditors(id: string, collaboratorIds: Set<string>): boolean {
  return id === 'owner' || id.startsWith('ai-') || collaboratorIds.has(id);
}

/**
 * The notes that fall inside the chapters a collaborator was given (a note's anchor is looked for in each chapter), so the
 * others' notes on chapters they can't see don't reach them. `null` keeps everything.
 */
export function visibleTo(files: ReviewFile[], manuscript: { path: string; text: string } | null, sel: ChapterSelection | null): ReviewFile[] {
  if (!sel || !manuscript) return files;
  const flats = splitChapters(selectChapters(manuscript.text, sel), sel.level).chapters.map((c) => flattenMarkdown(c.raw));
  return files.map((f) => ({ ...f, items: f.items.filter((i) => i.file !== manuscript.path || flats.some((t) => locateAnchor(t, i.anchor))) }));
}
