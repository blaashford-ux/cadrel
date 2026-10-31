/**
 * The shell's side of projects and notes: the studio file, plus the facts the page needs in one go. Nothing here
 * touches Electron, so it is tested directly (test/studio.test.ts).
 */
import { openCounts, subtreeIds, visibleTree, type NoteStatus, type NoteTarget, type NoteView, type ProjectTree, type ProjectVisibility } from '@cadrel/kernel';
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
  /**
   * Which projects the person using the app can see (docs/PERMISSIONS.md): people see the projects they are assigned to, and the Owner and
   * an Admin see all. Absent, or null, where this computer holds no records for the Studio, and then there is nothing to limit by.
   */
  viewer?: (tree: ProjectTree) => Promise<Pick<ProjectVisibility, 'all' | 'visible'> | null>;
}

export class StudioService {
  readonly studio: Studio;

  constructor(private readonly o: StudioServiceOptions) {
    this.studio = new Studio(o.file);
  }

  /** The project tree as the person using the app may see it. Everything that shows or looks up a project goes through this, not the raw file. */
  async tree(): Promise<ProjectTree> {
    const tree = (await this.studio.read()).tree;
    const v = await this.o.viewer?.(tree);
    return v ? visibleTree(tree, v) : tree;
  }

  /** The module records (Write folders, Market categories) that belong only to projects this person cannot see, so a module's "show everything" does not show them. */
  async hiddenLinks(): Promise<{ module: string; ref: string }[]> {
    const raw = (await this.studio.read()).tree;
    const seen = new Set((await this.tree()).projects.map((p) => p.id));
    return raw.links.filter((l) => !seen.has(l.projectId)).map((l) => ({ module: l.module, ref: l.ref }));
  }

  /** Refuses a change to a project the person cannot see, as if there were none. */
  async assertVisible(projectId: string | null | undefined): Promise<void> {
    if (projectId && !(await this.tree()).projects.some((p) => p.id === projectId)) throw new Error('There is no such project.');
  }

  async state(): Promise<StudioState> {
    const d = await this.studio.read();
    const tree = await this.tree();
    const seen = new Set(tree.projects.map((p) => p.id));
    const root = await this.o.writeRoot().catch(() => null);
    const moduleNotes = root ? await readWriteNotes({ fs: this.o.fs, root, tree }) : [];
    const notes: NoteView[] = [...d.notes.map((n) => ({ ...n, source: 'studio' as const })), ...moduleNotes].filter((n) => n.status !== 'deleted' && (!n.projectId || seen.has(n.projectId))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { tree, notes, author: this.o.author(), openByProject: rollUp(tree, notes) };
  }

  createProject = async (o: { name: string; parentId?: string | null; kind?: string; workflowId?: string | null; stage?: string | null }) => (await this.assertVisible(o.parentId), this.studio.createProject(o));
  setStage = async (id: string, stage: string) => (await this.assertVisible(id), this.studio.setStage(id, stage));
  clearWorkflow = async (id: string) => (await this.assertVisible(id), this.studio.clearWorkflow(id));
  updateProject = async (id: string, change: { name?: string; kind?: string }) => (await this.assertVisible(id), this.studio.updateProject(id, change));
  moveProject = async (id: string, parentId: string | null, index?: number) => (await this.assertVisible(id), await this.assertVisible(parentId), this.studio.moveProject(id, parentId, index));
  archiveProject = async (id: string, archived: boolean) => (await this.assertVisible(id), this.studio.archiveProject(id, archived));
  deleteProject = async (id: string, cascade: boolean) => (await this.assertVisible(id), this.studio.deleteProject(id, { cascade }));
  link = async (projectId: string, module: string, ref: string) => (await this.assertVisible(projectId), this.studio.link(projectId, module, ref));
  unlink = async (module: string, ref: string, projectId?: string) => (await this.assertVisible(projectId), this.studio.unlink(module, ref, projectId));

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

  async addNote(o: { projectId?: string | null; body: string; target?: NoteTarget | null; category?: string }) {
    await this.assertVisible(o.projectId);
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
