/**
 * Canon and continuity as the Canon page sees them (docs/M4-PLAN.md): the series' entries and facts, the proposals waiting on someone, and the
 * continuity checks of a book with each finding set beside the passage it is about and the canon facts it cites. Electron-free; tested in
 * test/canon.test.ts.
 *
 * Who may do what is the service's to say, not this file's: every change goes through it and a refusal comes back as it is. What this adds is
 * what the page needs to arrange itself.
 */
import { ancestorsOf, childrenOf, getProject, pathOf, type CanonChange, type CanonEntry, type CanonFact, type CanonProposal, type ProjectTree } from '@cadrel/kernel';
import { PermissionDenied } from '@cadrel/service';
import {
  CANON_CALLS, CONTINUITY_CALLS, type CanonCallName, type CanonEntryRow, type CanonFactRow, type CanonProposalRow, type CanonState, type ContinuityCallName, type ContinuityCheckRow, type ContinuityCheckView,
  type ContinuityState, type FindingView
} from '../shared/api';
import type { PeopleHost } from './people';
import type { StudioService } from './studio';
import type { EditorialFiles } from './editorial';

export class CanonError extends Error {}

/** Characters shown either side of a finding's passage. */
const CONTEXT = 240;
const DECIDED_SHOWN = 20;

export class Canon {
  constructor(private readonly studio: StudioService, private readonly people: PeopleHost, private readonly files: EditorialFiles | null = null) {}

  private as() {
    const svc = this.people.service;
    return svc ? svc.as(this.people.me) : null;
  }
  private need() {
    const as = this.as();
    if (!as) throw new CanonError('Canon for this Studio is managed by its owner.');
    return as;
  }

  // ---- canon --------------------------------------------------------------------------------------------------------------

  /** The canon of one series (the one given, or the first this person can read), with what waits on them. */
  async state(seriesRef?: string): Promise<CanonState> {
    const as = this.as();
    if (!as) return { available: false, reason: 'Canon for this Studio is managed by its owner.' };
    try {
      return await this.stateOf(as, seriesRef);
    } catch (e) {
      if (e instanceof PermissionDenied) return { available: false, reason: 'Your role does not let you see the series bible.' };
      throw e;
    }
  }

  private async stateOf(as: NonNullable<ReturnType<Canon['as']>>, seriesRef?: string): Promise<CanonState> {
    const tree = await this.studio.tree();
    const roots = tree.projects.filter((p) => !p.parentId && p.status !== 'archived').sort((a, b) => a.name.localeCompare(b.name));
    const readable: { id: string; name: string }[] = [];
    for (const r of roots) {
      try {
        await as.canon.stamp(r.id);
        readable.push({ id: r.id, name: r.name });
      } catch (e) {
        if (!(e instanceof PermissionDenied) && !(e instanceof Error && /^There is no/.test(e.message))) throw e;
      }
    }
    if (!readable.length) return { available: false, reason: roots.length ? 'Your role does not let you see the series bible.' : 'There are no projects yet, so there is no series to keep canon for.' };
    let current = readable[0]!;
    if (seriesRef) {
      const want = await as.canon.seriesOf(seriesRef).catch(() => null);
      current = readable.find((r) => r.id === want?.seriesId) ?? current;
    }
    const [entries, facts, proposals, names, waiting] = await Promise.all([
      as.canon.listEntries({ projectId: current.id }),
      as.canon.listFacts({ projectId: current.id }),
      as.canon.listProposals({ projectId: current.id }),
      this.people.peopleList().catch(() => [] as { id: string; name: string }[]),
      as.canon.waitingForMe().catch(() => [] as CanonProposal[])
    ]);
    const paths = await this.paths();
    const books = childrenOf(tree, current.id).filter((b) => b.status !== 'archived').map((b) => ({ id: b.id, name: b.name }));
    const open = proposals.filter((p) => p.state === 'open');
    const touches = (p: CanonProposal, e: CanonEntry) => 'entryId' in p.payload && p.payload.entryId === e.id;
    const factRows = facts.map((f) => this.factRow(f, tree, paths));
    const rows: CanonEntryRow[] = entries.map((e) => ({ ...e, facts: factRows.filter((f) => f.entryId === e.id), pending: open.filter((p) => touches(p, e)).length }));
    const decided = proposals.filter((p) => p.state !== 'open').slice(-DECIDED_SHOWN).reverse();
    const may = {
      read: true,
      propose: await this.mayPropose(current.id),
      approve: await this.people.mayOn('canon.approve', current.id)
    };
    return {
      available: true,
      me: this.people.me,
      series: readable,
      current,
      may,
      entries: rows,
      proposals: [...open, ...decided].map((p) => this.proposalRow(p, names, entries, facts)),
      books,
      waitingOnMe: waiting.length
    };
  }

  /** Whether this person may propose canon on the series (the service decides; this asks without changing anything). */
  private async mayPropose(seriesId: string): Promise<boolean> {
    return (await this.people.mayOn('canon.propose', seriesId)) || (await this.people.mayOn('canon.approve', seriesId)) || (await this.proposeViaBook(seriesId));
  }
  private async proposeViaBook(seriesId: string): Promise<boolean> {
    const tree = await this.studio.tree();
    for (const b of childrenOf(tree, seriesId)) if ((await this.people.mayOn('canon.propose', b.id)) || (await this.people.mayOn('canon.approve', b.id))) return true;
    return false;
  }
  private async paths(): Promise<Map<string, string>> {
    if (!this.files) return new Map();
    const list = await this.files.manuscripts().catch(() => []);
    return new Map(list.map((f) => [f.fileId, f.path]));
  }
  private where(tree: ProjectTree, f: CanonFact): string | null {
    if (f.bookProjectId && getProject(tree, f.bookProjectId)) return `${pathOf(tree, f.bookProjectId)}${f.chapter ? `, chapter ${f.chapter}` : ''}`;
    return f.chapter ? `chapter ${f.chapter}` : null;
  }
  private factRow(f: CanonFact, tree: ProjectTree, paths: Map<string, string>): CanonFactRow {
    return { ...f, sourcePath: f.source ? paths.get(f.source.fileId) ?? null : null, established: this.where(tree, f) };
  }
  private proposalRow(p: CanonProposal, names: { id: string; name: string }[], entries: CanonEntry[], facts: CanonFact[]): CanonProposalRow {
    return { ...p, proposerName: p.proposedBy === this.people.me ? 'you' : names.find((n) => n.id === p.proposedBy)?.name ?? 'someone', summary: describeChange(p.payload, entries, facts), fromFinding: !!p.findingId };
  }

  /** One change to canon, by name. A refusal (no right to, a stale revision, a duplicate name) comes back as the service's own sentence. */
  async call(name: string, args: unknown[]): Promise<unknown> {
    if (!(CANON_CALLS as readonly string[]).includes(name)) throw new CanonError('That is not something the Canon page does.');
    const as = this.need();
    const call = name as CanonCallName;
    const id = String(args[0] ?? '');
    if (!id) throw new CanonError(call === 'propose' || call === 'apply' ? 'Say which series.' : 'Say which proposal.');
    if (call === 'propose') return as.canon.propose(id, args[1]);
    if (call === 'apply') return as.canon.apply(id, args[1]);
    if (call === 'approve') return as.canon.approve(id);
    if (call === 'reject') return as.canon.reject(id, String(args[1] ?? ''));
    return as.canon.withdraw(id);
  }

  // ---- continuity ---------------------------------------------------------------------------------------------------------

  /** The checks this person can see, and the manuscripts one could be started on. */
  async continuity(): Promise<ContinuityState> {
    const as = this.as();
    if (!as) return { available: false, reason: 'Continuity checks for this Studio are managed by its owner.' };
    try {
      const [tree, checks, names] = await Promise.all([this.studio.tree(), as.continuity.list({}), this.people.peopleList().catch(() => [] as { id: string; name: string }[])]);
      const counts = checks.length ? await as.continuity.counts(checks.map((k) => k.id)) : {};
      const empty = { open: 0, fixed: 0, accepted_as_canon: 0, dismissed: 0 };
      const rows: ContinuityCheckRow[] = checks
        .map((k) => this.checkRow(k, tree, names, counts[k.id] ?? empty))
        .sort((a, b) => Number(a.state === 'closed') - Number(b.state === 'closed') || b.createdAt.localeCompare(a.createdAt));
      const manuscripts = this.files ? await this.files.manuscripts().catch(() => []) : [];
      const books: { id: string; name: string }[] = [];
      for (const p of tree.projects) {
        if (p.status === 'archived' || ancestorsOf(tree, p.id).some((a) => a.status === 'archived')) continue;
        if ((await this.people.mayOn('canon.propose', p.id)) || (await this.people.mayOn('canon.approve', p.id))) books.push({ id: p.id, name: pathOf(tree, p.id) });
      }
      books.sort((a, b) => a.name.localeCompare(b.name));
      return { available: true, me: this.people.me, may: { start: books.length > 0 && manuscripts.length > 0 }, checks: rows, books, manuscripts };
    } catch (e) {
      if (e instanceof PermissionDenied) return { available: false, reason: 'Your role does not let you see continuity checks.' };
      throw e;
    }
  }
  private checkRow(k: ContinuityCheckRow | (Omit<ContinuityCheckRow, 'projectName' | 'runByName' | 'counts'>), tree: ProjectTree, names: { id: string; name: string }[], counts: ContinuityCheckRow['counts']): ContinuityCheckRow {
    return { ...(k as ContinuityCheckRow), projectName: getProject(tree, k.projectId) ? pathOf(tree, k.projectId) : '(removed project)', runByName: k.runBy === this.people.me ? 'you' : names.find((n) => n.id === k.runBy)?.name ?? 'someone', counts };
  }
  private need_files(): EditorialFiles {
    if (!this.files) throw new CanonError('The files of this Studio are kept by its owner.');
    return this.files;
  }

  /** One check with its findings, each beside its passage and the canon facts it cites. */
  async check(id: string): Promise<ContinuityCheckView> {
    const as = this.as();
    if (!as) return { available: false, reason: 'Continuity checks for this Studio are managed by its owner.' };
    const k = await as.continuity.get(String(id));
    if (!k) return { available: false, reason: 'That check is not there, or your role does not let you see it.' };
    const [tree, names, findings, counts] = await Promise.all([this.studio.tree(), this.people.peopleList().catch(() => [] as { id: string; name: string }[]), as.continuity.findings({ checkId: k.id }), as.continuity.counts([k.id])]);
    const facts = findings.length ? await as.canon.listFacts({ projectId: k.seriesId, status: 'any' }) : [];
    const entries = findings.length ? await as.canon.listEntries({ projectId: k.seriesId, state: 'any' }) : [];
    const proposals = findings.some((f) => f.proposalId) ? await as.canon.listProposals({ projectId: k.seriesId }) : [];
    const paths = await this.paths();
    let text: string | null = null;
    if (this.files && findings.length) text = await this.files.textOf(k.fileId, k.fileVersion).catch(() => null);
    const views: FindingView[] = findings.map((f) => {
      const at = f.anchor.start;
      const ok = text !== null && text.slice(at, at + f.anchor.quote.length) === f.anchor.quote;
      const p = f.proposalId ? proposals.find((x) => x.id === f.proposalId) : null;
      return {
        ...f,
        context: text !== null && ok ? { before: text.slice(Math.max(0, at - CONTEXT), at), quote: f.anchor.quote, after: text.slice(at + f.anchor.quote.length, at + f.anchor.quote.length + CONTEXT) } : { before: '', quote: f.anchor.quote, after: '' },
        facts: f.factIds.map((fid) => {
          const fact = facts.find((x) => x.id === fid);
          return fact
            ? { id: fid, entry: entries.find((e) => e.id === fact.entryId)?.name ?? '(retired entry)', text: fact.text, status: fact.status, established: this.where(tree, fact), sourcePath: fact.source ? paths.get(fact.source.fileId) ?? null : null, passage: fact.source?.anchor.quote ?? null }
            : { id: fid, entry: '(not found)', text: '', status: 'retired' as const, established: null, sourcePath: null, passage: null };
        }),
        proposal: p ? this.proposalRow(p, names, entries, facts) : null
      };
    });
    const decide = (await this.people.mayOn('manuscript.write', k.projectId)) || (await this.people.mayOn('canon.approve', k.seriesId));
    const finder = k.runBy === this.people.me || (await this.people.mayOn('canon.approve', k.seriesId));
    let newer: number | null = null;
    if (this.files) {
      const versions = await this.files.versionsOf(k.fileId).catch(() => []);
      const top = Math.max(0, ...versions.map((v) => v.n));
      newer = top > k.fileVersion ? top : null;
    }
    return { available: true, check: this.checkRow(k, tree, names, counts[k.id] ?? { open: 0, fixed: 0, accepted_as_canon: 0, dismissed: 0 }), findings: views, may: { decide, deliver: finder, close: decide }, newerVersion: newer, people: names };
  }

  /** One change to a check, by name. */
  async continuityCall(name: string, args: unknown[]): Promise<unknown> {
    if (!(CONTINUITY_CALLS as readonly string[]).includes(name)) throw new CanonError('That is not something the Continuity page does.');
    const as = this.need();
    const call = name as ContinuityCallName;
    const id = String(args[0] ?? '');
    if (!id) throw new CanonError(call === 'start' ? 'Say which book.' : 'Say which check or finding.');
    if (call === 'start') return as.continuity.start({ projectId: id, fileId: String(args[1] ?? '') });
    if (call === 'deliver') return as.continuity.deliver(id);
    if (call === 'decide') return as.continuity.decide(id, args[1] as never);
    if (call === 'close') return as.continuity.close(id);
    // re-check a later version: the text comes from the vault, the records hold none
    const k = await as.continuity.get(id);
    if (!k) throw new CanonError('That check is not there, or your role does not let you see it.');
    const version = Number(args[1]);
    if (!Number.isInteger(version)) throw new CanonError('Say which version to check against.');
    const text = await this.need_files().textOf(k.fileId, version);
    return as.continuity.verify(id, { version, text });
  }
}

/** A change to canon in a sentence, for the list of proposals. */
export function describeChange(c: CanonChange, entries: CanonEntry[], facts: CanonFact[]): string {
  const entry = (id: string) => entries.find((e) => e.id === id)?.name ?? 'an entry';
  const fact = (id: string) => facts.find((f) => f.id === id);
  const short = (s: string) => (s.length > 90 ? `${s.slice(0, 89)}…` : s);
  switch (c.change) {
    case 'add_entry':
      return `Add the ${c.kind} ${c.name}`;
    case 'edit_entry':
      return `Revise ${entry(c.entryId)}${c.name ? ` (rename to ${c.name})` : ''}`;
    case 'retire_entry':
      return `Retire ${entry(c.entryId)}: ${short(c.reason)}`;
    case 'add_fact':
      return `Add a fact about ${entry(c.entryId)}: ${short(c.text)}`;
    case 'supersede_fact': {
      const old = fact(c.factId);
      return `Replace “${short(old?.text ?? 'a fact')}” with “${short(c.text)}”${old ? ` (${entry(old.entryId)})` : ''}`;
    }
    case 'retire_fact': {
      const old = fact(c.factId);
      return `Retire “${short(old?.text ?? 'a fact')}”: ${short(c.reason)}`;
    }
  }
}

// kept for the page's top-level reach: the series a project belongs to
export const seriesRootOf = (tree: ProjectTree, id: string): string => ancestorsOf(tree, id)[0]?.id ?? id;
