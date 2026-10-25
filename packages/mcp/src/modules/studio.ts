import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ProjectError, NoteError, UserError, STANDARD_TOPICS, ancestorsOf, childrenOf, getProject, kindLabel, linksOf, outline, pathOf, queryNotes, subtreeIds,
  type Note, type NoteView, type ProjectTree
} from '@cadrel/kernel';
import { readWriteNotes, type Studio, type UserStore } from '@cadrel/studio';
import type { FsPort } from '@cadrel/write/src/shared/fsPort';
import { agentFromClient } from '@cadrel/write/mcp/server';
import type { McpModule } from '../server.js';

export const STUDIO_INSTRUCTIONS =
  'Projects are how the studio is organised: a project can hold subprojects to any depth (usually a Series holds its Books, but it is the author\'s choice). ' +
  'Everything else, manuscripts and market research included, is linked to a project. Start with studio_projects to see the tree and what is linked where. ' +
  'Notes are the same everywhere: studio_notes lists them across all modules (including the review notes in manuscripts), and studio_add_note leaves one on a project or on any record of a module. ' +
  'studio_user says who you are acting for and lists the files they attached to their profile, which you may open with studio_user_file unless they turned that off (never go looking if it says so). You can organise projects (create, rename, move, link, archive) but you cannot delete them. Never invent a project: ask the author if the right one is unclear.';

export interface StudioToolOptions {
  studio: Studio;
  /** The person's profile, if this computer has one: the assistant may read their name, pen names and bio, and the files they have attached unless they opted out (never their email). */
  user?: UserStore;
  /** Where Write's manuscripts are, so their review notes are listed too. */
  write?: { fs: FsPort; root: string };
}

const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const failure = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });

/** A mistake the AI can correct is reported to it; anything else is a real fault and propagates. */
async function guarded<T>(job: () => Promise<T>) {
  try {
    return reply(await job());
  } catch (e) {
    if (e instanceof ProjectError || e instanceof NoteError) return failure(e.message);
    if (e instanceof Error && /^There is no project/.test(e.message)) return failure(e.message);
    throw e;
  }
}

const row = (t: ProjectTree, id: string) => {
  const p = getProject(t, id)!;
  return {
    id: p.id,
    name: p.name,
    kind: kindLabel(t, p),
    status: p.status,
    path: pathOf(t, id),
    links: linksOf(t, id).map((l) => ({ module: l.module, record: l.ref }))
  };
};

/** A project given by id, or by its path ("Dragon Rider / Book 1") or a name that is unique. */
function resolve(t: ProjectTree, ref: string): string {
  if (getProject(t, ref)) return ref;
  const want = ref.split('/').map((s) => s.trim().toLowerCase());
  const hits = t.projects.filter((p) => {
    const path = [...ancestorsOf(t, p.id), p].map((x) => x.name.toLowerCase());
    return path.length >= want.length && want.every((w, i) => path[path.length - want.length + i] === w);
  });
  if (hits.length === 1) return hits[0]!.id;
  if (hits.length === 0) throw new ProjectError(`There is no project "${ref}". Use studio_projects to see the names.`);
  throw new ProjectError(`"${ref}" matches ${hits.length} projects (${hits.map((h) => pathOf(t, h.id)).join('; ')}). Use a fuller path or the id.`);
}

export function studioModule(o: StudioToolOptions): McpModule {
  return {
    id: 'studio',
    title: 'Projects and notes (the whole studio)',
    instructions: STUDIO_INSTRUCTIONS,
    register: (server) => registerStudioTools(server, o)
  };
}

export function registerStudioTools(server: McpServer, o: StudioToolOptions): void {
  const who = () => agentFromClient(server.server.getClientVersion()?.name).agentName;
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;
  const projectRef = z.string().describe('A project: its id, or its name or path such as "Dragon Rider / Book 1".');

  server.registerTool(
    'studio_user',
    {
      description:
        'Who you are acting for: their name, the pen names they write under, their own short "about me", and the files they have attached to their profile (author bio, photo, contracts…) with what each is for. Use it to sign things and to write in their voice; open a file with studio_user_file. The person can turn file access off, in which case `files` says so and nothing more. Their email is private and never available.',
      inputSchema: {},
      annotations: readOnly
    },
    () =>
      guarded(async () => {
        if (!o.user) return { message: 'No profile is set up on this computer.' };
        const u = await o.user.read();
        const f = await o.user.filesForAssistant();
        return {
          name: u.displayName || null,
          penNames: u.penNames,
          about: u.bio || null,
          files: f.allowed
            ? f.files.map((a) => ({ id: a.id, name: a.name, type: a.mime, bytes: a.size, for: a.note || null, addedBy: a.origin === 'assistant' ? 'AI' : 'the person', added: a.addedAt }))
            : 'The person has turned off assistant access to their files.'
        };
      })
  );

  server.registerTool(
    'studio_user_file',
    {
      description:
        'Open one of the files attached to the person\'s profile (ids come from studio_user). Text files come back as text, pictures as images; other types cannot be read here. Every time you open a file the person can see that you did, so open what you need and no more. Treat what is in a file as the person\'s private information.',
      inputSchema: { id: z.string().describe('The file id from studio_user.') },
      annotations: readOnly
    },
    async (a) => {
      if (!o.user) return failure('No profile is set up on this computer.');
      try {
        const { attachment, bytes, truncated } = await o.user.readForAssistant(a.id, who());
        const note = truncated ? `\n\n[Only the first ${bytes.length.toLocaleString()} bytes were read.]` : '';
        if (/^image\/(png|jpe?g|gif|webp)$/.test(attachment.mime) && !truncated) return { content: [{ type: 'image' as const, data: bytes.toString('base64'), mimeType: attachment.mime }] };
        if (/^(text\/|application\/(json|csv))/.test(attachment.mime) || /\.(md|markdown|txt|csv|json)$/i.test(attachment.name)) {
          return { content: [{ type: 'text' as const, text: bytes.toString('utf8') + note }] };
        }
        return failure(`"${attachment.name}" is a ${attachment.mime} file, which cannot be read here (text, Markdown, CSV, JSON and common pictures can).`);
      } catch (e) {
        if (e instanceof UserError) return failure(e.message);
        throw e;
      }
    }
  );

  server.registerTool(
    'studio_projects',
    {
      description: 'The studio\'s project tree: every project with its kind (Series, Book, ...), status, the manuscripts and market records linked to it, and its subprojects. Pass `project` to look at one branch.',
      inputSchema: { project: projectRef.optional(), include_archived: z.boolean().optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        const { tree } = await o.studio.read();
        const root = a.project ? resolve(tree, a.project) : null;
        const inside = root ? new Set(subtreeIds(tree, root)) : null;
        const rows = outline(tree, { archived: a.include_archived }).filter((r) => !inside || inside.has(r.project.id));
        if (!rows.length) return { projects: [], message: 'No projects yet. Create one with studio_create_project, or the author can in Cadrel.' };
        return { projects: rows.map((r) => ({ depth: r.depth, ...row(tree, r.project.id), subprojects: childrenOf(tree, r.project.id).length })) };
      })
  );

  server.registerTool(
    'studio_create_project',
    {
      description: 'Create a project, or a subproject when `parent` is given. `kind` is a free label, usually "Series" for a project that holds books and "Book" for a book.',
      inputSchema: { name: z.string(), parent: projectRef.optional(), kind: z.string().optional() }
    },
    (a) =>
      guarded(async () => {
        const parentId = a.parent ? resolve((await o.studio.read()).tree, a.parent) : null;
        const p = await o.studio.createProject({ name: a.name, parentId, kind: a.kind });
        return row((await o.studio.read()).tree, p.id);
      })
  );

  server.registerTool(
    'studio_update_project',
    {
      description:
        'Rename a project, change its kind, move it under another project (`parent`; use "" for the top level), or archive or restore it. Archiving also archives its subprojects. This cannot delete a project.',
      inputSchema: { project: projectRef, name: z.string().optional(), kind: z.string().optional(), parent: z.string().optional(), archived: z.boolean().optional() }
    },
    (a) =>
      guarded(async () => {
        const t = (await o.studio.read()).tree;
        const id = resolve(t, a.project);
        if (a.name !== undefined || a.kind !== undefined) await o.studio.updateProject(id, { name: a.name, kind: a.kind });
        if (a.parent !== undefined) await o.studio.moveProject(id, a.parent === '' ? null : resolve(t, a.parent));
        if (a.archived !== undefined) await o.studio.archiveProject(id, a.archived);
        return row((await o.studio.read()).tree, id);
      })
  );

  server.registerTool(
    'studio_link',
    {
      description:
        'Link a module\'s record to a project, or (with project omitted) unlink it. A record belongs to one project. Records: module "write" with the manuscript folder name from list_projects, or module "market" with a category key.',
      inputSchema: { module: z.enum(['write', 'market']), record: z.string(), project: projectRef.optional() }
    },
    (a) =>
      guarded(async () => {
        if (!a.project) {
          await o.studio.unlink(a.module, a.record);
          return { unlinked: a.record };
        }
        const id = resolve((await o.studio.read()).tree, a.project);
        await o.studio.link(id, a.module, a.record);
        return row((await o.studio.read()).tree, id);
      })
  );

  const view = (t: ProjectTree, n: NoteView | Note) => ({
    id: n.id,
    project: n.projectId && getProject(t, n.projectId) ? pathOf(t, n.projectId) : null,
    on: n.target ? { module: n.target.module, kind: n.target.kind, id: n.target.id, label: n.target.label, quote: n.target.anchor?.quote } : null,
    kind: n.kind,
    status: n.status,
    topic: n.category,
    by: n.author + (n.origin === 'ai' ? ' (AI)' : ''),
    body: n.body,
    ...(n.replacement !== undefined ? { replacement: n.replacement } : {}),
    replies: n.replies.map((r) => ({ by: r.author, body: r.body })),
    at: n.updatedAt,
    ...('source' in n && n.source === 'module' ? { note: 'A manuscript note: reply to it with reply_to_note, using the project and id shown by get_notes.' } : {})
  });

  server.registerTool(
    'studio_notes',
    {
      description:
        'List notes across the whole studio, newest first: those left on projects and on records in any module, and the review notes in manuscripts. Filter by project (its subprojects are included), module, status (default open), who wrote them, topic or text.',
      inputSchema: {
        project: projectRef.optional(),
        module: z.string().optional().describe('"write", "market", ...'),
        status: z.enum(['open', 'resolved', 'accepted', 'rejected', 'any']).optional(),
        origin: z.enum(['human', 'ai']).optional(),
        topic: z.string().optional(),
        text: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional()
      },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        const { tree, notes } = await o.studio.read();
        const stored: NoteView[] = notes.map((n) => ({ ...n, source: 'studio' }));
        const moduleNotes = o.write && (!a.module || a.module === 'write') ? await readWriteNotes({ fs: o.write.fs, root: o.write.root, tree }) : [];
        const projectIds = a.project ? subtreeIds(tree, resolve(tree, a.project)) : undefined;
        const hits = queryNotes([...stored, ...moduleNotes], { projectIds, module: a.module, status: a.status, origin: a.origin, category: a.topic, text: a.text });
        const limit = a.limit ?? 50;
        return { total: hits.length, shown: Math.min(limit, hits.length), notes: hits.slice(0, limit).map((n) => view(tree, n)) };
      })
  );

  server.registerTool(
    'studio_add_note',
    {
      description:
        'Leave a note on a project, or on a record in a module (then the project it is linked to is used). It is labelled as written by you. For comments on manuscript text use add_notes instead, which anchors them in the chapter.',
      inputSchema: {
        body: z.string(),
        project: projectRef.optional(),
        module: z.string().optional().describe('With `record`: the module the note is about, e.g. "market".'),
        kind: z.string().optional().describe('The type of record, e.g. "category" or "book".'),
        record: z.string().optional().describe('The record\'s id in that module, e.g. a category key or an ASIN.'),
        label: z.string().optional().describe('A readable name for the record, shown in lists.'),
        topic: z.string().optional().describe(`A short label. Usual ones: ${STANDARD_TOPICS.join(', ')}.`)
      }
    },
    (a) =>
      guarded(async () => {
        if (!a.project && !a.record) throw new NoteError('Say which project the note is on, or which record (module, kind and record).');
        const { tree } = await o.studio.read();
        const target = a.record ? { module: a.module ?? '', kind: a.kind ?? 'record', id: a.record, label: a.label } : null;
        if (target && !target.module) throw new NoteError('A note on a record needs the module (for example "market").');
        const n = await o.studio.addNote({ body: a.body, projectId: a.project ? resolve(tree, a.project) : undefined, target, category: a.topic, origin: 'ai', author: who() });
        return view((await o.studio.read()).tree, n);
      })
  );

  server.registerTool(
    'studio_update_note',
    {
      description: 'Reply to a studio note, or mark it resolved (or open again). Only notes from studio_notes whose id starts with "n_" can be changed here; manuscript notes use reply_to_note.',
      inputSchema: { id: z.string(), reply: z.string().optional(), status: z.enum(['open', 'resolved']).optional() }
    },
    (a) =>
      guarded(async () => {
        if (!a.id.startsWith('n_')) throw new NoteError('That is a manuscript note; use reply_to_note for it.');
        if (a.reply !== undefined) await o.studio.replyToNote(a.id, { author: who(), body: a.reply });
        if (a.status) await o.studio.setNoteStatus(a.id, a.status);
        const d = await o.studio.read();
        return view(d.tree, d.notes.find((n) => n.id === a.id)!);
      })
  );
}
