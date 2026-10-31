import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ProjectError, WorkError, FileLinkError, CatalogueError, ancestorsOf, getProject, kindLabel, pathOf, subtreeIds, listVaultFiles, type Db, type ProjectTree, type TaskRecord } from '@cadrel/kernel';
import { PermissionDenied, type StudioService } from '@cadrel/service';
import type { Studio } from '@cadrel/studio';
import { agentFromClient } from '@cadrel/write/mcp/server';
import type { McpModule } from '../server.js';

export const RECORDS_INSTRUCTIONS =
  'These tools read and (for tasks and sign-off requests) write the studio\'s shared records, as the person you are acting for, under the permissions their role gives them: a refusal comes back with its reason. ' +
  'Tasks and deadlines belong to a project or subproject (use studio_projects for names): work_tasks lists them, work_add_task and work_set_task add and finish them. ' +
  'A sign-off is an answer that named people give (work_request_approval asks for one; you cannot answer one, only the people asked can). Decisions are the author\'s own ledger: read them with work_decisions, but tell the author to record a decision themselves. ' +
  'books_list shows the catalogue (series, position, editions with their ASINs, and the project each book is made in). files_list shows the vault\'s files, who has each checked out, what each uses and where it is used. ' +
  'You cannot approve or reject, move a project between stages, change the catalogue, check files in or out, or release anyone\'s lock: those are for the person to do in Cadrel. Never invent a project, task or person: look them up first, and ask when it is unclear.';

export interface RecordsToolOptions {
  service: StudioService;
  /** The person the assistant acts for. */
  personId: string;
  studio: Studio;
  studioId: string;
  /** The records file, to note in its audit log that a change was made through the assistant. */
  db: Db;
}

const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const failure = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });

/** A mistake the AI can correct (a refusal, a bad name, a rule) is reported to it; anything else is a real fault and propagates. */
async function guarded<T>(job: () => Promise<T>) {
  try {
    return reply(await job());
  } catch (e) {
    if (e instanceof PermissionDenied || e instanceof WorkError || e instanceof FileLinkError || e instanceof CatalogueError || e instanceof ProjectError) return failure(e.message);
    if (e instanceof Error && /^(There is no|No person|More than one)/.test(e.message)) return failure(e.message);
    throw e;
  }
}

export function recordsModule(o: RecordsToolOptions): McpModule {
  return { id: 'records', title: 'Tasks, sign-offs, decisions, books and files (the studio\'s records)', instructions: RECORDS_INSTRUCTIONS, register: (server) => registerRecordsTools(server, o) };
}

/** A project by id, name or path ("Dragon Rider / Book 1"). */
function resolveProject(t: ProjectTree, ref: string): string {
  if (getProject(t, ref)) return ref;
  const want = ref.split('/').map((s) => s.trim().toLowerCase());
  const hits = t.projects.filter((p) => {
    const path = [...ancestorsOf(t, p.id), p].map((x) => x.name.toLowerCase());
    return path.length >= want.length && want.every((w, i) => path[path.length - want.length + i] === w);
  });
  if (hits.length === 1) return hits[0]!.id;
  if (hits.length === 0) throw new Error(`There is no project "${ref}". Use studio_projects to see the names.`);
  throw new Error(`More than one project matches "${ref}" (${hits.map((h) => pathOf(t, h.id)).join('; ')}). Use a fuller path or the id.`);
}

export function registerRecordsTools(server: McpServer, o: RecordsToolOptions): void {
  const as = () => o.service.as(o.personId);
  const agent = () => agentFromClient(server.server.getClientVersion()?.name).agentName;
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;
  const projectRef = z.string().describe('A project: its id, or its name or path such as "Dragon Rider / Book 1".');

  /** The assistant is a tool of the person's role: a role without `assistant.use` has none of these. */
  const allowed = async () => {
    if (!(await as().canOn('assistant.use'))) throw new PermissionDenied('assistant.use', 'your role does not include using the assistant');
  };
  /** Notes in the audit log that the person's change was made by the assistant, so the record is honest about who typed it. */
  const viaAssistant = async (tool: string, target: string) => {
    await o.db.run('INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)', [new Date().toISOString(), o.personId, 'assistant', target, JSON.stringify({ tool, agent: agent() })]);
  };
  /** Names for ids; where the role may not see people, at least the person acted for is "me". */
  const people = async () => as().people.list().catch(() => [{ id: o.personId, name: 'me' }]);
  const personName = (list: { id: string; name: string }[], id: string | null) => (id ? list.find((p) => p.id === id)?.name ?? id : null);
  const personId = async (ref: string): Promise<string> => {
    if (ref.toLowerCase() === 'me') return o.personId;
    const list = await people();
    const hit = list.find((p) => p.id === ref);
    if (hit) return hit.id;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) return ref; // an id from a role that may not list people: the service checks the permission and that the person exists
    const hits = list.filter((p) => p.name.toLowerCase() === ref.trim().toLowerCase());
    if (hits.length === 1) return hits[0]!.id;
    throw new Error(hits.length ? `More than one person is called "${ref}". Use work_people to get the id.` : `No person called "${ref}". Use work_people to see who there is.`);
  };
  const today = () => new Date().toISOString().slice(0, 10);

  const taskView = (t: TaskRecord, tree: ProjectTree, names: { id: string; name: string }[], all: TaskRecord[]) => ({
    id: t.id,
    project: getProject(tree, t.projectId) ? pathOf(tree, t.projectId) : null,
    kind: t.kind,
    title: t.title,
    notes: t.notes || undefined,
    assignee: personName(names, t.assigneeId),
    due: t.due,
    state: t.state,
    late: t.state === 'open' && t.due !== null && t.due < today() ? true : undefined,
    waitingFor: t.dependsOn.map((d) => all.find((x) => x.id === d)).filter((d): d is TaskRecord => !!d && d.state === 'open').map((d) => d.title)
  });

  server.registerTool(
    'work_people',
    {
      description: 'The people in the studio (id and name), for assigning tasks and asking for sign-offs. Pass `project` to get only the people who are assigned to it: a task or sign-off can be given to nobody else. Needs permission to see people.',
      inputSchema: { project: projectRef.optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        if (a.project) return as().work.assignable(resolveProject((await o.studio.read()).tree, a.project));
        return (await as().people.list()).map((p) => ({ id: p.id, name: p.name, kind: p.kind }));
      })
  );

  server.registerTool(
    'work_tasks',
    {
      description: 'Tasks and deadlines, soonest first. Filter by `project` (includes its subprojects), `assignee` ("me" or a name), `state` (open by default; "any" for all) and `late_only`. Each has its project, assignee, due date, and what it is waiting for.',
      inputSchema: { project: projectRef.optional(), assignee: z.string().optional(), state: z.enum(['open', 'done', 'cancelled', 'any']).optional(), kind: z.enum(['task', 'deadline']).optional(), late_only: z.boolean().optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const { tree } = await o.studio.read();
        const projectIds = a.project ? subtreeIds(tree, resolveProject(tree, a.project)) : undefined;
        const [tasks, names] = await Promise.all([as().work.tasks({ projectIds, assigneeId: a.assignee ? await personId(a.assignee) : undefined, state: a.state, kind: a.kind, ...(a.late_only ? { overdueBefore: today() } : {}) }), people()]);
        const live = tasks.filter((t) => getProject(tree, t.projectId));
        return { tasks: live.map((t) => taskView(t, tree, names, tasks)), message: live.length ? undefined : 'No tasks match.' };
      })
  );

  server.registerTool(
    'work_add_task',
    {
      description: 'Add a task (or a deadline, which needs a date) to a project or subproject. `assignee` is "me", a name or an id; leave it out to leave it unassigned. `due` is a date such as 2026-11-30. Giving work to someone else needs permission to assign tasks. Tasks can wait for others in the same project: `depends_on` takes task ids.',
      inputSchema: { project: projectRef, title: z.string(), notes: z.string().optional(), due: z.string().optional(), kind: z.enum(['task', 'deadline']).optional(), assignee: z.string().optional(), depends_on: z.array(z.string()).optional() }
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const { tree } = await o.studio.read();
        const id = resolveProject(tree, a.project);
        if (getProject(tree, id)!.status === 'archived') throw new Error('There is no live project there: it is archived. Restore it in Cadrel first.');
        const t = await as().work.createTask({ projectId: id, title: a.title, notes: a.notes, due: a.due ?? null, kind: a.kind, assigneeId: a.assignee ? await personId(a.assignee) : null, dependsOn: a.depends_on });
        await viaAssistant('work_add_task', t.id);
        return taskView(t, tree, await people(), await as().work.tasks({ projectId: id, state: 'any' }));
      })
  );

  server.registerTool(
    'work_set_task',
    {
      description: 'Finish, reopen or cancel a task (`state`), and/or change its title, notes, due date or assignee. A task cannot be finished while something it waits for is open. You may change tasks that are assigned to the person you act for, and any task if their role allows managing tasks.',
      inputSchema: { task: z.string().describe('The task id from work_tasks.'), state: z.enum(['open', 'done', 'cancelled']).optional(), title: z.string().optional(), notes: z.string().optional(), due: z.string().nullable().optional(), assignee: z.string().nullable().optional() }
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const { tree } = await o.studio.read();
        let t = (await as().work.task(a.task)) ?? (() => { throw new Error(`There is no task ${a.task}. Use work_tasks to find its id.`); })();
        const patch = { title: a.title, notes: a.notes, due: a.due, assigneeId: a.assignee === undefined ? undefined : a.assignee === null ? null : await personId(a.assignee) };
        if (Object.values(patch).some((v) => v !== undefined)) t = await as().work.updateTask(t.id, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
        if (a.state && a.state !== t.state) t = await as().work.setState(t.id, a.state);
        await viaAssistant('work_set_task', t.id);
        return taskView(t, tree, await people(), await as().work.tasks({ projectId: t.projectId, state: 'any' }));
      })
  );

  server.registerTool(
    'work_approvals',
    {
      description: 'Sign-offs: who was asked, who answered, and the state. Filter by `project` (includes subprojects), `waiting_for_me` (those the person you act for has yet to answer) or `state`. Also says which sign-offs a project currently stands approved under.',
      inputSchema: { project: projectRef.optional(), waiting_for_me: z.boolean().optional(), state: z.enum(['pending', 'approved', 'rejected', 'withdrawn', 'any']).optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const { tree } = await o.studio.read();
        const names = await people();
        const list = a.waiting_for_me ? await as().work.waitingForMe() : await as().work.approvals({ projectIds: a.project ? subtreeIds(tree, resolveProject(tree, a.project)) : undefined, state: a.state });
        const standing = a.project ? await as().work.approvedLabels(resolveProject(tree, a.project)) : undefined;
        return {
          approvals: list.filter((x) => getProject(tree, x.projectId)).map((x) => ({
            id: x.id, project: pathOf(tree, x.projectId), label: x.label, note: x.note || undefined, state: x.state, needed: x.required, askedBy: personName(names, x.requestedBy), asked: x.requestedAt.slice(0, 10),
            approvers: x.approvers.map((p) => ({ name: personName(names, p.personId), answer: p.response, reason: p.reason || undefined }))
          })),
          ...(standing ? { projectStandsApprovedFor: standing } : {})
        };
      })
  );

  server.registerTool(
    'work_request_approval',
    {
      description: 'Ask named people to sign something off on a project ("Cover approved"). `approvers` are names or ids; `required` is how many must agree (all by default). Only the people asked can answer, in Cadrel: you cannot approve or reject. A workflow gate can require the label before a project moves to its next stage.',
      inputSchema: { project: projectRef, label: z.string().describe('Short, 40 characters at most, e.g. "Cover approved".'), approvers: z.array(z.string()).min(1), note: z.string().optional(), required: z.number().int().optional() }
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const { tree } = await o.studio.read();
        const id = resolveProject(tree, a.project);
        if (getProject(tree, id)!.status === 'archived') throw new Error('There is no live project there: it is archived. Restore it in Cadrel first.');
        const r = await as().work.requestApproval({ projectId: id, label: a.label, note: a.note, approverIds: await Promise.all(a.approvers.map(personId)), required: a.required });
        await viaAssistant('work_request_approval', r.id);
        return { id: r.id, project: pathOf(tree, id), label: r.label, state: r.state, needed: r.required, asked: r.approvers.length };
      })
  );

  server.registerTool(
    'work_decisions',
    { description: 'The decision ledger: what was decided, why, by whom and when, newest first. `current_only` leaves out decisions a later one replaced. You cannot record decisions: tell the author to, in Cadrel.', inputSchema: { project: projectRef.optional(), current_only: z.boolean().optional() }, annotations: readOnly },
    (a) =>
      guarded(async () => {
        await allowed();
        const { tree } = await o.studio.read();
        const names = await people();
        const list = await as().work.decisions({ projectIds: a.project ? subtreeIds(tree, resolveProject(tree, a.project)) : undefined, current: a.current_only });
        return { decisions: list.map((d) => ({ id: d.id, project: d.projectId && getProject(tree, d.projectId) ? pathOf(tree, d.projectId) : null, title: d.title, outcome: d.outcome, context: d.context || undefined, by: personName(names, d.decidedBy), on: d.decidedAt.slice(0, 10), replacedBy: d.supersededBy ?? undefined })) };
      })
  );

  server.registerTool(
    'work_project_status',
    {
      description: 'Where a project stands: its stage in its workflow, open and late tasks, the next date, and the sign-offs it stands approved under. Includes its subprojects\' counts.',
      inputSchema: { project: projectRef },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const { tree } = await o.studio.read();
        const id = resolveProject(tree, a.project);
        const p = getProject(tree, id)!;
        const [workflows, tasks, approved] = await Promise.all([as().workflows.list().catch(() => []), as().work.tasks({ projectIds: subtreeIds(tree, id) }), as().work.approvedLabels(id)]);
        const wf = workflows.find((w) => w.id === p.workflowId);
        const stage = wf?.stages.find((s) => s.key === p.stage);
        const dated = tasks.filter((t) => t.due).map((t) => t.due!).sort();
        return {
          project: pathOf(tree, id), kind: kindLabel(tree, p), workflow: wf?.name ?? null, stage: stage ? { name: stage.name, kind: stage.category } : null,
          openTasks: tasks.filter((t) => t.kind === 'task').length, late: tasks.filter((t) => t.due && t.due < today()).length, nextDate: dated[0] ?? null, standsApprovedFor: approved
        };
      })
  );

  server.registerTool(
    'books_list',
    {
      description: 'The catalogue: every book with its series and position, pen name, editions (format, ASIN, ISBN, price, publication date) and the project it is made in. Filter by `series` or a `search` word. For a book\'s listing, rank and sales use the market tools with its ASIN.',
      inputSchema: { series: z.string().optional(), search: z.string().optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const { tree } = await o.studio.read();
        const [books, series, links] = await Promise.all([as().catalogue.books(), as().catalogue.series(), as().catalogue.projectLinks()]);
        const sname = new Map(series.map((s) => [s.id, s.name]));
        const q = a.search?.trim().toLowerCase();
        const out = books
          .filter((b) => (!a.series || sname.get(b.seriesId ?? '')?.toLowerCase() === a.series.trim().toLowerCase()) && (!q || `${b.title} ${b.penName} ${b.editions.map((e) => `${e.asin ?? ''} ${e.isbn ?? ''}`).join(' ')}`.toLowerCase().includes(q)))
          .sort((x, y) => Number(!x.seriesId) - Number(!y.seriesId) || (sname.get(x.seriesId ?? '') ?? '').localeCompare(sname.get(y.seriesId ?? '') ?? '') || (x.position ?? 1e9) - (y.position ?? 1e9) || x.title.localeCompare(y.title));
        return {
          books: out.map((b) => {
            const pid = links.find((l) => l.bookId === b.id)?.projectId;
            return {
              id: b.id, title: b.title, subtitle: b.subtitle || undefined, penName: b.penName || undefined, series: b.seriesId ? sname.get(b.seriesId) ?? null : null, position: b.position,
              editions: b.editions.filter((e) => !e.archivedAt).map((e) => ({ format: e.format, asin: e.asin, isbn: e.isbn, price: e.price, currency: e.currency, published: e.publishedOn })),
              project: pid && getProject(tree, pid) ? pathOf(tree, pid) : null
            };
          })
        };
      })
  );

  server.registerTool(
    'files_list',
    {
      description: 'The vault\'s files: path, the newest version, who has each checked out (and since when), its state, what it uses and where it is used. Filter with `search` on the path. This lists files; it does not open them, and checking files in and out is done in Cadrel.',
      inputSchema: { search: z.string().optional(), checked_out_only: z.boolean().optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        if (!(await as().can('manuscript.read')) && !(await as().can('asset.read'))) throw new PermissionDenied('manuscript.read', 'your role cannot see the vault\'s files');
        const names = await people();
        const q = a.search?.trim().toLowerCase();
        const files = await listVaultFiles(o.db, o.studioId);
        const refs = await o.db.all<{ file: string; to: string; version: number | null }>('SELECT f.path AS file, t.path AS "to", r.version FROM file_reference r JOIN vault_file f ON f.id = r.file_id JOIN vault_file t ON t.id = r.refers_to_id');
        const kindOk = async (p: string) => (await as().can(/\.(md|markdown|txt|rtf|docx?|odt|epub|fountain|html?|json|csv)$/i.test(p) || !/\./.test(p.split('/').pop()!) ? 'manuscript.read' : 'asset.read'));
        const out = [];
        for (const f of files) {
          if ((q && !f.path.toLowerCase().includes(q)) || (a.checked_out_only && !f.lock) || !(await kindOk(f.path))) continue;
          out.push({
            path: f.path, version: f.currentVersion, state: f.state, size: f.size,
            checkedOutBy: f.lock ? { person: personName(names, f.lock.personId), since: f.lock.since.slice(0, 10) } : undefined,
            uses: refs.filter((r) => r.file === f.path).map((r) => ({ path: r.to, version: r.version ?? 'latest' })),
            usedBy: refs.filter((r) => r.to === f.path).map((r) => ({ path: r.file, version: r.version ?? 'latest' }))
          });
        }
        return { files: out };
      })
  );
}
