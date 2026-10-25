/**
 * What the studio's administrators govern, and so what is central to Cadrel rather than to one module: today the project templates
 * (the folder structure and defaults a new project gets). Kept in one file in the app's data folder; when the studio has a server
 * this moves to it unchanged and every member gets the same templates.
 *
 * Who is an administrator: a one-person studio's only member is its Owner, so on this computer the person is one. Once there is a
 * server, the role comes from it. Nothing is enforced by the page alone: every change goes through `save`, which checks the role.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { defaultTemplates, sanitizeTemplates, templateErrors, type ProjectTemplate } from '@cadrel/write/src/shared/projects';

export type Role = 'owner' | 'admin' | 'member';
export const canAdminister = (role: Role): boolean => role === 'owner' || role === 'admin';

export interface AdminData {
  templates: ProjectTemplate[];
  defaultTemplateId: string;
}

export class AdminError extends Error {}

export class AdminStore {
  private data: AdminData = seed();
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, private readonly role: () => Role) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fsp.readFile(this.file, 'utf8')) as Record<string, unknown>;
      const templates = sanitizeTemplates(raw.templates);
      const wanted = typeof raw.defaultTemplateId === 'string' ? raw.defaultTemplateId : '';
      this.data = { templates, defaultTemplateId: templates.some((t) => t.id === wanted) ? wanted : templates[0]!.id };
    } catch {
      this.data = seed();
    }
  }

  isAdmin(): boolean {
    return canAdminister(this.role());
  }

  /** Anyone may read the templates (creating a project needs them); only administrators change them. */
  get(): AdminData {
    return this.data;
  }

  templates(): ProjectTemplate[] {
    return this.data.templates;
  }

  async save(next: { templates: unknown; defaultTemplateId: string }): Promise<AdminData> {
    if (!this.isAdmin()) throw new AdminError('Only an administrator can change the project templates.');
    const templates = sanitizeTemplates(next.templates);
    const problems = templates.flatMap((t) => templateErrors(t).map((e) => `${t.name || '(unnamed)'}: ${e}`));
    if (problems.length) throw new AdminError(problems[0]!);
    if (!templates.length) throw new AdminError('There must be at least one template.');
    this.data = { templates, defaultTemplateId: templates.some((t) => t.id === next.defaultTemplateId) ? next.defaultTemplateId : templates[0]!.id };
    const snapshot = JSON.stringify(this.data, null, 2);
    this.pending = this.pending.then(async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, snapshot);
      await fsp.rename(tmp, this.file);
    });
    await this.pending;
    return this.data;
  }

  flush(): Promise<void> {
    return this.pending.catch(() => undefined);
  }
}

function seed(): AdminData {
  const templates = defaultTemplates();
  return { templates, defaultTemplateId: templates.some((t) => t.id === 'novel') ? 'novel' : templates[0]!.id };
}
