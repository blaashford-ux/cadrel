/**
 * Write keeps its manuscript notes beside the manuscript (in review files shared with reviewers). The studio-wide
 * Notes list reads them from there rather than copying them, so there is one truth and Write's sharing is untouched.
 */
import type { FsPort } from '@cadrel/write/src/shared/fsPort';
import { getNotes, listProjects } from '@cadrel/write/src/shared/agent/tools';
import { projectFor, type NoteView, type ProjectTree } from '@cadrel/kernel';

/** Every note in every Write project under `root`, as studio notes. Never throws for one bad project. */
export async function readWriteNotes(o: { fs: FsPort; root: string; tree: ProjectTree }): Promise<NoteView[]> {
  const ctx = { fs: o.fs, root: o.root, agent: 'cadrel', agentName: 'Cadrel' };
  const out: NoteView[] = [];
  let projects: { project: string }[] = [];
  try {
    projects = await listProjects(ctx);
  } catch {
    return out;
  }
  for (const { project } of projects) {
    let notes;
    try {
      notes = await getNotes(ctx, project);
    } catch {
      continue;
    }
    const projectId = projectFor(o.tree, 'write', project)?.id ?? null;
    for (const n of notes) {
      out.push({
        id: `write:${project}:${n.id}`,
        projectId,
        target: { module: 'write', kind: 'file', id: `${project}/${n.file}`, label: `${project} · ${n.file}`, ...(n.quote ? { anchor: { quote: n.quote, prefix: '', suffix: '', start: 0 } } : {}) },
        kind: n.kind,
        body: n.body,
        ...(n.replacement !== undefined ? { replacement: n.replacement } : {}),
        status: n.status,
        ...(n.category ? { category: n.category } : {}),
        author: n.reviewer,
        createdAt: n.createdAt,
        updatedAt: n.createdAt,
        replies: n.replies.map((r, i) => ({ id: `${n.id}:${i}`, author: r.author, createdAt: n.createdAt, body: r.body })),
        source: 'module'
      });
    }
  }
  return out;
}
