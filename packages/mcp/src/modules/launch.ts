import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WorkError, ProjectError, ancestorsOf, getProject, pathOf, subtreeIds, type ProjectTree } from '@cadrel/kernel';
import { PermissionDenied, type StudioService } from '@cadrel/service';
import type { Studio } from '@cadrel/studio';
import { agentFromClient } from '@cadrel/write/mcp/server';
import type { McpModule } from '../server.js';
import { STUDIO_HINT } from '@cadrel/write/src/shared/agent/tools';

export const LAUNCH_INSTRUCTIONS =
  'These tools are for the studio\'s release plans and the Market figures behind them. launch_plans lists the plans; launch_outstanding says what is still to do for a release date, with whose it is and why each item is blocked (it is worked out from the studio\'s records, so do not tick anything off yourself). ' +
  'arc_status gives counts only (never names or emails). market_figures and market_comps give published figures with the date each was captured: always say that date. launch_brief_read and launch_brief_draft read and write marketing and campaign briefs (a draft is a new version a person reads and keeps or reverts), and report_save keeps a market report. ' +
  'You cannot approve a plan, apply a change of date, change an ARC reader, or publish figures: those are people\'s decisions, made in Cadrel. Say whether a figure is measured (from a capture) or reported (typed by the studio), and never say a change caused a movement in rank.';

export interface LaunchToolOptions {
  service: StudioService;
  personId: string;
  studio: Studio;
}

const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const failure = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });
async function guarded<T>(job: () => Promise<T>) {
  try {
    return reply(await job());
  } catch (e) {
    if (e instanceof PermissionDenied || e instanceof WorkError || e instanceof ProjectError) return failure(e.message);
    if (e instanceof Error && /^(There is|That |More than|The Studio|Quote)/.test(e.message)) return failure(e.message);
    throw e;
  }
}

export function launchModule(o: LaunchToolOptions): McpModule {
  return { id: 'launch', title: 'Launch and market', instructions: LAUNCH_INSTRUCTIONS, register: (server) => registerLaunchTools(server, o) };
}

export function registerLaunchTools(server: McpServer, o: LaunchToolOptions): void {
  const as = () => o.service.as(o.personId);
  const agent = () => agentFromClient(server.server.getClientVersion()?.name).agentName;
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;
  const writes = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
  const allowed = async () => {
    if (!(await as().canOn('assistant.use'))) throw new PermissionDenied('assistant.use', 'your role does not include using the assistant');
    await as().assistant.check(); // and the Studio has not turned the assistant off (its security policy)
  };
  const viaAssistant = async (tool: string, target: string) => as().assistant.note(tool, agent(), target);
  const people = async () => as().people.list().catch(() => [{ id: o.personId, name: 'me' }]);
  const nameOf = (list: { id: string; name: string }[], id: string | null) => (!id ? undefined : id === o.personId ? 'me' : list.find((p) => p.id === id)?.name ?? id);
  const resolveProject = (t: ProjectTree, ref: string): string => {
    if (getProject(t, ref)) return ref;
    const want = ref.split('/').map((s) => s.trim().toLowerCase());
    const hits = t.projects.filter((p) => {
      const path = [...ancestorsOf(t, p.id), p].map((x) => x.name.toLowerCase());
      return path.length >= want.length && want.every((w, i) => path[path.length - want.length + i] === w);
    });
    if (hits.length === 1) return hits[0]!.id;
    throw new Error(hits.length ? `There is more than one project "${ref}". Use a fuller path or the id.` : `There is no project "${ref}". Use studio_projects to see the names.${STUDIO_HINT}`);
  };
  const findPlan = async (ref: string, project?: string) => {
    const direct = await as().launch.plan(ref).catch(() => null);
    if (direct) return direct;
    const { tree } = await o.studio.read();
    const ids = project ? subtreeIds(tree, resolveProject(tree, project)) : undefined;
    const plans = await as().launch.plans({ projectIds: ids });
    const hits = plans.filter((p) => p.name.toLowerCase().includes(ref.trim().toLowerCase()));
    if (hits.length !== 1) throw new Error(hits.length ? `More than one plan matches "${ref}". Use its id (launch_plans shows them).` : `There is no plan "${ref}", or your role cannot see it. Use launch_plans.`);
    return (await as().launch.plan(hits[0]!.id))!;
  };

  server.registerTool(
    'launch_plans',
    {
      description: 'The release plans: each with its book, release date, state, how many days to go, and how many required items are outstanding, late and blocked. `project` limits it to a book or series.',
      inputSchema: { project: z.string().optional(), state: z.enum(['open', 'draft', 'approved', 'live', 'reviewed', 'cancelled', 'any']).optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const { tree } = await o.studio.read();
        const ids = a.project ? subtreeIds(tree, resolveProject(tree, a.project)) : undefined;
        const plans = await as().launch.plans({ projectIds: ids, state: a.state ?? 'open' });
        return Promise.all(
          plans.map(async (p) => {
            const v = (await as().launch.plan(p.id))!;
            const req = v.items.filter((i) => i.item.required);
            return { id: p.id, name: p.name, book: pathOf(tree, p.projectId), releaseDate: p.releaseDate, state: p.state, daysToRelease: v.daysToRelease, outstanding: v.outstanding.length, late: req.filter((i) => i.status === 'late').length, blocked: req.filter((i) => i.status === 'blocked').length, changedSinceApproval: v.changedSinceApproval || undefined, targets: p.targets };
          })
        );
      })
  );

  server.registerTool(
    'launch_outstanding',
    {
      description: 'What is still to do for a release date: each required item not done, soonest first, with its due date, whose it is, whether it is late or blocked, and why in words. This is computed from the studio\'s records (the cover, Preflight, sign-offs, requests, briefs, ARC readers). With `all` it lists every item.',
      inputSchema: { plan: z.string().describe('The plan\'s id, or part of its name.'), project: z.string().optional(), all: z.boolean().optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const v = await findPlan(a.plan, a.project);
        const names = await people();
        const rows = (a.all ? v.items : v.outstanding).map((i) => ({ item: i.task.title, key: i.item.key, status: i.status, due: i.task.due, daysLate: i.status === 'late' ? i.daysLate : undefined, assignedTo: nameOf(names, i.task.assigneeId), required: i.item.required, why: i.reasons.length ? i.reasons : undefined }));
        return { plan: v.plan.name, releaseDate: v.plan.releaseDate, daysToRelease: v.daysToRelease, state: v.plan.state, counts: v.counts, items: rows };
      })
  );

  server.registerTool(
    'arc_status',
    {
      description: 'The state of a plan\'s ARC rounds: counts only (invited, has the file, reviewed, declined) against the targets, the reviews the studio reports, and the ratings count on the book\'s page as last captured. It never gives names or emails.',
      inputSchema: { plan: z.string(), project: z.string().optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const v = await findPlan(a.plan, a.project);
        const rounds = await as().launch.campaigns(v.plan.id);
        return Promise.all(
          rounds.map(async (k) => {
            const x = await as().launch.crossCheck(k.id);
            return { round: k.name, readers: k.counts.byState, haveTheFile: k.counts.withFile, wanted: k.targetReaders || undefined, markedReviewed: k.counts.reviewed, reviewsHopedFor: k.reviewTarget || undefined, fileVersion: k.fileVersion ?? undefined, reportedByTheStudio: x.reported, measuredRatingsCount: x.measured ? { ratings: x.measured.ratings, capturedAt: x.measured.capturedAt } : 'no figure published' };
          })
        );
      })
  );

  server.registerTool(
    'market_figures',
    {
      description: 'Published Market figures for a book: price, rank, ratings count and average, each with the time it was captured. `asin` is the book\'s ASIN. Say when a figure was captured. A rank is a position in a store, not sales.',
      inputSchema: { asin: z.string().length(10), from: z.string().optional().describe('An ISO date or time.'), to: z.string().optional(), limit: z.number().int().min(1).max(500).optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const figs = await as().marketing.figures({ asin: a.asin, from: a.from, to: a.to, limit: a.limit ?? 200 });
        return figs.map((f) => ({ capturedAt: f.capturedAt, title: f.title || undefined, price: f.price ?? undefined, rank: f.rank ?? undefined, ratings: f.ratings ?? undefined, ratingAvg: f.ratingAvg ?? undefined }));
      })
  );

  server.registerTool(
    'market_comps',
    {
      description: 'The comps a marketing or campaign brief was written against: each with its role, and the figures the brief saw (as of their capture dates and how old they were), and whether a newer figure has been published since. With `project`, lists the studio\'s comp sets instead.',
      inputSchema: { brief: z.string().optional(), project: z.string().optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        if (a.brief) {
          const b = await findBrief(a.brief);
          const comps = await as().marketing.briefComps(b.id, b.current.n);
          const out = [];
          for (const c of comps) {
            const latest = await as().marketing.latest(c.asin).catch(() => null);
            out.push({ asin: c.asin, role: c.role, note: c.note || undefined, seen: c.figure ? { capturedAt: c.figure.capturedAt, ageDaysWhenToday: c.ageDays, rank: c.figure.rank ?? undefined, price: c.figure.price ?? undefined, ratings: c.figure.ratings ?? undefined, title: c.figure.title || undefined } : 'no figure had been published', newerFigure: latest && c.figure && latest.capturedAt > c.figure.capturedAt ? { capturedAt: latest.capturedAt, rank: latest.rank ?? undefined } : undefined });
          }
          return { brief: b.title, version: b.current.n, comps: out };
        }
        const { tree } = await o.studio.read();
        const ids = a.project ? subtreeIds(tree, resolveProject(tree, a.project)) : undefined;
        return (await as().marketing.compSets({ projectIds: ids })).map((s) => ({ id: s.id, name: s.name, book: pathOf(tree, s.projectId), asins: s.asins, note: s.note || undefined }));
      })
  );

  const findBrief = async (ref: string) => {
    const direct = await as().briefs.get(ref).catch(() => null);
    if (direct && (direct.kind === 'launch' || direct.kind === 'campaign')) return direct;
    const all = [...(await as().briefs.list({ kind: 'launch' })), ...(await as().briefs.list({ kind: 'campaign' }))].filter((b) => b.title.toLowerCase().includes(ref.trim().toLowerCase()));
    if (all.length !== 1) throw new Error(all.length ? `More than one brief matches "${ref}". Use its id.` : `There is no marketing or campaign brief "${ref}", or your role cannot see it.`);
    return all[0]!;
  };

  server.registerTool(
    'launch_brief_read',
    {
      description: 'The studio\'s marketing and campaign briefs for a project, each with its newest text; give a `brief` id or title to read one with its earlier versions.',
      inputSchema: { project: z.string().optional(), brief: z.string().optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const { tree } = await o.studio.read();
        if (a.brief) {
          const b = await findBrief(a.brief);
          const names = await people();
          return { id: b.id, kind: b.kind, title: b.title, book: pathOf(tree, b.projectId), version: b.current.n, brief: b.current.body, writtenBy: nameOf(names, b.current.writtenBy), earlier: (await as().briefs.versions(b.id)).filter((v) => v.n !== b.current.n).map((v) => ({ version: v.n, brief: v.body, note: v.note || undefined })) };
        }
        const ids = a.project ? subtreeIds(tree, resolveProject(tree, a.project)) : undefined;
        const all = [...(await as().briefs.list({ kind: 'launch', projectIds: ids })), ...(await as().briefs.list({ kind: 'campaign', projectIds: ids }))];
        return all.map((b) => ({ id: b.id, kind: b.kind, title: b.title, book: pathOf(tree, b.projectId), version: b.current.n, brief: b.current.body }));
      })
  );

  server.registerTool(
    'launch_brief_draft',
    {
      description: 'Writes a marketing or campaign brief as a draft: a new brief, or a new version of one you give the id of (it never overwrites: a person can revert to the earlier version). Name the comps it was written against with `comps` (ASINs) and their published figures are pinned as of now. Say what you based it on.',
      inputSchema: {
        project: z.string().describe('The book, as its id, name or path.'),
        title: z.string().min(1).max(200).optional(),
        kind: z.enum(['launch', 'campaign']).optional(),
        body: z.string().min(1).max(20000),
        brief: z.string().optional().describe('The id of a brief to write a new version of.'),
        note: z.string().max(500).optional().describe('What changed, for a new version.'),
        comps: z.array(z.string().length(10)).max(30).optional()
      },
      annotations: writes
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const { tree } = await o.studio.read();
        const projectId = resolveProject(tree, a.project);
        let id: string;
        let version: number;
        if (a.brief) {
          const b = await findBrief(a.brief);
          const r = await as().briefs.revise(b.id, { body: a.body, note: a.note, basedOn: b.current.n });
          id = r.id;
          version = r.current.n;
        } else {
          if (!a.title) throw new Error('A new brief needs a title.');
          const r = await as().briefs.create({ projectId, kind: a.kind ?? 'launch', title: a.title, body: a.body });
          id = r.id;
          version = 1;
        }
        if (a.comps?.length) await as().marketing.pinComps(id, version, a.comps.map((asin) => ({ asin })));
        await viaAssistant('launch_brief_draft', id);
        return { brief: id, version, comps: a.comps?.length ?? 0, note: 'A person reads it and keeps it or goes back to the earlier version in Cadrel.' };
      })
  );

  server.registerTool(
    'report_save',
    {
      description: 'Keeps a market report (a category, keyword or cover/blurb comparison) so people can read it later. `asOf` is the day its figures are as of. A saved report is never edited; save a new one. Put what you measured in `payload`, and say in it what you did not.',
      inputSchema: { project: z.string(), kind: z.enum(['category', 'keyword', 'cover_blurb']), title: z.string().min(1).max(200), asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), payload: z.record(z.string(), z.unknown()) },
      annotations: writes
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const { tree } = await o.studio.read();
        const r = await as().marketing.saveReport({ projectId: resolveProject(tree, a.project), kind: a.kind, title: a.title, asOf: a.asOf, payload: a.payload });
        await viaAssistant('report_save', r.id);
        return { report: r.id, asOf: r.asOf };
      })
  );
}
