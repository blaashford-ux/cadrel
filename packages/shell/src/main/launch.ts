/**
 * Launch and market as the Launch page sees them (docs/M6-PLAN.md): the release plans of the project in view with what is outstanding (worked out from
 * the other records), each plan with its date proposals, ARC rounds (counts for everyone, people for managers), asset requests and review, the marketing
 * briefs with the comps they were written against, and Market figures published from this computer's library. Electron-free; tested in test/launch.test.ts.
 *
 * Who may do what is the service's to say, not this file's: every change goes through it and a refusal comes back as it is.
 */
import { imageInfo, subtreeIds, type ProjectTree } from '@cadrel/kernel';
import { PermissionDenied } from '@cadrel/service';
import {
  LAUNCH_CALLS, type LaunchBriefRow, type LaunchBriefView, type LaunchCallName, type LaunchItemRow, type LaunchMarketView, type LaunchMay, type LaunchPlanView, type LaunchState, type PlanSummary
} from '../shared/api';
import type { ArtFiles } from './art';
import type { PeopleHost } from './people';
import type { StudioService } from './studio';

export class LaunchError extends Error {}

/** What Launch reads from this computer's Market library: the captures of one book, as the library keeps them. */
export interface FigureSource {
  history(asin: string): { capturedAt: string; ratingValue: number | null; ratingCount: number | null; kindlePrice: number | null; overallRank: number | null }[];
}

export class Launch {
  constructor(
    private readonly studio: StudioService,
    private readonly people: PeopleHost,
    private readonly files: ArtFiles | null = null,
    private readonly library: FigureSource | null = null
  ) {}

  private as() {
    const svc = this.people.service;
    return svc ? svc.as(this.people.me) : null;
  }
  private need() {
    const as = this.as();
    if (!as) throw new LaunchError('Launch for this Studio is managed by its owner.');
    return as;
  }
  private async names(): Promise<Map<string, string>> {
    return new Map((await this.people.peopleList().catch(() => [] as { id: string; name: string }[])).map((p) => [p.id, p.name]));
  }
  private nameOf(names: Map<string, string>, id: string | null | undefined): string {
    return !id ? '' : id === this.people.me ? 'you' : names.get(id) ?? 'someone';
  }
  private async may(projectId: string): Promise<LaunchMay> {
    const m = (c: string) => this.people.mayOn(c, projectId).catch(() => false);
    const [read, manage, approve, capture] = await Promise.all([m('launch.read'), m('launch.manage'), m('launch.approve'), m('market.capture')]);
    return { read, manage, approve, capture };
  }
  private project(tree: ProjectTree, ref?: string) {
    if (ref) return tree.projects.find((p) => p.id === ref && p.status !== 'archived') ?? null;
    return tree.projects.filter((p) => !p.parentId && p.status !== 'archived').sort((a, b) => a.name.localeCompare(b.name))[0] ?? null;
  }
  /** The editions of the books of the project in view, with the book each is made in. */
  private async editions(as: NonNullable<ReturnType<Launch['as']>>, inside: Set<string>) {
    try {
      const [links, books] = await Promise.all([as.catalogue.projectLinks(), as.catalogue.books()]);
      const where = new Map(links.map((l) => [l.bookId, l.projectId]));
      const out: { id: string; label: string; asin: string | null; projectId: string | null }[] = [];
      for (const b of books) {
        const pid = where.get(b.id) ?? null;
        if (!pid || !inside.has(pid)) continue;
        for (const e of b.editions.filter((x) => !x.archivedAt)) out.push({ id: e.id, label: `${b.title}, ${e.format}${e.asin ? ` (${e.asin})` : ''}`, asin: e.asin, projectId: pid });
      }
      return out.sort((a, b) => a.label.localeCompare(b.label));
    } catch {
      return [];
    }
  }

  // ---- the plans of the project in view -------------------------------------------------------------------------------------------

  async state(projectRef?: string): Promise<LaunchState> {
    const as = this.as();
    if (!as) return { available: false, reason: 'Launch for this Studio is managed by its owner.' };
    try {
      const tree = await this.studio.tree();
      const project = this.project(tree, projectRef);
      if (!project) return { available: false, reason: projectRef ? 'That project is not there.' : tree.projects.length ? 'Pick a project to see its launches.' : 'There are no projects yet.' };
      const may = await this.may(project.id);
      if (!may.read) return { available: false, reason: 'Your role does not let you see the launches of this project.' };
      const ids = subtreeIds(tree, project.id);
      const inside = new Set(ids);
      const [plans, templates, editions, names, launchBriefs, campaignBriefs, requests] = await Promise.all([
        as.launch.plans({ projectIds: ids }),
        as.launch.templates().catch(() => []),
        this.editions(as, inside),
        this.names(),
        as.briefs.list({ kind: 'launch' }),
        as.briefs.list({ kind: 'campaign' }),
        as.launch.requests({ projectIds: ids })
      ]);
      const summaries: PlanSummary[] = [];
      for (const p of plans) {
        const v = await as.launch.plan(p.id);
        if (!v) continue;
        const real = v.items.filter((i) => i.item.required);
        summaries.push({
          plan: v.plan,
          projectName: tree.projects.find((x) => x.id === p.projectId)?.name ?? '',
          editionLabel: editions.find((e) => e.id === p.editionId)?.label ?? null,
          counts: v.counts,
          outstanding: v.outstanding.length,
          late: real.filter((i) => i.status === 'late').length,
          blocked: real.filter((i) => i.status === 'blocked').length,
          daysToRelease: v.daysToRelease,
          changedSinceApproval: v.changedSinceApproval
        });
      }
      const briefs: LaunchBriefRow[] = [];
      for (const b of [...launchBriefs, ...campaignBriefs].filter((x) => inside.has(x.projectId))) {
        const comps = await as.marketing.briefComps(b.id, b.current.n).catch(() => []);
        briefs.push({ id: b.id, title: b.title, kind: b.kind as 'launch' | 'campaign', version: b.current.n, projectName: tree.projects.find((x) => x.id === b.projectId)?.name ?? '', comps: comps.length, updatedAt: b.current.writtenAt });
      }
      briefs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const pool = (await this.people.peopleList().catch(() => [])) as { id: string; name: string }[];
      return {
        available: true,
        me: this.people.me,
        project: { id: project.id, name: project.name },
        may,
        plans: summaries,
        templates: templates.map((t) => ({ id: t.id, name: t.name, version: t.version, items: t.items.length })),
        editions,
        people: pool,
        briefs,
        requests: requests.map((r) => ({ ...r, projectName: tree.projects.find((x) => x.id === r.request.projectId)?.name ?? '', assigneeName: r.request.assigneeId ? this.nameOf(names, r.request.assigneeId) : null }))
      };
    } catch (e) {
      if (e instanceof PermissionDenied) return { available: false, reason: 'Your role does not let you see the launches of this project.' };
      throw e;
    }
  }

  /** One plan: every item with its status and why, the date proposals, the ARC rounds, the requests and the review. */
  async plan(id: string): Promise<LaunchPlanView> {
    const as = this.as();
    if (!as) return { available: false, reason: 'Launch for this Studio is managed by its owner.' };
    try {
      const v = await as.launch.plan(String(id));
      if (!v) return { available: false, reason: 'That plan is not there.' };
      const tree = await this.studio.tree();
      const inside = new Set(subtreeIds(tree, v.plan.projectId));
      const [may, names, proposals, campaigns, requests, review, editions] = await Promise.all([
        this.may(v.plan.projectId),
        this.names(),
        as.launch.dates(v.plan.id),
        as.launch.campaigns(v.plan.id),
        as.launch.requests({ planId: v.plan.id, state: 'any' }),
        as.launch.review(v.plan.id),
        this.editions(as, inside)
      ]);
      const edition = editions.find((e) => e.id === v.plan.editionId) ?? null;
      const asin = edition?.asin ?? null;
      const row = (i: PlanViewItem): LaunchItemRow => ({ view: i, assigneeName: i.task.assigneeId ? this.nameOf(names, i.task.assigneeId) : null });
      const figures = asin ? await as.marketing.figures({ asin, limit: 5000 }).catch(() => []) : [];
      return {
        available: true,
        plan: v.plan,
        projectName: tree.projects.find((x) => x.id === v.plan.projectId)?.name ?? '',
        editionLabel: edition?.label ?? null,
        asin,
        may,
        items: v.items.map(row),
        outstanding: v.outstanding.map(row),
        counts: v.counts,
        revision: v.revision,
        changedSinceApproval: v.changedSinceApproval,
        daysToRelease: v.daysToRelease,
        approvedByName: v.plan.approvedBy ? this.nameOf(names, v.plan.approvedBy) : null,
        proposals: proposals.map((p) => ({ ...p, proposerName: this.nameOf(names, p.proposedBy) })),
        campaigns: await Promise.all(campaigns.map(async (k) => ({ ...k, cross: await as.launch.crossCheck(k.id) }))),
        requests: requests.map((r) => ({ ...r, assigneeName: r.request.assigneeId ? this.nameOf(names, r.request.assigneeId) : null })),
        review,
        figures: { count: figures.length, latest: figures[figures.length - 1] ?? null }
      };
    } catch (e) {
      if (e instanceof PermissionDenied) return { available: false, reason: 'Your role does not let you see this plan.' };
      throw e;
    }
  }

  /** Reader names and emails: managers only, and each read is logged by the records. */
  async readers(campaignId: string) {
    const as = this.need();
    try {
      return { readers: await as.launch.readers(String(campaignId)) };
    } catch (e) {
      if (e instanceof PermissionDenied) return { available: false as const, reason: 'Reader details are for the people who manage launches.' };
      throw e;
    }
  }

  async brief(id: string): Promise<LaunchBriefView> {
    const as = this.as();
    if (!as) return { available: false, reason: 'Launch for this Studio is managed by its owner.' };
    try {
      const b = await as.briefs.get(String(id));
      if (!b || (b.kind !== 'launch' && b.kind !== 'campaign')) return { available: false, reason: 'That brief is not there.' };
      const [versions, comps, names, may] = await Promise.all([as.briefs.versions(b.id), as.marketing.briefComps(b.id, b.current.n).catch(() => []), this.names(), this.may(b.projectId)]);
      const newer: string[] = [];
      for (const c of comps) {
        const l = await as.marketing.latest(c.asin).catch(() => null);
        if (l && c.figure && l.capturedAt > c.figure.capturedAt) newer.push(c.asin);
      }
      return {
        available: true,
        brief: { id: b.id, title: b.title, kind: b.kind as 'launch' | 'campaign', projectId: b.projectId, version: b.current.n, body: b.current.body, note: b.current.note, writtenAt: b.current.writtenAt, writtenByName: this.nameOf(names, b.current.writtenBy) },
        versions: [...versions].sort((x, y) => y.n - x.n).map((v) => ({ n: v.n, body: v.body, note: v.note, writtenAt: v.writtenAt, writtenByName: this.nameOf(names, v.writtenBy) })),
        comps,
        may,
        newer
      };
    } catch (e) {
      if (e instanceof PermissionDenied) return { available: false, reason: 'Your role does not let you see this brief.' };
      throw e;
    }
  }

  // ---- Market in the Studio ----------------------------------------------------------------------------------------------------------

  async market(projectRef?: string): Promise<LaunchMarketView> {
    const as = this.as();
    if (!as) return { available: false, reason: 'Market for this Studio is managed by its owner.' };
    try {
      const tree = await this.studio.tree();
      const project = this.project(tree, projectRef);
      if (!project) return { available: false, reason: projectRef ? 'That project is not there.' : 'Pick a project to see its market figures.' };
      const may = await this.may(project.id);
      const ids = subtreeIds(tree, project.id);
      const editions = await this.editions(as, new Set(ids));
      const names = await this.names();
      const out = [];
      for (const e of editions) {
        const figs = e.asin ? await as.marketing.figures({ asin: e.asin, limit: 5000 }).catch(() => []) : [];
        out.push({ id: e.id, label: e.label, asin: e.asin, figures: figs.length, latest: figs[figs.length - 1] ?? null });
      }
      const decisions = await as.marketing.decisions({ editionIds: editions.map((e) => e.id) });
      return {
        available: true,
        project: { id: project.id, name: project.name },
        may,
        editions: out,
        compSets: await as.marketing.compSets({ projectIds: ids }),
        reports: await as.marketing.reports({ projectIds: ids }),
        decisions: decisions.map((d) => ({ ...d, editionLabel: editions.find((e) => e.id === d.editionId)?.label ?? '', byName: this.nameOf(names, d.decidedBy) }))
      };
    } catch (e) {
      if (e instanceof PermissionDenied) return { available: false, reason: 'Your role does not let you see market research.' };
      throw e;
    }
  }

  async decisionWindow(decisionId: string, days: number) {
    const as = this.as();
    if (!as) return { available: false as const, reason: 'Market for this Studio is managed by its owner.' };
    try {
      return await as.marketing.window(String(decisionId), Number(days) || 30);
    } catch (e) {
      if (e instanceof PermissionDenied) return { available: false as const, reason: 'Your role does not let you see market research.' };
      throw e;
    }
  }

  /** Sends this computer's captured figures for the books in view to the Studio (idempotent: what the Studio has is skipped). */
  async publishFigures(projectRef?: string) {
    const as = this.need();
    if (!this.library) return { available: false as const, reason: 'This computer has no Market library to publish from.' };
    const tree = await this.studio.tree();
    const project = this.project(tree, projectRef);
    if (!project) return { available: false as const, reason: 'Pick a project to publish the figures of.' };
    const editions = (await this.editions(as, new Set(subtreeIds(tree, project.id)))).filter((e) => e.asin);
    // and the comps the briefs and comp sets name: their figures matter as much
    const sets = await as.marketing.compSets({ projectIds: subtreeIds(tree, project.id) }).catch(() => []);
    const asins = [...new Set([...editions.map((e) => e.asin!), ...sets.flatMap((s) => s.asins)])];
    const figures = asins.flatMap((asin) =>
      this.library!.history(asin).map((h) => ({ asin, capturedAt: h.capturedAt.includes('T') ? h.capturedAt : `${h.capturedAt.replace(' ', 'T')}Z`, price: h.kindlePrice, rank: h.overallRank, ratings: h.ratingCount, ratingAvg: h.ratingValue }))
    );
    let added = 0;
    let skipped = 0;
    for (let i = 0; i < figures.length; i += 1000) {
      const r = await as.marketing.publish(figures.slice(i, i + 1000));
      added += r.added;
      skipped += r.skipped;
    }
    return { added, skipped, books: asins.length };
  }

  // ---- changes -------------------------------------------------------------------------------------------------------------------------

  /** One change, by name. A list, so inherited names such as `constructor` are not reachable. */
  async call(name: string, args: unknown[]): Promise<unknown> {
    if (!(LAUNCH_CALLS as readonly string[]).includes(name)) throw new LaunchError('That is not something the Launch page can do.');
    const as = this.need();
    const a = args as never[];
    switch (name as LaunchCallName) {
      case 'createPlan': return as.launch.create(a[0]);
      case 'updatePlan': return as.launch.update(String(a[0]), a[1]);
      case 'assign': return as.launch.assign(String(a[0]), String(a[1]), a[2] ?? null);
      case 'mark': return as.launch.mark(String(a[0]), String(a[1]), !!a[2]);
      case 'approve': return as.launch.approve(String(a[0]), String(a[1]));
      case 'goLive': return as.launch.goLive(String(a[0]));
      case 'cancel': return as.launch.cancel(String(a[0]), a[1]);
      case 'proposeDate': return as.launch.proposeDate(String(a[0]), String(a[1]), a[2]);
      case 'applyDate': return as.launch.applyDate(String(a[0]));
      case 'rejectDate': return as.launch.rejectDate(String(a[0]), a[1]);
      case 'ask': return as.launch.ask(a[0]);
      case 'cancelRequest': return as.launch.cancelRequest(String(a[0]), a[1]);
      case 'createCampaign': return as.launch.createCampaign(a[0]);
      case 'reportReviews': return as.launch.reportReviews(String(a[0]), a[1]);
      case 'closeCampaign': return as.launch.closeCampaign(String(a[0]));
      case 'addReader': return as.launch.addReader(String(a[0]), a[1]);
      case 'setReader': return as.launch.setReader(String(a[0]), a[1], a[2]);
      case 'eraseReader': return as.launch.eraseReader(String(a[0]));
      case 'openReview': return as.launch.openReview(String(a[0]));
      case 'refreshReview': return as.launch.refreshReview(String(a[0]));
      case 'writeReview': return as.launch.writeReview(String(a[0]), a[1]);
      case 'finishReview': return as.launch.finishReview(String(a[0]));
      case 'createBrief': {
        const i = a[0] as { projectId: string; kind: string; title: string; body: string };
        if (i?.kind !== 'launch' && i?.kind !== 'campaign') throw new LaunchError('The Launch page writes marketing and campaign briefs.');
        return as.briefs.create(i as never);
      }
      case 'reviseBrief': return as.briefs.revise(String(a[0]), a[1]);
      case 'pinComps': return as.marketing.pinComps(String(a[0]), Number(a[1]), a[2]);
      case 'createCompSet': return as.marketing.createCompSet(a[0]);
      case 'saveReport': return as.marketing.saveReport(a[0]);
      case 'decide': return as.marketing.decide(a[0]);
      case 'createTemplate': return as.launch.createTemplate(a[0]);
      case 'reviseTemplate': return as.launch.reviseTemplate(String(a[0]), a[1]);
    }
  }

  /** Offers an asset's version against a request. The file is measured here (its header, never the pixels); the records refuse one that does not meet the spec. */
  async deliver(requestId: string, assetId: string, version: number): Promise<unknown> {
    const as = this.need();
    if (!this.files) throw new LaunchError('The files of this Studio are kept by its owner.');
    const asset = await as.assets.get(String(assetId));
    if (!asset) throw new LaunchError('That asset is not there.');
    const bytes = await this.files.bytesOf(asset.fileId, Number(version)).catch(() => null);
    if (!bytes) throw new LaunchError('That version is not on this computer yet. Get the latest from the Files page.');
    const info = imageInfo(bytes);
    if (!info) throw new LaunchError('That file is not a picture the app can measure.');
    return as.launch.deliver(String(requestId), { assetId: asset.id, version: Number(version), info });
  }
}
type PlanViewItem = NonNullable<Awaited<ReturnType<NonNullable<ReturnType<Launch['as']>>['launch']['plan']>>>['items'][number];

/** What the home panel and the Director's view are built from: the live plans this person may read, with what is late or blocked. */
export async function launchLens(studio: StudioService, people: PeopleHost): Promise<{ plans: { id: string; name: string; projectId: string; projectName: string; releaseDate: string; daysToRelease: number; late: number; blocked: number; outstanding: number; state: string }[]; requests: { id: string; title: string; projectName: string; due: string | null; assigneeId: string | null }[]; reviewsDue: { planId: string; name: string; projectName: string }[] }> {
  const svc = people.service;
  if (!svc) return { plans: [], requests: [], reviewsDue: [] };
  const as = svc.as(people.me);
  const tree = await studio.tree();
  const name = (id: string) => tree.projects.find((p) => p.id === id)?.name ?? '';
  const plans = await as.launch.plans().catch(() => []);
  const rows = [];
  const reviewsDue = [];
  for (const p of plans) {
    const v = await as.launch.plan(p.id).catch(() => null);
    if (!v) continue;
    const req = v.items.filter((i) => i.item.required);
    rows.push({ id: p.id, name: p.name, projectId: p.projectId, projectName: name(p.projectId), releaseDate: p.releaseDate, daysToRelease: v.daysToRelease, late: req.filter((i) => i.status === 'late').length, blocked: req.filter((i) => i.status === 'blocked').length, outstanding: v.outstanding.length, state: p.state });
    if (p.state === 'live' && v.daysToRelease <= -30 && !(await as.launch.review(p.id).catch(() => null))) reviewsDue.push({ planId: p.id, name: p.name, projectName: name(p.projectId) });
  }
  const requests = (await as.launch.requests().catch(() => [])).filter((r) => !r.fulfilled && r.request.state !== 'cancelled').map((r) => ({ id: r.request.id, title: r.request.title, projectName: name(r.request.projectId), due: r.request.due, assigneeId: r.request.assigneeId }));
  return { plans: rows, requests, reviewsDue };
}
