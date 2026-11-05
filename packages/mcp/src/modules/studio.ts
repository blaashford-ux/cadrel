import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ProjectError, NoteError, UserError, STANDARD_TOPICS, ancestorsOf, childrenOf, getProject, kindLabel, linksOf, outline, pathOf, queryNotes, subtreeIds, viewBooks, viewLevel,
  type Note, type NoteView, type ProjectTree, type ProjectVisibility, visibleTree
} from '@cadrel/kernel';
import { readWriteNotes, type Studio, type UserStore } from '@cadrel/studio';
import type { FsPort } from '@cadrel/write/src/shared/fsPort';
import { agentFromClient } from '@cadrel/write/mcp/server';
import { listProjectFiles } from '@cadrel/write/src/shared/agent/projectFiles';
import { bookOf, findBook, findNode } from '../scope.js';
import { makeProjects } from '@cadrel/write/src/shared/backend/projects';
import { defaultTemplates, projectNameError } from '@cadrel/write/src/shared/projects';
import type { McpModule } from '../server.js';

export const STUDIO_INSTRUCTIONS =
  'Projects are how the studio is organised. A Project (usually a Series) holds its Books, each with its own manuscript folder, stage and files; the Project itself has no stage, and its own folder holds the series-level material (series bible, characters, world, style). A Book reads the series level for context and keeps its own manuscript, outline, blurb and keywords. Books are opened, worked and closed one at a time or several together; a closed Book is read-only. ' +
  'Name the Project, and the Book when it has more than one open (the tools say which to pick when you do not). studio_context shows one Project and Book whole: its series files to read first, its Book files, and where new work belongs. ' +
  'Everything else, manuscripts and market research included, is linked to a project. Start with studio_projects to see the tree and what is linked where. ' +
  'Notes are the same everywhere: studio_notes lists them across all modules (including the review notes in manuscripts), and studio_add_note leaves one on a project or on any record of a module. ' +
  'studio_user says who you are acting for and lists the files they attached to their profile, which you may open with studio_user_file (only the files they have not hidden from you are listed). You can organise projects (create, rename, reorder, move, link manuscripts, Market categories and comparable titles, archive) but you cannot delete them; a new Book is given its starting stage, and moving or closing a Book is studio_stage. Never invent a project: ask the author if the right one is unclear.';

export interface StudioToolOptions {
  studio: Studio;
  /** The person's profile, if this computer has one: the assistant may read their name, pen names and bio, and the files they have attached unless they opted out (never their email). */
  user?: UserStore;
  /** Where Write's manuscripts are, so their review notes are listed too. */
  write?: { fs: FsPort; root: string };
  /** The Books that are closed (in a Done stage). Absent where the workflows are not known: none is then shown as closed. */
  closed?: () => Promise<ReadonlySet<string>>;
  /**
   * Which projects the person the assistant acts for can see: only those they are assigned to (the Owner and an Admin see all). The assistant
   * is told of no other project, and cannot name one. Absent where the Studio's people are not known: then nothing is limited.
   */
  view?: (tree: ProjectTree) => Promise<Pick<ProjectVisibility, 'all' | 'visible'> | null>;
  /**
   * The workflow and starting stage for a new Book (the default for new books), or null where there is none to give. Without it a Book is made
   * with no stage, as in a Studio whose workflows are not known here.
   */
  stageForNewBook?: () => Promise<{ workflowId: string; stage: string } | null>;
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

/** What a new folder came with, for the assistant to see. */
const flattenNote = (t: { folders: { name: string }[]; files: { path: string }[] }) => ({ folders: t.folders.map((f) => f.name), files: t.files.map((f) => f.path) });

const row = (t: ProjectTree, id: string, closed: ReadonlySet<string> = new Set()) => {
  const p = getProject(t, id)!;
  const level = viewLevel(t, id);
  const folder = linksOf(t, id, 'write')[0]?.ref ?? null;
  return {
    id: p.id,
    name: p.name,
    kind: kindLabel(t, p),
    /** "project" (a series, no stage of its own), "book" (has the stage), or "inside" a Book. */
    level,
    status: p.status,
    path: pathOf(t, id),
    ...(level === 'book' ? { stage: p.stage, closed: closed.has(id) } : {}),
    /** The manuscript folder to name as `project` in the writing tools (series-level material for a Project, a Book's own for a Book). */
    manuscript_folder: folder,
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
  const closedSet = async () => (o.closed ? await o.closed() : new Set<string>());
  /** The studio's data as the person the assistant acts for may see it: projects they are not assigned to, and the notes on them, are not there. */
  const seen = async () => {
    const d = await o.studio.read();
    const v = await o.view?.(d.tree);
    if (!v) return d;
    const tree = visibleTree(d.tree, v);
    const ids = new Set(tree.projects.map((p) => p.id));
    return { ...d, tree, notes: d.notes.filter((n) => !n.projectId || ids.has(n.projectId)) };
  };

  server.registerTool(
    'studio_user',
    {
      description:
        'Who you are acting for: their name, the pen names they write under, their own short "about me", and the files they have attached to their profile (author bio, photo, contracts…) with what each is for. Use it to sign things and to write in their voice; open a file with studio_user_file. The person can hide any file from you, and a hidden file is simply not listed. Their email is private and never available.',
      inputSchema: {},
      annotations: readOnly
    },
    () =>
      guarded(async () => {
        if (!o.user) return { message: 'No profile is set up on this computer.' };
        const u = await o.user.read();
        const files = await o.user.filesForAssistant();
        return {
          name: u.displayName || null,
          penNames: u.penNames,
          about: u.bio || null,
          files: files.map((a) => ({ id: a.id, name: a.name, type: a.mime, bytes: a.size, for: a.note || null, addedBy: a.origin === 'assistant' ? 'AI' : 'the person', added: a.addedAt }))
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
        const { tree } = await seen();
        const closed = await closedSet();
        const root = a.project ? resolve(tree, a.project) : null;
        const inside = root ? new Set(subtreeIds(tree, root)) : null;
        const rows = outline(tree, { archived: a.include_archived }).filter((r) => !inside || inside.has(r.project.id));
        if (!rows.length) return { projects: [], message: 'No projects yet. Create one with studio_create_project, or the author can in Cadrel.' };
        return { projects: rows.map((r) => ({ depth: r.depth, ...row(tree, r.project.id, closed), subprojects: childrenOf(tree, r.project.id).length })) };
      })
  );

  server.registerTool(
    'studio_context',
    {
      description:
        'One Project and Book, whole: where the series-level material lives (and which of its files to read first), the Book\'s own files, the other Books with their stages, and where new work belongs. ' +
        'Call it before working on a Book, so you read the series bible, characters and world before you write anything that must agree with them. A Project with one open Book needs no `book`; with several, say which.',
      inputSchema: { project: projectRef, book: z.string().optional().describe('Which Book, such as "Book 2". Leave out for the series level.') },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        const { tree } = await seen();
        const closed = await closedSet();
        const found = findNode(tree, a.project);
        if (!found) throw new ProjectError(`There is no project "${a.project}". Use studio_projects to see the names.`);
        const level = viewLevel(tree, found.id);
        const project = level === 'project' ? found : getProject(tree, found.parentId ?? '') ?? found;
        const open = viewBooks(tree, project.id).filter((b) => !closed.has(b.id));
        let book = a.book ? findBook(tree, project, a.book) : level !== 'project' ? bookOf(tree, found) : open.length === 1 ? open[0]! : null;
        if (!book && open.length > 1) book = null;
        const folderOf = (id: string) => linksOf(tree, id, 'write')[0]?.ref ?? null;
        const ctx = o.write ? { fs: o.write.fs, root: o.write.root, agent: 'ai', agentName: 'AI' } : null;
        const files = async (folder: string | null): Promise<{ file: string; kind: string }[]> => (folder && ctx ? ((await listProjectFiles(ctx, folder).catch(() => null))?.files ?? []).map((f) => ({ file: f.file, kind: f.kind })) : []);
        const seriesFolder = folderOf(project.id);
        const seriesFiles = await files(seriesFolder);
        const bookFolder = book ? folderOf(book.id) : null;
        const READ_FIRST = ['bible', 'premise', 'character', 'world', 'style'];
        return {
          project: { name: project.name, ...(seriesFolder ? { folder: seriesFolder } : {}), files: seriesFiles },
          book: book ? { name: book.name, stage: book.stage, closed: closed.has(book.id), folder: bookFolder, files: await files(bookFolder) } : null,
          books: viewBooks(tree, project.id).map((b) => ({ name: b.name, stage: b.stage, closed: closed.has(b.id), folder: folderOf(b.id), this_one: b.id === book?.id })),
          read_first: seriesFiles.filter((f) => READ_FIRST.includes(f.kind)).map((f) => f.file),
          where_things_go: {
            series_level: 'Series bible, characters, worldbuilding, style sheet and the series premise or arc: in the Project\'s folder' + (seriesFolder ? ` ("${seriesFolder}")` : ' (this project has none yet; the author adds one in Cadrel)') + '.',
            book_level: 'Manuscript, outline, book premise, blurb, keywords and trackers: in the Book\'s own folder' + (bookFolder ? ` ("${bookFolder}")` : book ? ' (this Book has none yet)' : ' (choose a Book first)') + '.'
          },
          ...(book ? {} : open.length > 1 ? { choose_a_book: `${project.name} has ${open.length} open books: ${open.map((b) => b.name).join('; ')}. Ask which one before doing book-level work.` } : {}),
          ...(book && closed.has(book.id) ? { note: `${book.name} is closed: you can read it but not change it.` } : {})
        };
      })
  );

  server.registerTool(
    'studio_create_project',
    {
      description:
        'Create a project. With no `parent` it is a top-level project: usually a Series (kind "Series") that will hold books, or, with `standalone` true, a standalone novel (a project that holds its one book, made together). With `parent` set to a project it is a Book under it (kind "Book"), and it starts in the first stage of the default workflow for new books; with `parent` set to a Book it is something inside that book. `kind` is a free label. A new project has no manuscript folder: the author adds one in Cadrel, or link an existing one with studio_link.',
      inputSchema: { name: z.string(), parent: projectRef.optional(), kind: z.string().optional(), standalone: z.boolean().optional() }
    },
    (a) =>
      guarded(async () => {
        const t = (await seen()).tree;
        const parentId = a.parent ? resolve(t, a.parent) : null;
        if (a.standalone && parentId) throw new ProjectError('A standalone novel is a top-level project; leave out parent.');
        const slot = (id: string | null) => !!id && viewLevel(t, id) === 'project';
        const start = a.standalone || slot(parentId) ? ((await o.stageForNewBook?.()) ?? null) : null;
        if (a.standalone) {
          const proj = await o.studio.createProject({ name: a.name, parentId: null, kind: a.kind ?? 'Standalone' });
          try {
            await o.studio.createProject({ name: a.name, parentId: proj.id, kind: 'Book', ...(start ?? {}) });
          } catch (e) {
            await o.studio.deleteProject(proj.id, { cascade: true }).catch(() => undefined); // a standalone is made whole or not at all
            throw e;
          }
          return row((await seen()).tree, proj.id, await closedSet());
        }
        const p = await o.studio.createProject({ name: a.name, parentId, kind: a.kind ?? (slot(parentId) ? 'Book' : undefined), ...(start ?? {}) });
        return row((await seen()).tree, p.id, await closedSet());
      })
  );

  server.registerTool(
    'studio_add_folder',
    {
      description:
        'Give a project or book its manuscript folder, made from a template (Novel, Series, Short Story or Blank), and link it. A project made with studio_create_project has no folder, so none of the writing tools (list_files, create_file, write_project_file, the trackers) can work on it until it has one. The folder is made whole or not at all, inside the Projects folder, and the project owns it: a project has one folder, and a closed book cannot be given one. `name` defaults to the project\'s name with characters a folder cannot hold taken out; `template` defaults to Series for a series and Novel for a book. This is the folder only: add the files with create_file or write_project_file.',
      inputSchema: { project: projectRef, name: z.string().optional(), template: z.string().optional().describe('"Novel", "Series", "Short Story" or "Blank".') }
    },
    (a) =>
      guarded(async () => {
        if (!o.write) throw new ProjectError('There is no Projects folder for the writing tools here, so a manuscript folder cannot be made. Choose one in Cadrel first.');
        const t = (await seen()).tree;
        const id = resolve(t, a.project);
        const p = getProject(t, id)!;
        if (p.status === 'archived') throw new ProjectError(`"${p.name}" is archived. Restore it first.`);
        if (linksOf(t, id, 'write').length) throw new ProjectError(`"${p.name}" already has a manuscript folder ("${linksOf(t, id, 'write')[0]!.ref}"). A project has one; use create_file to add files to it.`);
        if ((await closedSet()).has(id)) throw new ProjectError(`${p.name} is closed, so it is read-only. Reopen it first.`);
        const level = viewLevel(t, id);
        const want = (a.template ?? (level === 'project' ? 'series' : 'novel')).trim().toLowerCase();
        const template = defaultTemplates().find((x) => x.id === want || x.name.toLowerCase() === want);
        if (!template) throw new ProjectError(`There is no template "${a.template}". Use Novel, Series, Short Story or Blank.`);
        const name = (a.name ?? p.name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
        const bad = projectNameError(name);
        if (bad) throw new ProjectError(a.name ? bad : `${bad} Give a name for the folder.`);
        const made = await makeProjects(o.write.fs).createProject(o.write.root, name, template);
        const folder = made.path.split(/[\\/]/).pop()!;
        await o.studio.link(id, 'write', folder);
        return { ...row((await seen()).tree, id, await closedSet()), folder, template: template.name, created: flattenNote(template) };
      })
  );

  server.registerTool(
    'studio_update_project',
    {
      description:
        'Rename a project, change its kind, move it under another project (`parent`; use "" for the top level) or to a place among its siblings (`position`, counting from 1), or archive or restore it. Archiving also archives its subprojects. This cannot delete a project.',
      inputSchema: { project: projectRef, name: z.string().optional(), kind: z.string().optional(), parent: z.string().optional(), position: z.number().int().min(1).optional(), archived: z.boolean().optional() }
    },
    (a) =>
      guarded(async () => {
        const t = (await seen()).tree;
        const id = resolve(t, a.project);
        if (a.name !== undefined || a.kind !== undefined) await o.studio.updateProject(id, { name: a.name, kind: a.kind });
        if (a.parent !== undefined || a.position !== undefined) {
          const parent = a.parent === undefined ? getProject(t, id)?.parentId ?? null : a.parent === '' ? null : resolve(t, a.parent);
          await o.studio.moveProject(id, parent, a.position === undefined ? undefined : a.position - 1);
        }
        if (a.archived !== undefined) await o.studio.archiveProject(id, a.archived);
        return row((await seen()).tree, id, await closedSet());
      })
  );

  server.registerTool(
    'studio_link',
    {
      description:
        'Link a module\'s record to a project, or (with project omitted) unlink it. A manuscript (write) belongs to one project and linking it again moves it; a Market category can belong to several projects, so linking it adds it and keeps the others; to take it out of one project, give that project with unlink true, and with no project it leaves all of them. Records: module "write" with the manuscript folder name from list_projects, module "market" with a category key, or module "comp" with the ASIN of a comparable title (it can be a comp for several projects).',
      inputSchema: { module: z.enum(['write', 'market', 'comp']), record: z.string(), project: projectRef.optional(), unlink: z.boolean().optional() }
    },
    (a) =>
      guarded(async () => {
        if (!a.project) {
          await o.studio.unlink(a.module, a.record);
          return { unlinked: a.record };
        }
        if (a.unlink) {
          const from = resolve((await seen()).tree, a.project);
          await o.studio.unlink(a.module, a.record, from);
          return row((await seen()).tree, from);
        }
        const id = resolve((await seen()).tree, a.project);
        await o.studio.link(id, a.module, a.record);
        return row((await seen()).tree, id, await closedSet());
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
        const { tree, notes } = await seen();
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
        const { tree } = await seen();
        const target = a.record ? { module: a.module ?? '', kind: a.kind ?? 'record', id: a.record, label: a.label } : null;
        if (target && !target.module) throw new NoteError('A note on a record needs the module (for example "market").');
        const n = await o.studio.addNote({ body: a.body, projectId: a.project ? resolve(tree, a.project) : undefined, target, category: a.topic, origin: 'ai', author: who() });
        return view((await seen()).tree, n);
      })
  );

  server.registerTool(
    'studio_update_note',
    {
      description: 'Reply to a studio note, mark it resolved (or open again), or change its topic. Only notes from studio_notes whose id starts with "n_" can be changed here; manuscript notes use reply_to_note.',
      inputSchema: { id: z.string(), reply: z.string().optional(), status: z.enum(['open', 'resolved']).optional(), topic: z.string().optional().describe('Change the note\'s topic; empty to remove it.') }
    },
    (a) =>
      guarded(async () => {
        if (!a.id.startsWith('n_')) throw new NoteError('That is a manuscript note; use reply_to_note for it.');
        if (a.reply !== undefined) await o.studio.replyToNote(a.id, { author: who(), body: a.reply });
        if (a.status) await o.studio.setNoteStatus(a.id, a.status);
        if (a.topic !== undefined) await o.studio.editNote(a.id, { category: a.topic });
        const d = await o.studio.read();
        return view(d.tree, d.notes.find((n) => n.id === a.id)!);
      })
  );

  server.registerTool(
    'studio_rename_topic',
    {
      description:
        'Rename a note topic on every studio note that has it, e.g. to fix a spelling or merge "pacing " into "pacing"; an empty new_topic removes the topic from them. Topics are lower-cased and trimmed. Manuscript review notes keep their own topics and are not changed. Changes the studio; only call when the user asks.',
      inputSchema: { topic: z.string().describe('The topic as shown by studio_notes'), new_topic: z.string().describe('The new topic; empty to remove') }
    },
    (a) =>
      guarded(async () => {
        const changed = await o.studio.renameNoteTopic(a.topic, a.new_topic);
        return { changed, topic: a.topic.trim().toLowerCase(), now: a.new_topic.trim().toLowerCase() || null };
      })
  );
}
