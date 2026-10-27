/**
 * Creating and managing projects: the part of the old Write that is now Cadrel's Projects page. A project in Cadrel's tree may have a
 * manuscript folder, a project folder inside the Projects folder (<Cadrel>/Projects/<name>). This joins the two: it keeps the
 * tree (@cadrel/studio) and the folders (Write) in step, so creating, renaming, archiving or deleting a project does the same to its
 * folder, and Write only has to open the folder and let the person write in it.
 *
 * Nothing here touches Electron: Write is reached through `WriteFolders`, so this is tested with a fake.
 */
import path from 'node:path';
import { descendantsOf, getProject, linksOf } from '@cadrel/kernel';
import { projectNameError, uniqueName } from '@cadrel/write/src/shared/projects';
import type { StudioService } from './studio';
import type { ProjectStages } from './stages';
import type { ManuscriptMeta, ManuscriptTemplate } from '../shared/api';

/** What the manager needs of Write. WriteModule satisfies it; tests supply a fake. */
export interface WriteFolders {
  projectsRoot(): string;
  templates(): ManuscriptTemplate[];
  listFolders(): Promise<{ projects: { name: string; path: string }[]; others: { name: string; path: string }[] }>;
  createProject(name: string, templateId: string): Promise<{ path: string }>;
  renameProject(folder: string, name: string): Promise<string>;
  duplicateProject(folder: string, name: string): Promise<{ path: string }>;
  deleteProject(folder: string): Promise<void>;
  readProject(folder: string): Promise<(ManuscriptMeta & { templateId: string }) | null>;
  updateProject(folder: string, patch: { notes?: string; archived?: boolean }): Promise<unknown>;
  convertFolder(folder: string): Promise<unknown>;
  addMissingTemplateParts(folder: string, templateId: string): Promise<string[]>;
  openProject(folder: string): void;
}

export class ManageError extends Error {}
const fail = (m: string): never => {
  throw new ManageError(m);
};

export class ProjectManager {
  /** `stages` is absent where this computer holds no workflow records (a Studio that was only joined): projects are then made without one. */
  constructor(private readonly studio: StudioService, private readonly write: WriteFolders, private readonly stages: ProjectStages | null = null) {}

  /** The folder of a project's manuscript, if it has one. */
  private async folderOf(projectId: string): Promise<{ ref: string; dir: string } | null> {
    const t = (await this.studio.studio.read()).tree;
    const l = linksOf(t, projectId, 'write')[0];
    return l ? { ref: l.ref, dir: path.join(this.write.projectsRoot(), l.ref) } : null;
  }

  /** A folder name free in the Projects folder (the project's own name when it can be). */
  private async freeFolderName(name: string): Promise<string> {
    const { projects, others } = await this.write.listFolders();
    const taken = [...projects, ...others].map((f) => f.name);
    const free = uniqueName(name.trim(), taken);
    return projectNameError(free) ? fail(projectNameError(free)!) : free;
  }

  /**
   * Creates a project and, when `template` is given, its manuscript folder from that template, linked to it. If the folder cannot be
   * made (a name Windows will not allow), the project is not created either.
   */
  async create(o: { name: string; parentId?: string | null; kind?: string; template?: string | null; workflowId?: string | null }): Promise<{ id: string; folder: string | null }> {
    const template = o.template ?? null;
    // the workflow is chosen here, once, before anything is made; a bad choice makes nothing
    const wf = this.stages ? await this.stages.forNewProject(o.parentId, o.workflowId) : { workflowId: null, stage: null };
    if (template && !this.write.templates().some((t) => t.id === template)) fail('That template no longer exists.');
    let folder: string | null = null;
    if (template) {
      const name = await this.freeFolderName(o.name);
      folder = (await this.write.createProject(name, template)).path;
    }
    try {
      const p = await this.studio.createProject({ name: o.name, parentId: o.parentId, kind: o.kind, workflowId: wf.workflowId, stage: wf.stage });
      if (folder) await this.studio.link(p.id, 'write', path.basename(folder));
      return { id: p.id, folder };
    } catch (e) {
      // The tree refused (a duplicate name among siblings): do not leave an orphan folder behind.
      if (folder) await this.write.deleteProject(folder).catch(() => undefined);
      throw e;
    }
  }

  /** Gives an existing project a manuscript folder. */
  async addManuscript(projectId: string, template: string): Promise<string> {
    if (await this.folderOf(projectId)) fail('That project already has a manuscript folder.');
    const p = getProject((await this.studio.studio.read()).tree, projectId) ?? fail('There is no such project.');
    const made = await this.write.createProject(await this.freeFolderName(p.name), template);
    await this.studio.link(projectId, 'write', path.basename(made.path));
    return made.path;
  }

  /** Renames the project and its folder together; if the folder cannot be renamed, nothing changes. */
  async rename(projectId: string, name: string): Promise<void> {
    const f = await this.folderOf(projectId);
    if (f) {
      const to = await this.write.renameProject(f.dir, name);
      try {
        await this.studio.updateProject(projectId, { name });
      } catch (e) {
        await this.write.renameProject(to, f.ref).catch(() => undefined);
        throw e;
      }
      await this.studio.studio.relink('write', f.ref, path.basename(to));
    } else {
      await this.studio.updateProject(projectId, { name });
    }
  }

  /** Archives (or restores) a project, its subprojects, and their manuscript folders. */
  async archive(projectId: string, archived: boolean): Promise<void> {
    await this.studio.archiveProject(projectId, archived);
    const t = (await this.studio.studio.read()).tree;
    const ids = archived ? [projectId, ...descendantsOf(t, projectId).map((p) => p.id)] : [projectId];
    for (const id of ids) {
      const f = await this.folderOf(id);
      if (f) await this.write.updateProject(f.dir, { archived }).catch(() => undefined);
    }
  }

  /** Deletes the project, its subprojects and their notes, and moves their manuscript folders to the recycle bin. */
  async remove(projectId: string): Promise<string[]> {
    const t = (await this.studio.studio.read()).tree;
    const all = [projectId, ...descendantsOf(t, projectId).map((p) => p.id)];
    const folders = (await Promise.all(all.map((id) => this.folderOf(id)))).filter((f): f is { ref: string; dir: string } => !!f);
    const removed = await this.studio.deleteProject(projectId, true);
    for (const f of folders) await this.write.deleteProject(f.dir).catch(() => undefined);
    return removed;
  }

  /** A copy of a project's manuscript folder, as a new sibling project (subprojects are not copied). */
  async duplicate(projectId: string): Promise<string> {
    const tree = (await this.studio.studio.read()).tree;
    const p = getProject(tree, projectId) ?? fail('There is no such project.');
    const f = await this.folderOf(projectId);
    const siblings = tree.projects.filter((x) => x.parentId === p.parentId).map((x) => x.name);
    const name = uniqueName(`${p.name} copy`, siblings);
    // a copy lives by the same workflow as the project it was copied from, starting at the beginning
    const made = await this.create({ name, parentId: p.parentId, kind: p.kind, template: null, workflowId: p.workflowId });
    if (f) {
      const copy = await this.write.duplicateProject(f.dir, await this.freeFolderName(name));
      await this.studio.link(made.id, 'write', path.basename(copy.path));
    }
    return made.id;
  }

  /** What Write knows about a project's folder: its notes and the template it was made from. */
  async manuscript(projectId: string): Promise<{ folder: string; meta: ManuscriptMeta & { templateId: string } } | null> {
    const f = await this.folderOf(projectId);
    const meta = f && (await this.write.readProject(f.dir));
    return f && meta ? { folder: f.dir, meta } : null;
  }

  async setManuscript(projectId: string, patch: { notes?: string }): Promise<void> {
    const f = (await this.folderOf(projectId)) ?? fail('That project has no manuscript folder.');
    await this.write.updateProject(f.dir, patch);
  }

  async addMissingParts(projectId: string): Promise<string[]> {
    const m = (await this.manuscript(projectId)) ?? fail('That project has no manuscript folder.');
    return this.write.addMissingTemplateParts(m.folder, m.meta.templateId);
  }

  /** Opens the project's folder in Write. */
  async open(projectId: string): Promise<void> {
    const f = (await this.folderOf(projectId)) ?? fail('That project has no manuscript folder yet. Add one on the Projects page.');
    this.write.openProject(f.dir);
  }

  /**
   * Folders in the Projects folder that no project in the tree owns yet: Write projects made outside Cadrel (or by an older
   * version), and plain folders. Each can be brought in as a project of its own.
   */
  async unfiled(): Promise<{ projects: { name: string }[]; folders: { name: string }[] }> {
    const t = (await this.studio.studio.read()).tree;
    const owned = new Set(t.links.filter((l) => l.module === 'write').map((l) => l.ref));
    const { projects, others } = await this.write.listFolders();
    return { projects: projects.filter((p) => !owned.has(p.name)).map((p) => ({ name: p.name })), folders: others.filter((p) => !owned.has(p.name)).map((p) => ({ name: p.name })) };
  }

  /** Brings an unfiled folder in as a project (a plain folder is made a Write project first). */
  async adopt(folderName: string, parentId?: string | null): Promise<string> {
    const { projects, others } = await this.write.listFolders();
    const dir = path.join(this.write.projectsRoot(), folderName);
    if (!projects.some((p) => p.name === folderName)) {
      if (!others.some((p) => p.name === folderName)) fail(`There is no folder called "${folderName}" to bring in.`);
      await this.write.convertFolder(dir);
    }
    const wf = this.stages ? await this.stages.forNewProject(parentId) : { workflowId: null, stage: null };
    const p = await this.studio.createProject({ name: folderName, parentId, workflowId: wf.workflowId, stage: wf.stage });
    await this.studio.link(p.id, 'write', folderName);
    return p.id;
  }
}

