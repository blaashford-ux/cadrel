/**
 * Managing projects from the assistant, as the person it acts for: where a Book is in its workflow and the moves between stages (through the same
 * gates the Projects page uses), and who is assigned to a project and with what role. Creating, renaming, moving, archiving and linking projects
 * are in the studio tools; these are the parts that need the Studio's records. A refusal (a gate that is not met, a role the person may not give)
 * comes back with its reason. Projects are never deleted from here.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ProjectError, childrenOf, getProject, linksOf, pathOf, subtreeIds, viewLevel, visibleTree, type Db, type ProjectFacts, type ProjectTree, type ProjectVisibility, type StageCategory
} from '@cadrel/kernel';
import { PermissionDenied, type StudioService } from '@cadrel/service';
import { readWriteNotes, type Studio } from '@cadrel/studio';
import type { FsPort } from '@cadrel/write/src/shared/fsPort';
import { agentFromClient } from '@cadrel/write/mcp/server';
import { findNode } from '../scope.js';
import type { McpModule } from '../server.js';

export const PROJECTS_INSTRUCTIONS =
  'studio_stage shows where a Book is in its workflow and moves it (or closes or reopens it) through the same gates the Projects page uses: a move the gates or the person\'s role do not allow comes back with every reason, and you should tell the author rather than look for a way round. Only a Book has a stage. ' +
  'studio_people lists who is assigned to a project and with what role; studio_assign and studio_unassign change it, if the person you act for may manage roles. A person sees a project only if they are assigned to it (the Owner and Admin see all), and work can be given only to people assigned to its project, so assign someone before giving them a task. Never invent a person or role: look them up with studio_people and studio_roles.';

export interface ProjectsToolOptions {
  service: StudioService;
  personId: string;
  studio: Studio;
  db: Db;
  /** Where Write's manuscripts are, so their open review notes count toward a stage's gate. */
  write?: { fs: FsPort; root: string };
  /** Which projects the person can see; what they cannot see is not found. */
  view?: (tree: ProjectTree) => Promise<Pick<ProjectVisibility, 'all' | 'visible'> | null>;
}

const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const failure = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });
class Said extends Error {}
const say = (m: string): never => {
  throw new Said(m);
};
async function guarded<T>(job: () => Promise<T>) {
  try {
    return reply(await job());
  } catch (e) {
    if (e instanceof PermissionDenied || e instanceof ProjectError || e instanceof Said) return failure(e.message);
    if (e instanceof Error && /^(There is no|No person|More than one|Could not|That )/.test(e.message)) return failure(e.message);
    throw e;
  }
}

export function projectsModule(o: ProjectsToolOptions): McpModule {
  return { id: 'projects', title: 'Managing projects: stages and who is assigned', instructions: PROJECTS_INSTRUCTIONS, register: (server) => registerProjectsTools(server, o) };
}

export function registerProjectsTools(server: McpServer, o: ProjectsToolOptions): void {
  const as = () => o.service.as(o.personId);
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;
  const projectRef = z.string().describe('A project: its id, or its name or path such as "Dragon Rider / Book 1".');
  const lower = (s: string) => s.trim().toLowerCase();

  const allowed = async () => {
    if (!(await as().canOn('assistant.use'))) throw new PermissionDenied('assistant.use', 'your role does not include using the assistant');
  };
  const viaAssistant = async (tool: string, target: string) => {
    const agent = agentFromClient(server.server.getClientVersion()?.name).agentName;
    await o.db.run('INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)', [new Date().toISOString(), o.personId, 'assistant', target, JSON.stringify({ tool, agent })]);
  };
  const seen = async (): Promise<ProjectTree> => {
    const t = (await o.studio.read()).tree;
    const v = await o.view?.(t);
    return v ? visibleTree(t, v) : t;
  };
  const node = async (ref: string) => {
    const t = await seen();
    const p = findNode(t, ref);
    if (!p) return say(`There is no project "${ref}". Use studio_projects to see the names.`);
    return { t, p };
  };

  // ---- stages -------------------------------------------------------------------------------------------------

  /** What a gate can see of a project: the manuscript attached, the open notes under it, the stage categories of its books, its open tasks and standing sign-offs. */
  const factsOf = async (t: ProjectTree, id: string): Promise<ProjectFacts> => {
    const wfs = await as().workflows.list();
    const category = (q: { workflowId: string | null; stage: string | null }): StageCategory | null => wfs.find((w) => w.id === q.workflowId)?.stages.find((s) => s.key === q.stage)?.category ?? null;
    const ids = subtreeIds(t, id);
    const live = ids.filter((x) => getProject(t, x)?.status !== 'archived');
    const d = await o.studio.read();
    const moduleNotes = o.write ? await readWriteNotes({ fs: o.write.fs, root: o.write.root, tree: t }) : [];
    const open = [...d.notes, ...moduleNotes].filter((n) => n.status === 'open' && n.projectId && ids.includes(n.projectId)).length;
    return {
      openTasks: await as().work.openTaskCount(live),
      approved: await as().work.approvedLabels(id),
      hasManuscript: linksOf(t, id, 'write').length > 0,
      openNotes: open,
      subprojects: childrenOf(t, id).filter((c) => c.status !== 'archived').map(category)
    };
  };

  const stageInfo = async (t: ProjectTree, id: string) => {
    const p = getProject(t, id)!;
    if (viewLevel(t, id) !== 'book') say(`"${pathOf(t, id)}" is not a book, and only a book has a stage. A project above its books is only active or archived.`);
    if (!p.workflowId) say(`"${pathOf(t, id)}" has no workflow yet, so no stage. The author gives it one in Cadrel.`);
    const r = await as().workflows.stageOptions(p.workflowId!, p.stage, await factsOf(t, id));
    const cat = (key: string): StageCategory => r.workflow.stages.find((s) => s.key === key)?.category ?? 'active';
    return { p, workflow: r.workflow, current: r.current, options: r.options.map((x) => ({ key: x.key, name: x.name, category: cat(x.key), allowed: x.allowed, reasons: x.reasons })) };
  };

  server.registerTool(
    'studio_stage',
    {
      description:
        'Where a Book is in its workflow, and moving it. `action` "show" (default) lists the stage it is in and every stage it could go to, with whether the move is open to the person now and, if not, every reason. "move" goes to the stage `to` (its name or key); "close" moves a Book to the first closing (Done) stage the gates allow, after which it is read-only; "reopen" puts a closed Book back into a stage `to` that is not a closing one. Moves go through the workflow\'s gates (open tasks, sign-offs, a manuscript, a role) exactly as on the Projects page. Only a Book has a stage.',
      inputSchema: { project: projectRef, action: z.enum(['show', 'move', 'close', 'reopen']).optional(), to: z.string().optional().describe('The stage to move to (for move and reopen).') }
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const { t, p } = await node(a.project);
        const action = a.action ?? 'show';
        const info = await stageInfo(t, p.id);
        const shape = (x: Awaited<ReturnType<typeof stageInfo>>) => ({
          project: pathOf(t, p.id),
          workflow: x.workflow.name,
          stage: x.current ? { key: x.current.key, name: x.current.name, category: x.current.category } : null,
          closed: x.current?.category === 'done',
          moves: x.options
        });
        if (action === 'show') return shape(info);
        if (p.status === 'archived') say('That project is archived. Restore it first (studio_update_project).');
        let key: string;
        if (action === 'close') {
          if (info.current?.category === 'done') say('That book is already closed.');
          const done = info.options.filter((x) => x.category === 'done');
          if (!done.length) say(`The "${info.workflow.name}" workflow has no way to close a book from ${info.current?.name ?? 'here'}.`);
          const open = done.find((x) => x.allowed);
          if (!open) say(`It can't be closed yet: ${done[0]!.reasons.join('; ') || 'a gate is not met'}.`);
          key = open!.key;
        } else {
          if (!a.to) say(`Say which stage to go to (to). The stages open from here: ${info.options.map((x) => x.name).join('; ') || '(none)'}.`);
          const want = lower(a.to!);
          const hit = info.workflow.stages.find((s) => s.key === a.to || lower(s.name) === want);
          if (!hit) say(`The "${info.workflow.name}" workflow has no stage "${a.to}". Its stages: ${info.workflow.stages.map((s) => s.name).join('; ')}.`);
          if (action === 'reopen') {
            if (info.current?.category !== 'done') say('That book is not closed.');
            if (hit!.category === 'done') say('Choose a stage that is not a closing one.');
          }
          key = hit!.key;
        }
        await as().workflows.allowMove(info.workflow.id, p.stage, key, await factsOf(t, p.id));
        await o.studio.setStage(p.id, key);
        await viaAssistant('studio_stage', p.id);
        return shape(await stageInfo(await seen(), p.id));
      })
  );

  // ---- who is assigned ----------------------------------------------------------------------------------------

  const names = async () => {
    const [people, gone, teams] = await Promise.all([as().people.list(), as().people.list({ deactivated: true }).catch(() => []), as().people.teams()]);
    return { people, gone, teams };
  };
  const subjectName = (n: Awaited<ReturnType<typeof names>>, s: { kind: string; id: string }) => (s.kind === 'person' ? [...n.people, ...n.gone].find((p) => p.id === s.id)?.name : n.teams.find((t) => t.id === s.id)?.name) ?? s.id;

  server.registerTool(
    'studio_roles',
    {
      description: 'The roles that can be given on a project (id, name, what it is for), and who holds each. Needs permission to see people and roles.',
      inputSchema: {},
      annotations: readOnly
    },
    () => guarded(async () => (await allowed(), (await as().people.roles()).map((r) => ({ id: r.id, name: r.name, description: r.description, holders: r.holders }))))
  );

  server.registerTool(
    'studio_people',
    {
      description:
        'Who is assigned to a project: each person or team with the role they hold, where it applies (the whole project, or one book) and until when. A role on a project covers its books; one on a book covers that book only. Roles given at the whole studio are not listed here: they do not assign anyone to a project, though the Owner and Admin see every project. Needs permission to see people and roles.',
      inputSchema: { project: projectRef },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const { t, p } = await node(a.project);
        const [list, n, roles] = await Promise.all([as().people.assignments(), names(), as().people.roles()]);
        const up = new Set([p.id, ...subtreeIds(t, p.id)]);
        const above = new Set(pathOf(t, p.id).split(' / ').length > 1 ? [p.parentId].filter((x): x is string => !!x) : []);
        const here = list.filter((x) => x.scope.kind === 'project' && (up.has(x.scope.id) || above.has(x.scope.id)));
        return {
          project: pathOf(t, p.id),
          assigned: here.map((x) => ({
            assignment: x.id,
            who: subjectName(n, x.subject),
            kind: x.subject.kind,
            role: roles.find((r) => r.id === x.roleId)?.name ?? x.roleId,
            applies_to: x.scope.id === p.id ? 'this project' : above.has(x.scope.id) ? `${getProject(t, x.scope.id)?.name ?? 'the project above'} (covers this one)` : getProject(t, x.scope.id)?.name ?? x.scope.id,
            ...(x.expiresAt ? { until: x.expiresAt.slice(0, 10) } : {})
          }))
        };
      })
  );

  server.registerTool(
    'studio_assign',
    {
      description:
        'Assign a person (or a team) to a project with a role, on the whole project or on one book (name the book as the project). This is how they come to see the project and be given work on it. The person you act for must be allowed to manage roles, and the usual limits apply (nobody grants themselves a role or more than they hold). `until` ends the role on a date (YYYY-MM-DD).',
      inputSchema: { project: projectRef, person: z.string().optional().describe('A person: their name or id.'), team: z.string().optional().describe('A team: its name or id.'), role: z.string().describe('A role: its name or id (see studio_roles).'), until: z.string().optional() }
    },
    (a) =>
      guarded(async () => {
        await allowed();
        if (!!a.person === !!a.team) say('Give either a person or a team, not both and not neither.');
        const { t, p } = await node(a.project);
        const [n, roles] = await Promise.all([names(), as().people.roles()]);
        const pick = <T extends { id: string; name: string }>(list: T[], ref: string, what: string): T => {
          const hit = list.find((x) => x.id === ref) ?? undefined;
          if (hit) return hit;
          const hits = list.filter((x) => lower(x.name) === lower(ref));
          if (hits.length === 1) return hits[0]!;
          return say(hits.length ? `More than one ${what} is called "${ref}". Use the id.` : `No ${what} called "${ref}".`);
        };
        const subject = a.person ? { kind: 'person' as const, id: pick(n.people, a.person, 'person').id } : { kind: 'team' as const, id: pick(n.teams, a.team!, 'team').id };
        const role = pick(roles, a.role, 'role');
        if (a.until && !/^\d{4}-\d{2}-\d{2}$/.test(a.until)) say('until must be a date such as 2027-03-31.');
        const made = await as().people.grant({ subject, roleId: role.id, scope: { kind: 'project', id: p.id }, expiresAt: a.until ? `${a.until}T23:59:59.000Z` : null });
        await viaAssistant('studio_assign', made.id);
        return { assignment: made.id, who: subjectName(n, subject), role: role.name, project: pathOf(t, p.id), ...(a.until ? { until: a.until } : {}) };
      })
  );

  server.registerTool(
    'studio_unassign',
    {
      description: 'Take a role off a project: remove one assignment (its id is from studio_people). Only assignments on projects can be removed here; the last Owner cannot be removed.',
      inputSchema: { assignment: z.string() }
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const found = (await as().people.assignments()).find((x) => x.id === a.assignment);
        if (!found) say(`There is no assignment "${a.assignment}". Use studio_people to see the ids.`);
        if (found!.scope.kind !== 'project') say('That role is not on a project (it is at the whole studio or on a file), so it is not removed here.');
        await as().people.revoke(a.assignment);
        await viaAssistant('studio_unassign', a.assignment);
        return { removed: a.assignment };
      })
  );
}
