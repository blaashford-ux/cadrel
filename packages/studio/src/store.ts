/**
 * The studio's own data: the project tree, and the notes that are not kept by a module. One small JSON file that the
 * app and the AI server both read and write. Each change re-reads the file first and replaces it atomically, so
 * a change made by one is not lost by the other; only two writes landing in the same instant could collide, and an
 * edit to a project name or a note is not worth a lock server for that.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NOTES_VERSION, PROJECT_TREE_VERSION, createNote, createProject, deleteNote, deleteProject, editNote, emptyTree, linkRecord, moveProject, projectFor, relinkRecord,
  replyToNote, sanitizeNotes, sanitizeTree, setArchived, setNoteStatus, unlinkRecord, updateProject,
  type NewNote, type Note, type NoteStatus, type Project, type ProjectTree
} from '@cadrel/kernel';

export interface StudioData {
  version: number;
  tree: ProjectTree;
  notes: Note[];
}

const VERSION = Math.max(PROJECT_TREE_VERSION, NOTES_VERSION);

export const emptyStudio = (): StudioData => ({ version: VERSION, tree: emptyTree(), notes: [] });

export function parseStudio(raw: unknown): StudioData {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { tree?: unknown; notes?: unknown };
  return { version: VERSION, tree: sanitizeTree(r.tree), notes: sanitizeNotes(r.notes) };
}

/** Where the app keeps it: beside its settings. `--studio <file>` and CADREL_STUDIO override, for tests and unusual setups. */
export function studioFile(argv: string[] = [], env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const i = argv.indexOf('--studio');
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]!);
  if (env.CADREL_STUDIO) return path.resolve(env.CADREL_STUDIO);
  if (env.CADREL_USER_DATA) return path.join(env.CADREL_USER_DATA, 'studio.json');
  const home = os.homedir();
  const base =
    platform === 'win32' ? env.APPDATA ?? path.join(home, 'AppData', 'Roaming') : platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return path.join(base, 'Cadrel', 'studio.json');
}

export class Studio {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string) {}

  /** The current contents. A missing or damaged file is an empty studio. */
  async read(): Promise<StudioData> {
    try {
      return parseStudio(JSON.parse(await fsp.readFile(this.file, 'utf8')));
    } catch {
      return emptyStudio();
    }
  }

  /** Changes the data under this process's queue, then writes it. `fn` returns the new data and whatever the caller wants back. */
  private change<T>(fn: (d: StudioData) => { data: StudioData; result: T }): Promise<T> {
    const run = async () => {
      const { data, result } = fn(await this.read());
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
      await fsp.rename(tmp, this.file);
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // ---- projects -------------------------------------------------------------------------------

  createProject(o: { name: string; parentId?: string | null; kind?: string }): Promise<Project> {
    return this.change((d) => {
      const r = createProject(d.tree, o);
      return { data: { ...d, tree: r.tree }, result: r.project };
    });
  }

  updateProject(id: string, change: { name?: string; kind?: string }): Promise<void> {
    return this.change((d) => ({ data: { ...d, tree: updateProject(d.tree, id, change) }, result: undefined }));
  }

  moveProject(id: string, parentId: string | null, index?: number): Promise<void> {
    return this.change((d) => ({ data: { ...d, tree: moveProject(d.tree, id, parentId, index) }, result: undefined }));
  }

  archiveProject(id: string, archived: boolean): Promise<void> {
    return this.change((d) => ({ data: { ...d, tree: setArchived(d.tree, id, archived) }, result: undefined }));
  }

  /** Deleting a project deletes the notes that belong only to it and its subprojects; the modules' own records are untouched. */
  deleteProject(id: string, o: { cascade?: boolean } = {}): Promise<string[]> {
    return this.change((d) => {
      const r = deleteProject(d.tree, id, o);
      const gone = new Set(r.removed);
      return { data: { ...d, tree: r.tree, notes: d.notes.filter((n) => !(n.projectId && gone.has(n.projectId))) }, result: r.removed };
    });
  }

  link(projectId: string, module: string, ref: string): Promise<void> {
    return this.change((d) => ({ data: { ...d, tree: linkRecord(d.tree, projectId, module, ref) }, result: undefined }));
  }

  unlink(module: string, ref: string): Promise<void> {
    return this.change((d) => ({ data: { ...d, tree: unlinkRecord(d.tree, module, ref) }, result: undefined }));
  }

  relink(module: string, from: string, to: string): Promise<void> {
    return this.change((d) => ({ data: { ...d, tree: relinkRecord(d.tree, module, from, to) }, result: undefined }));
  }

  // ---- notes ----------------------------------------------------------------------------------

  /** A note on a record that is linked to a project belongs to that project unless told otherwise. */
  addNote(o: NewNote): Promise<Note> {
    return this.change((d) => {
      const projectId = o.projectId !== undefined ? o.projectId : o.target ? projectFor(d.tree, o.target.module, o.target.id)?.id ?? null : null;
      if (projectId && !d.tree.projects.some((p) => p.id === projectId)) throw new Error(`There is no project "${projectId}".`);
      const r = createNote(d.notes, { ...o, projectId });
      return { data: { ...d, notes: r.notes }, result: r.note };
    });
  }

  setNoteStatus(id: string, status: NoteStatus): Promise<void> {
    return this.change((d) => ({ data: { ...d, notes: setNoteStatus(d.notes, id, status) }, result: undefined }));
  }

  editNote(id: string, patch: { body?: string; category?: string | null }): Promise<void> {
    return this.change((d) => ({ data: { ...d, notes: editNote(d.notes, id, patch) }, result: undefined }));
  }

  replyToNote(id: string, reply: { author: string; body: string }): Promise<void> {
    return this.change((d) => ({ data: { ...d, notes: replyToNote(d.notes, id, reply) }, result: undefined }));
  }

  deleteNote(id: string): Promise<void> {
    return this.change((d) => ({ data: { ...d, notes: deleteNote(d.notes, id) }, result: undefined }));
  }
}
