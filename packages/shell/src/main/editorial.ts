/**
 * Editorial passes as the Editing page sees them: the records (in the Studio's records, through the permission-checked service) joined to the
 * project tree (a file) for names. Electron-free; tested in test/editorial.test.ts.
 *
 * Who may do what is the service's to say, not this file's: every change goes through it and a refusal comes back as it is. What this adds is what
 * the page needs to arrange itself: which passes wait on this person and for what, and the items of one pass with the decision and the check of the
 * revision joined to each.
 */
import { compareTexts, getProject, makeAnchor, type CompareRow, type FileVersion, type NewQuery, type PassRecord } from '@cadrel/kernel';
import { PermissionDenied } from '@cadrel/service';
import type { EditingBriefs, EditingCall, EditingCompare, EditingCompareRow, EditingItem, EditingLaterVersion, EditingPassRow, EditingPassState, EditingPlanning, EditingState, EditingText, NewEditingItem, NewEditingPass } from '../shared/api';
import type { PeopleHost } from './people';
import type { StudioService } from './studio';

export class EditingError extends Error {}

/** The changes the page may ask for, by name. A list, so inherited names such as `constructor` are not reachable. */
export const EDITING_CALLS: readonly EditingCall[] = ['start', 'deliver', 'respond', 'close', 'cancel', 'answer', 'decide', 'resolve', 'withdraw'];
const PASS_CALLS = new Set<EditingCall>(['start', 'deliver', 'respond', 'close', 'cancel']);

/** What the page needs from the vault: the manuscripts there, and the text and versions of one. Given by the vault host (see vaultHost.ts). */
export interface EditorialFiles {
  manuscripts(): Promise<{ fileId: string; path: string; version: number }[]>;
  textOf(fileId: string, version: number): Promise<string>;
  versionsOf(fileId: string): Promise<FileVersion[]>;
}

/** The most text sent to the page for one version. A manuscript is a few hundred thousand characters; past this it is not a manuscript. */
const TEXT_MAX = 8_000_000;

/**
 * Long runs of unchanged paragraphs are one row that says how many, with `keep` paragraphs of context left either side of a change, so a
 * comparison of two drafts of a novel shows what changed and not the whole book.
 */
export function collapseRows(rows: CompareRow[], keep = 1): EditingCompareRow[] {
  const out: EditingCompareRow[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i]!.kind !== 'same') {
      out.push(rows[i++]!);
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j]!.kind === 'same') j++;
    const first = i === 0;
    const last = j === rows.length;
    const head = first ? 0 : keep;
    const tail = last ? 0 : keep;
    if (j - i <= head + tail + 1) out.push(...rows.slice(i, j));
    else {
      out.push(...rows.slice(i, i + head));
      out.push({ kind: 'skip', count: j - i - head - tail });
      out.push(...rows.slice(j - tail, j));
    }
    i = j;
  }
  return out;
}

export class Editorial {
  constructor(private readonly studio: StudioService, private readonly people: PeopleHost, private readonly files: EditorialFiles | null = null) {}

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

  // ---- planning, reading, raising, comparing and checking ----------------------------------------------------------------

  private need(): EditorialFiles {
    if (!this.files) throw new EditingError('The files of this Studio are kept by its owner.');
    return this.files;
  }
  private async passOf(passId: string): Promise<PassRecord> {
    const as = this.as();
    if (!as) throw new EditingError('Editorial passes for this Studio are managed by its owner.');
    const p = await as.passes.get(String(passId));
    if (!p) throw new EditingError('That pass is not there, or your role does not let you see it.');
    return p;
  }

  /** What planning a pass can choose from. Where the person may plan nowhere, or the vault is not here, it says so. */
  async planning(projectId?: string): Promise<EditingPlanning> {
    const as = this.as();
    if (!as) return { available: false, reason: 'Editorial passes for this Studio are managed by its owner.' };
    if (!this.files) return { available: false, reason: 'The files of this Studio are kept by its owner.' };
    try {
      const tree = await this.studio.tree();
      const mine: { id: string; name: string }[] = [];
      for (const p of tree.projects) if (p.status !== 'archived' && (await this.people.mayOn('edit.assign', p.id))) mine.push({ id: p.id, name: p.name });
      if (!mine.length) return { available: false, reason: 'Your role does not let you plan editorial passes.' };
      const files = await this.files.manuscripts();
      const chosen = projectId && mine.some((p) => p.id === projectId) ? projectId : null;
      const [editors, briefs] = chosen
        ? await Promise.all([as.work.assignable(chosen), as.briefs.list({ projectId: chosen, kind: 'edit' })])
        : [[], []];
      return { available: true, projects: mine, files, editors, briefs: briefs.map((b) => ({ id: b.id, title: b.title, version: b.current.n })) };
    } catch (e) {
      if (e instanceof PermissionDenied) return { available: false, reason: 'Your role does not let you plan editorial passes.' };
      throw e;
    }
  }

  /** Plans a pass over a manuscript. The service checks the permission, that the editor is assigned to the project, and that the file and brief are real. */
  async plan(i: NewEditingPass): Promise<{ id: string }> {
    const as = this.as();
    if (!as) throw new EditingError('Editorial passes for this Studio are managed by its owner.');
    if (!i || typeof i !== 'object') throw new EditingError('Say what to plan.');
    const p = await as.passes.create({ projectId: String(i.projectId), kind: i.kind, fileId: String(i.fileId), editorId: String(i.editorId), fileVersion: i.fileVersion, briefId: i.briefId || null, title: i.title });
    return { id: p.id };
  }

  /** The exact text of the version a pass covers. */
  async text(passId: string): Promise<EditingText> {
    const p = await this.passOf(passId);
    const text = await this.need().textOf(p.fileId, p.fileVersion);
    if (text.length > TEXT_MAX) throw new EditingError('That version is too large to show here.');
    return { file: p.filePath, version: p.fileVersion, text };
  }

  /** Raises items in a pass from passages the editor selected: the anchors are made here, from the pinned text, so they are exactly where the selection was. */
  async raise(passId: string, items: NewEditingItem[]): Promise<void> {
    const as = this.as();
    if (!as) throw new EditingError('Editorial passes for this Studio are managed by its owner.');
    if (!Array.isArray(items) || !items.length) throw new EditingError('There is nothing to raise.');
    const p = await this.passOf(passId);
    const text = items.some((i) => i.start !== undefined || i.end !== undefined) ? await this.need().textOf(p.fileId, p.fileVersion) : '';
    const made: NewQuery[] = items.map((i, n) => {
      const at = items.length > 1 ? ` (item ${n + 1})` : '';
      let anchor: NewQuery['anchor'] = null;
      if (i.start !== undefined || i.end !== undefined) {
        if (!Number.isInteger(i.start) || !Number.isInteger(i.end) || i.start! < 0 || i.end! > text.length || i.end! <= i.start!) throw new EditingError(`Select a passage in the text first${at}.`);
        if (!text.slice(i.start, i.end).trim()) throw new EditingError(`The selection is only spaces${at}.`);
        anchor = makeAnchor(text, i.start!, i.end!);
      }
      return { kind: i.kind, body: i.body, anchor, ...(i.kind === 'suggestion' ? { replacement: i.replacement ?? '' } : {}), category: i.category };
    });
    await as.queries.raise(p.id, made);
  }

  /** The versions of the manuscript after the one the pass covers. */
  async laterVersions(passId: string): Promise<EditingLaterVersion[]> {
    const p = await this.passOf(passId);
    return (await this.need().versionsOf(p.fileId)).filter((v) => v.n > p.fileVersion).map((v) => ({ n: v.n, author: v.author, createdAt: v.createdAt, comment: v.comment }));
  }

  /** The version the pass covers and a later one, paragraph by paragraph. */
  async compare(passId: string, version: number): Promise<EditingCompare> {
    const p = await this.passOf(passId);
    const to = Number(version);
    if (!Number.isInteger(to) || to <= p.fileVersion) throw new EditingError(`Pick a version after version ${p.fileVersion}.`);
    const files = this.need();
    const [before, after] = await Promise.all([files.textOf(p.fileId, p.fileVersion), files.textOf(p.fileId, to)]);
    const { rows, stats } = compareTexts(before, after);
    return { from: p.fileVersion, to, rows: collapseRows(rows), stats };
  }

  /** Checks what the author accepted against a later version, with the text of that version, and keeps the result with the pass. */
  async verify(passId: string, version: number): Promise<void> {
    const as = this.as();
    if (!as) throw new EditingError('Editorial passes for this Studio are managed by its owner.');
    const p = await this.passOf(passId);
    const v = Number(version);
    if (!Number.isInteger(v)) throw new EditingError('Pick the version to check.');
    await as.queries.verify(p.id, { revisedVersion: v, revisedText: await this.need().textOf(p.fileId, v) });
  }

  // ---- briefs -------------------------------------------------------------------------------------------------------------

  /** A book's manuscript brief and edit briefs, each with its newest text, for those this person may read. */
  async briefs(projectId: string): Promise<EditingBriefs> {
    const as = this.as();
    if (!as) return { available: false, reason: 'Briefs for this Studio are managed by its owner.' };
    try {
      await this.studio.assertVisible(String(projectId));
      const [briefs, manuscript, edit] = await Promise.all([as.briefs.list({ projectId: String(projectId) }), this.people.mayOn('task.edit', projectId), this.people.mayOn('edit.assign', projectId)]);
      return { available: true, may: { manuscript, edit }, briefs, people: await this.people.peopleList().catch(() => [] as { id: string; name: string }[]) };
    } catch (e) {
      if (e instanceof PermissionDenied) return { available: false, reason: 'Your role does not let you see the briefs of this project.' };
      throw e;
    }
  }

  async briefVersions(briefId: string) {
    const as = this.as();
    if (!as) throw new EditingError('Briefs for this Studio are managed by its owner.');
    return as.briefs.versions(String(briefId));
  }
  async createBrief(i: { projectId: string; kind: 'manuscript' | 'edit'; title: string; body: string }) {
    const as = this.as();
    if (!as) throw new EditingError('Briefs for this Studio are managed by its owner.');
    return as.briefs.create({ projectId: String(i?.projectId), kind: i?.kind, title: i?.title, body: i?.body });
  }
  async reviseBrief(briefId: string, i: { body: string; note?: string; title?: string; basedOn: number }) {
    const as = this.as();
    if (!as) throw new EditingError('Briefs for this Studio are managed by its owner.');
    return as.briefs.revise(String(briefId), i);
  }
}
