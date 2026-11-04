/**
 * Editorial passes as the Editing page sees them: the records (in the Studio's records, through the permission-checked service) joined to the
 * project tree (a file) for names. Electron-free; tested in test/editorial.test.ts.
 *
 * Who may do what is the service's to say, not this file's: every change goes through it and a refusal comes back as it is. What this adds is what
 * the page needs to arrange itself: which passes wait on this person and for what, and the items of one pass with the decision and the check of the
 * revision joined to each.
 */
import { getProject, type PassRecord } from '@cadrel/kernel';
import { PermissionDenied } from '@cadrel/service';
import type { EditingCall, EditingItem, EditingPassRow, EditingPassState, EditingState } from '../shared/api';
import type { PeopleHost } from './people';
import type { StudioService } from './studio';

export class EditingError extends Error {}

/** The changes the page may ask for, by name. A list, so inherited names such as `constructor` are not reachable. */
export const EDITING_CALLS: readonly EditingCall[] = ['start', 'deliver', 'respond', 'close', 'cancel', 'answer', 'decide', 'resolve', 'withdraw'];
const PASS_CALLS = new Set<EditingCall>(['start', 'deliver', 'respond', 'close', 'cancel']);

export class Editorial {
  constructor(private readonly studio: StudioService, private readonly people: PeopleHost) {}

  private as() {
    const svc = this.people.service;
    return svc ? svc.as(this.people.me) : null;
  }

  private async may(projectId?: string) {
    const [run, assign, respond, approve] = await Promise.all(['edit.run', 'edit.assign', 'edit.respond', 'edit.approve'].map((c) => this.people.mayOn(c, projectId)));
    return { run: !!run, assign: !!assign, respond: !!respond, approve: !!approve };
  }

  /** Every pass this person can see that is not called off, with what waits on them. */
  async state(): Promise<EditingState> {
    try {
      return await this.stateOf();
    } catch (e) {
      if (e instanceof PermissionDenied) return { available: false, reason: 'Your role does not let you see editorial passes.' };
      throw e;
    }
  }

  private async stateOf(): Promise<EditingState> {
    const as = this.as();
    if (!as) return { available: false, reason: 'Editorial passes for this Studio are managed by its owner.' };
    const [tree, people, passes] = await Promise.all([this.studio.tree(), this.people.peopleList().catch(() => [] as { id: string; name: string }[]), as.passes.list({ state: 'any' })]);
    const live = passes.filter((p) => p.state !== 'cancelled');
    const ids = live.map((p) => p.id);
    const [counts, items, decisions, may] = await Promise.all([
      ids.length ? as.queries.counts(ids) : Promise.resolve({}),
      ids.length ? as.queries.list({ passIds: ids, state: 'live' }) : Promise.resolve([]),
      ids.length ? as.queries.decisions({ passIds: ids }) : Promise.resolve([]),
      this.may()
    ]);
    const decided = new Set(decisions.map((d) => d.queryId));
    const rows = live.map((p) => {
      const mine = items.filter((i) => i.passId === p.id);
      return this.row(p, tree, people, (counts as Record<string, EditingPassRow['counts']>)[p.id], mine.filter((i) => i.kind === 'query' && i.state === 'open').length, mine.filter((i) => i.kind === 'suggestion' && !decided.has(i.id)).length, may);
    });
    // what waits on this person first, then what is under way, then what is done; each oldest first
    const rank = (r: EditingPassRow) => (r.next ? 0 : r.state === 'closed' ? 2 : 1);
    rows.sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt));
    const off = this.people.editorialOffline;
    const st = off ? await off.status() : null;
    return {
      available: true,
      me: this.people.me,
      may,
      passes: rows,
      offline: st ? { away: st.offline, pending: st.pending, refused: st.refused.map((r) => ({ id: r.id, call: r.call, queryId: r.queryId, error: r.error, response: r.response, queuedAt: r.queuedAt })) } : null
    };
  }

  private row(p: PassRecord, tree: Awaited<ReturnType<StudioService['tree']>>, people: { id: string; name: string }[], counts: EditingPassRow['counts'] | undefined, unanswered: number, undecided: number, may: { run: boolean; assign: boolean; respond: boolean; approve: boolean }): EditingPassRow {
    const c = counts ?? { open: 0, answered: 0, resolved: 0, withdrawn: 0 };
    const mine = p.editorId === this.people.me;
    let next: EditingPassRow['next'] = null;
    if (p.state === 'planned' && may.run && (mine || may.assign)) next = 'start';
    else if (p.state === 'in_progress' && may.run && (mine || may.assign)) next = 'deliver';
    else if (p.state === 'delivered' && may.respond) next = unanswered > 0 || undecided > 0 ? 'answer' : 'respond';
    else if (p.state === 'responded' && may.approve) next = 'close';
    return {
      ...p,
      projectName: getProject(tree, p.projectId)?.name ?? '(removed project)',
      editorName: people.find((x) => x.id === p.editorId)?.name ?? p.editorId,
      counts: c,
      unanswered,
      undecided,
      next
    };
  }

  /** One pass with its items, each with the author's decision and what the check of the revision found. */
  async pass(passId: string): Promise<EditingPassState> {
    try {
      const as = this.as();
      if (!as) return { available: false, reason: 'Editorial passes for this Studio are managed by its owner.' };
      const found = await as.passes.get(String(passId));
      if (!found) return { available: false, reason: 'That pass is not there, or your role does not let you see it.' };
      const [tree, people, items, decisions, verified, may] = await Promise.all([
        this.studio.tree(),
        this.people.peopleList().catch(() => [] as { id: string; name: string }[]),
        as.queries.list({ passId: found.id }),
        as.queries.decisions({ passId: found.id }),
        as.queries.verification(found.id),
        this.may(found.projectId)
      ]);
      const decided = new Set(decisions.map((d) => d.queryId));
      const unanswered = items.filter((i) => i.kind === 'query' && i.state === 'open').length;
      const undecided = items.filter((i) => i.kind === 'suggestion' && i.state === 'open' && !decided.has(i.id)).length;
      const counts = items.reduce((c, i) => ((c[i.state] += 1), c), { open: 0, answered: 0, resolved: 0, withdrawn: 0 });
      const view: EditingItem[] = items.map((i) => ({ ...i, decision: decisions.find((d) => d.queryId === i.id) ?? null, verified: verified.find((v) => v.queryId === i.id) ?? null }));
      return { available: true, pass: this.row(found, tree, people, counts, unanswered, undecided, may), items: view, may, me: this.people.me, people };
    } catch (e) {
      if (e instanceof PermissionDenied) return { available: false, reason: 'Your role does not let you see editorial passes.' };
      throw e;
    }
  }

  /** A change from the page. The service checks the permission and the rules; its refusal is what the page shows. */
  async call(name: string, args: unknown[]): Promise<void> {
    if (!(EDITING_CALLS as readonly string[]).includes(name)) throw new EditingError('That is not something the Editing page does.');
    const as = this.as();
    if (!as) throw new EditingError('Editorial passes for this Studio are managed by its owner.');
    const call = name as EditingCall;
    const id = String(args[0] ?? '');
    if (!id) throw new EditingError('Say which pass or item.');
    if (PASS_CALLS.has(call)) {
      await (as.passes as unknown as Record<string, (id: string) => Promise<unknown>>)[call]!(id);
      return;
    }
    if (call === 'answer') await as.queries.answer(id, String(args[1] ?? ''));
    else if (call === 'decide') await as.queries.decide(id, args[1] as never);
    else if (call === 'resolve') await as.queries.resolve(id);
    else await as.queries.withdraw(id);
  }

  /** Sends the answers that are waiting for the Studio's server; what it turns down stays on the page until dismissed. */
  async sendWaiting(): Promise<void> {
    await this.people.editorialOffline?.flush();
  }
  async dismissRefused(id: string): Promise<void> {
    await this.people.editorialOffline?.dismiss(String(id));
  }
}
