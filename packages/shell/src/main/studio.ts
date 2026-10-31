/**
 * The shell's side of projects and notes: the studio file, plus the facts the page needs in one go. Nothing here
 * touches Electron, so it is tested directly (test/studio.test.ts).
 */
import { openCounts, subtreeIds, type NoteStatus, type NoteTarget, type NoteView, type ProjectTree } from '@cadrel/kernel';
import { readWriteNotes, Studio } from '@cadrel/studio';
import type { FsPort } from '@cadrel/write/src/shared/fsPort';
import type { StudioState } from '../shared/api';

export interface StudioServiceOptions {
  file: string;
  /** Who a note written in the app is by. */
  author: () => string;
  /** Write's projects folder, for the manuscripts' notes; null when none is chosen. */
  writeRoot: () => Promise<string | null>;
  fs: FsPort;
}

export class StudioService {
  readonly studio: Studio;

  constructor(private readonly o: StudioServiceOptions) {
    this.studio = new Studio(o.file);
  }

  async state(): Promise<StudioState> {
    const d = await this.studio.read();
    const root = await this.o.writeRoot().catch(() => null);
    const moduleNotes = root ? await readWriteNotes({ fs: this.o.fs, root, tree: d.tree }) : [];
    const notes: NoteView[] = [...d.notes.map((n) => ({ ...n, source: 'studio' as const })), ...moduleNotes].filter((n) => n.status !== 'deleted').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { tree: d.tree, notes, author: this.o.author(), openByProject: rollUp(d.tree, notes) };
  }

  createProject = (o: { name: string; parentId?: string | null; kind?: string; workflowId?: string | null; stage?: string | null }) => this.studio.createProject(o);
  setStage = (id: string, stage: string) => this.studio.setStage(id, stage);
  clearWorkflow = (id: string) => this.studio.clearWorkflow(id);
  updateProject = (id: string, change: { name?: string; kind?: string }) => this.studio.updateProject(id, change);
  moveProject = (id: string, parentId: string | null, index?: number) => this.studio.moveProject(id, parentId, index);
  archiveProject = (id: string, archived: boolean) => this.studio.archiveProject(id, archived);
  deleteProject = (id: string, cascade: boolean) => this.studio.deleteProject(id, { cascade });
  link = (projectId: string, module: string, ref: string) => this.studio.link(projectId, module, ref);
  unlink = (module: string, ref: string, projectId?: string) => this.studio.unlink(module, ref, projectId);

  /** The notes written on one record of a module (a Market category, a book), whichever project it belongs to. */
  async recordNotes(module: string, kind: string, id: string): Promise<NoteView[]> {
    return (await this.state()).notes.filter((n) => n.target?.module === module && n.target.kind === kind && n.target.id === id);
  }

  addRecordNote(o: { module: string; kind: string; id: string; label: string; body: string; category?: string }) {
    return this.addNote({ projectId: undefined, body: o.body, category: o.category, target: { module: o.module, kind: o.kind, id: o.id, label: o.label } });
  }

  /** Only notes on records of `module` may be changed through that module's page. */
  async ownedBy(module: string, noteId: string): Promise<void> {
    const n = (await this.studio.read()).notes.find((x) => x.id === noteId);
    if (!n || n.target?.module !== module) throw new Error('That note does not belong to this page.');
  }

  addNote(o: { projectId?: string | null; body: string; target?: NoteTarget | null; category?: string }) {
    return this.studio.addNote({ projectId: o.projectId, target: o.target ?? null, body: o.body, category: o.category, author: this.o.author(), origin: 'human' });
  }
  setNoteStatus = (id: string, status: NoteStatus) => this.studio.setNoteStatus(id, status);
  replyToNote = (id: string, body: string) => this.studio.replyToNote(id, { author: this.o.author(), body });
  deleteNote = (id: string) => this.studio.deleteNote(id);
}

/** Open notes per project, each project also counting everything below it, so a Series shows its Books' notes. */
export function rollUp(tree: ProjectTree, notes: Pick<NoteView, 'projectId' | 'status'>[]): Record<string, number> {
  const own = openCounts(notes);
  const out: Record<string, number> = {};
  for (const p of tree.projects) {
    const n = subtreeIds(tree, p.id).reduce((sum, id) => sum + (own.get(id) ?? 0), 0);
    if (n) out[p.id] = n;
  }
  return out;
}
