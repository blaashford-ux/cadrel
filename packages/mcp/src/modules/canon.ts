import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WorkError, ProjectError, ancestorsOf, childrenOf, getProject, makeAnchor, pathOf, subtreeIds, type CanonChange, type CanonFact, type NewFinding, type ProjectTree, type VaultStore } from '@cadrel/kernel';
import { PermissionDenied, type StudioService } from '@cadrel/service';
import type { BlobStore } from '@cadrel/store';
import type { Studio } from '@cadrel/studio';
import { agentFromClient } from '@cadrel/write/mcp/server';
import { seedFromLedgers } from '@cadrel/write/src/shared/agent/canonSeed';
import type { BookLedgers } from '@cadrel/write/src/shared/agent/trackers';
import type { McpModule } from '../server.js';
import { STUDIO_HINT } from '@cadrel/write/src/shared/agent/tools';
import { findQuote } from './editorial.js';

export const CANON_INSTRUCTIONS =
  'These tools are for a series\' canon (the facts the studio has agreed about its characters, places, rules, events and terms) and for continuity checks of a book against it. ' +
  'To check a book: continuity_start (a manuscript in the vault), then read the canon that applies with canon_for_chapter for each chapter in turn, read the pinned text with continuity_read, and raise a finding with continuity_raise only when the text contradicts a canon fact. ' +
  'Every finding must quote the exact passage and cite the ids of the canon facts it conflicts with, and say how serious it is and how sure you are; one without a passage or a fact is refused. Do not report a style or taste problem as a continuity finding. If you are unsure, say low confidence; if the manuscript and the canon could both be right, do not raise it. ' +
  'When you are done, continuity_deliver hands the check to the people who decide. You cannot approve or reject canon, and you cannot dismiss, accept or close a finding: those are the author\'s and the series lead\'s. canon_propose and canon_seed only make proposals, which a person approves in Cadrel. Tell them what is waiting. Never invent a fact, a passage or an id: look them up first.';

export interface CanonToolOptions {
  service: StudioService;
  personId: string;
  studio: Studio;
  /** The vault's files and versions, to find a manuscript and the exact version a check covers. */
  vault: Pick<VaultStore, 'list' | 'versions'>;
  /** Where the contents of every version are kept. Without it a manuscript cannot be read, so nothing can be quoted. */
  blobs?: BlobStore;
  /** The tracker ledgers of a series (by the name of its manuscript folder), for canon_seed. Absent: canon_seed says it cannot reach them. */
  ledgers?: (seriesName: string) => Promise<BookLedgers[]>;
}

const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const failure = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });
async function guarded<T>(job: () => Promise<T>) {
  try {
    return reply(await job());
  } catch (e) {
    if (e instanceof PermissionDenied || e instanceof WorkError || e instanceof ProjectError) return failure(e.message);
    if (e instanceof Error && /^(There is|That |This computer|The text|Quote|A suggestion|Item \d+:|Finding \d+:|Canon needs|The Studio)/.test(e.message)) return failure(e.message);
    throw e;
  }
}

export function canonModule(o: CanonToolOptions): McpModule {
  return { id: 'canon', title: 'Canon and continuity checks', instructions: CANON_INSTRUCTIONS, register: (server) => registerCanonTools(server, o) };
}

const TEXT_MAX = 20000;

export function registerCanonTools(server: McpServer, o: CanonToolOptions): void {
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
  const nameOf = (list: { id: string; name: string }[], id: string) => (id === o.personId ? 'me' : list.find((p) => p.id === id)?.name ?? id);
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
  /** A series, from the series or from any book in it: its id and name. */
  const series = async (ref: string) => {
    const { tree } = await o.studio.read();
    const id = resolveProject(tree, ref);
    return { tree, ...(await as().canon.seriesOf(id)), projectId: id };
  };
  const filePaths = async () => new Map((await o.vault.list()).map((f) => [f.id, f.path] as const));
  const textOf = async (fileId: string, version: number): Promise<string> => {
    if (!(await as().canOn('manuscript.read'))) throw new PermissionDenied('manuscript.read', 'your role cannot read manuscripts');
    if (!o.blobs) throw new Error('This computer did not say where the vault keeps its files, so the text of a manuscript cannot be read here.');
    const v = (await o.vault.versions(fileId)).find((x) => x.n === version);
    if (!v) throw new Error('That version of the file is not there.');
    const bytes = await o.blobs.get(v.hash);
    if (!bytes) throw new Error('The text of that version is not on this computer. Open it from Files in Cadrel (Get latest) first.');
    return new TextDecoder().decode(bytes);
  };
  /** A manuscript in the vault, by its path (case-insensitive) or id. */
  const fileByPath = async (ref: string) => {
    const files = await o.vault.list();
    const want = ref.trim().toLowerCase().replace(/\\/g, '/');
    const hits = files.filter((f) => f.id === ref || f.path.toLowerCase() === want || f.path.toLowerCase().endsWith(`/${want}`));
    if (hits.length !== 1) throw new Error(hits.length ? `More than one file matches "${ref}". Give its full path.` : `There is no file "${ref}" in the vault. Use files_list to see the paths.`);
    return hits[0]!;
  };
  const factOut = (f: CanonFact, entries: Map<string, { name: string; kind: string }>, paths: Map<string, string>, tree: ProjectTree) => ({
    id: f.id,
    entry: entries.get(f.entryId)?.name ?? '(retired entry)',
    kind: entries.get(f.entryId)?.kind,
    text: f.text,
    status: f.status === 'retired' ? 'retired' : undefined,
    established: f.bookProjectId && getProject(tree, f.bookProjectId) ? `${pathOf(tree, f.bookProjectId)}${f.chapter ? `, chapter ${f.chapter}` : ''}` : f.chapter ? `chapter ${f.chapter}` : undefined,
    source: f.source ? { file: paths.get(f.source.fileId) ?? '(file removed)', version: f.source.version, passage: f.source.anchor.quote } : undefined
  });

  // ---- reading canon --------------------------------------------------------------------------------------------------------

  server.registerTool(
    'canon_entries',
    {
      description: 'The series\' canon entries (characters, places, rules, events, terms) with their aliases and summaries. `series` is the series or any book in it. `search` matches part of a name or alias.',
      inputSchema: { series: z.string().describe('The series, or a book in it: its id, or its name or path such as "Dragon Rider / Book 1".'), kind: z.enum(['character', 'place', 'rule', 'event', 'term']).optional(), search: z.string().optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const s = await series(a.series);
        const entries = await as().canon.listEntries({ projectId: s.seriesId, kind: a.kind, search: a.search });
        return { series: s.name, entries: entries.map((e) => ({ id: e.id, kind: e.kind, name: e.name, aliases: e.aliases.length ? e.aliases : undefined, summary: e.summary })) };
      })
  );

  server.registerTool(
    'canon_facts',
    {
      description: 'The series\' canon facts, each with its id (cite these in findings), the entry it is about, where in the series it was established, and the passage that established it. `entry` limits it to one entry (its id or name). Retired facts are left out unless `include_retired`.',
      inputSchema: { series: z.string(), entry: z.string().optional(), include_retired: z.boolean().optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const s = await series(a.series);
        const entries = await as().canon.listEntries({ projectId: s.seriesId, state: 'any' });
        const wanted = a.entry ? entries.find((e) => e.id === a.entry || e.name.toLowerCase() === a.entry!.toLowerCase()) : undefined;
        if (a.entry && !wanted) throw new Error(`There is no entry "${a.entry}". Use canon_entries to list them.`);
        const facts = await as().canon.listFacts({ projectId: s.seriesId, entryId: wanted?.id, status: a.include_retired ? 'any' : 'canon' });
        const map = new Map(entries.map((e) => [e.id, { name: e.name, kind: e.kind }]));
        const paths = await filePaths();
        return { series: s.name, facts: facts.map((f) => factOut(f, map, paths, s.tree)) };
      })
  );

  server.registerTool(
    'canon_search',
    {
      description: 'Looks for a word or phrase in the series\' canon: entry names, aliases and summaries, and the text of facts. For the manuscripts themselves use the text search tool. Returns entries and facts that match.',
      inputSchema: { series: z.string(), query: z.string().min(2) },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const s = await series(a.series);
        const q = a.query.trim().toLowerCase();
        const entries = await as().canon.listEntries({ projectId: s.seriesId });
        const facts = await as().canon.listFacts({ projectId: s.seriesId });
        const byName = entries.filter((e) => e.name.toLowerCase().includes(q) || e.aliases.some((x) => x.toLowerCase().includes(q)) || e.summary.toLowerCase().includes(q));
        const map = new Map(entries.map((e) => [e.id, { name: e.name, kind: e.kind }]));
        const paths = await filePaths();
        return {
          entries: byName.map((e) => ({ id: e.id, kind: e.kind, name: e.name, aliases: e.aliases.length ? e.aliases : undefined, summary: e.summary })),
          facts: facts.filter((f) => f.text.toLowerCase().includes(q) || byName.some((e) => e.id === f.entryId)).slice(0, 100).map((f) => factOut(f, map, paths, s.tree))
        };
      })
  );

  server.registerTool(
    'canon_for_chapter',
    {
      description: 'The canon that applies at a point in the series: every fact established in the books before this one, and in this book up to and including `chapter`, plus facts with no place given. Use it to read a book against what the series had already established when each chapter was written. `book` is a book of the series.',
      inputSchema: { book: z.string(), chapter: z.number().int().min(1).optional().describe('Leave out for the whole book (every fact up to the end of it).') },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const s = await series(a.book);
        const books = childrenOf(s.tree, s.seriesId).map((b) => b.id);
        const here = books.indexOf(s.projectId);
        const entries = await as().canon.listEntries({ projectId: s.seriesId });
        const map = new Map(entries.map((e) => [e.id, { name: e.name, kind: e.kind }]));
        const facts = (await as().canon.listFacts({ projectId: s.seriesId })).filter((f) => {
          if (!f.bookProjectId) return true;
          const at = books.indexOf(f.bookProjectId);
          if (at < 0 || here < 0) return true; // placed in something that is not one of the series' books, or the question is about the series itself: do not leave it out
          return at < here || (at === here && (a.chapter === undefined || f.chapter === null || f.chapter <= a.chapter));
        });
        const paths = await filePaths();
        return { series: s.name, asOf: a.chapter ? `${pathOf(s.tree, s.projectId)}, chapter ${a.chapter}` : pathOf(s.tree, s.projectId), entries: entries.map((e) => ({ id: e.id, kind: e.kind, name: e.name, aliases: e.aliases.length ? e.aliases : undefined, summary: e.summary })), facts: facts.map((f) => factOut(f, map, paths, s.tree)) };
      })
  );

  server.registerTool(
    'canon_proposals',
    {
      description: 'Proposed changes to the series\' canon, newest last: what is waiting for a person to approve, and what was decided and why.',
      inputSchema: { series: z.string(), state: z.enum(['open', 'approved', 'rejected', 'withdrawn', 'any']).optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const s = await series(a.series);
        const names = await people();
        return (await as().canon.listProposals({ projectId: s.seriesId, state: a.state ?? 'open' })).map((p) => ({ id: p.id, change: p.change, state: p.state, by: nameOf(names, p.proposedBy), reason: p.reason ?? undefined, details: p.payload }));
      })
  );

  // ---- proposing --------------------------------------------------------------------------------------------------------------

  server.registerTool(
    'canon_propose',
    {
      description:
        'Proposes one change to the series\' canon. Nothing changes until a person with the right approves it in Cadrel. `change` is: add_entry (kind, name, summary, optional aliases), edit_entry (entry, based_on = the entry\'s version, and any of name, aliases, summary), retire_entry (entry, reason), add_fact (entry, text, optional source and book/chapter), supersede_fact (fact id, new text), retire_fact (fact id, reason). A fact may name the passage that establishes it: `source_file` (a vault path), `source_version`, and `source_quote` (exact text from that version).',
      inputSchema: {
        series: z.string(),
        change: z.enum(['add_entry', 'edit_entry', 'retire_entry', 'add_fact', 'supersede_fact', 'retire_fact']),
        entry: z.string().optional().describe('An entry\'s id or name.'),
        fact: z.string().optional().describe('A fact id from canon_facts.'),
        kind: z.enum(['character', 'place', 'rule', 'event', 'term']).optional(),
        name: z.string().optional(),
        aliases: z.array(z.string()).optional(),
        summary: z.string().optional(),
        text: z.string().optional(),
        reason: z.string().optional(),
        based_on: z.number().int().optional().describe('For edit_entry: the version of the entry you read.'),
        book: z.string().optional().describe('The book the fact was established in.'),
        chapter: z.number().int().min(1).optional(),
        source_file: z.string().optional(),
        source_version: z.number().int().min(1).optional(),
        source_quote: z.string().optional(),
        source_before: z.string().optional(),
        source_after: z.string().optional()
      },
      annotations: writes
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const s = await series(a.series);
        const entryId = async () => {
          if (!a.entry) throw new Error('Name the entry.');
          const all = await as().canon.listEntries({ projectId: s.seriesId, state: 'any' });
          const e = all.find((x) => x.id === a.entry || x.name.toLowerCase() === a.entry!.toLowerCase());
          if (!e) throw new Error(`There is no entry "${a.entry}". Use canon_entries to list them.`);
          return e;
        };
        let source: { fileId: string; version: number; anchor: ReturnType<typeof makeAnchor> } | null = null;
        if (a.source_quote) {
          if (!a.source_file) throw new Error('A source needs its file (source_file).');
          const f = await fileByPath(a.source_file);
          const version = a.source_version ?? f.currentVersion;
          const text = await textOf(f.id, version);
          const start = findQuote(text, a.source_quote, a.source_before, a.source_after);
          source = { fileId: f.id, version, anchor: makeAnchor(text, start, start + a.source_quote.length) };
        }
        const bookProjectId = a.book ? resolveProject(s.tree, a.book) : undefined;
        if (bookProjectId && !subtreeIds(s.tree, s.seriesId).includes(bookProjectId)) throw new Error('That book is not in this series.');
        let change: CanonChange;
        switch (a.change) {
          case 'add_entry':
            change = { change: 'add_entry', kind: a.kind as never, name: a.name as string, aliases: a.aliases, summary: a.summary as string };
            break;
          case 'edit_entry': {
            const e = await entryId();
            change = { change: 'edit_entry', entryId: e.id, name: a.name, aliases: a.aliases, summary: a.summary, basedOn: a.based_on ?? e.version };
            break;
          }
          case 'retire_entry':
            change = { change: 'retire_entry', entryId: (await entryId()).id, reason: a.reason as string };
            break;
          case 'add_fact':
            change = { change: 'add_fact', entryId: (await entryId()).id, text: a.text as string, source, bookProjectId: bookProjectId ?? null, chapter: a.chapter ?? null };
            break;
          case 'supersede_fact':
            change = { change: 'supersede_fact', factId: a.fact as string, text: a.text as string, source, bookProjectId: bookProjectId ?? null, chapter: a.chapter ?? null };
            break;
          default:
            change = { change: 'retire_fact', factId: a.fact as string, reason: a.reason as string };
        }
        // an optional field the model left out must not be sent as undefined (it would read as "change it to nothing")
        const clean = JSON.parse(JSON.stringify(change)) as CanonChange;
        const p = await as().canon.propose(s.seriesId, clean);
        await viaAssistant('canon_propose', p.id);
        return { proposed: p.id, change: p.change, note: 'It is waiting for a person with the right to approve canon. Tell them.' };
      })
  );

  server.registerTool(
    'canon_seed',
    {
      description:
        'Proposes canon from the series\' tracker ledgers (the LitRPG and timeline ledgers): each character, place and event the ledgers name becomes an entry, and each logged event a fact in its book and chapter. By default it only shows what it would propose (`apply` false). With `apply` it makes the proposals: entries first, and facts for entries that already exist, so run it again once the series lead has approved the entries. Nothing becomes canon until a person approves.',
      inputSchema: { series: z.string(), apply: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional().describe('Most proposals to make in one call (50 by default).') },
      annotations: writes
    },
    (a) =>
      guarded(async () => {
        await allowed();
        if (!o.ledgers) throw new Error('This connection cannot reach the tracker ledgers.');
        const s = await series(a.series);
        const root = getProject(s.tree, s.seriesId)!;
        const books = await o.ledgers(root.name);
        if (!books.length) return { series: s.name, note: 'There are no tracker ledgers in this series\' manuscript folder, so there is nothing to propose from.' };
        const seed = seedFromLedgers(books);
        const entries = await as().canon.listEntries({ projectId: s.seriesId });
        const facts = await as().canon.listFacts({ projectId: s.seriesId });
        const open = await as().canon.listProposals({ projectId: s.seriesId, state: 'open' });
        const have = (kind: string, name: string) => entries.find((e) => e.kind === kind && e.name.toLowerCase() === name.toLowerCase());
        const bookIds = new Set(subtreeIds(s.tree, s.seriesId));
        type Plan = { change: CanonChange; label: string };
        const plan: Plan[] = [];
        for (const e of seed.entries) {
          const entry = have(e.kind, e.name);
          if (!entry) {
            if (!open.some((p) => p.payload.change === 'add_entry' && p.payload.kind === e.kind && p.payload.name.toLowerCase() === e.name.toLowerCase())) plan.push({ change: { change: 'add_entry', kind: e.kind, name: e.name, summary: e.summary }, label: `${e.kind}: ${e.name}` });
            continue;
          }
          for (const f of e.facts) {
            const dupe = facts.some((x) => x.entryId === entry.id && x.text === f.text) || open.some((p) => p.payload.change === 'add_fact' && p.payload.entryId === entry.id && p.payload.text === f.text);
            if (!dupe) plan.push({ change: { change: 'add_fact', entryId: entry.id, text: f.text, bookProjectId: bookIds.has(f.book) ? f.book : null, chapter: f.chapter }, label: `fact for ${entry.name}: ${f.text}` });
          }
        }
        const limit = a.limit ?? 50;
        if (!a.apply) return { series: s.name, wouldPropose: plan.length, showing: plan.slice(0, 30).map((p) => p.label), truncatedLedger: seed.truncated || undefined, note: 'Nothing was proposed. Run again with apply to make these proposals.' };
        let made = 0;
        const refused: string[] = [];
        for (const p of plan.slice(0, limit)) {
          try {
            await as().canon.propose(s.seriesId, p.change);
            made++;
          } catch (e) {
            if (e instanceof WorkError) refused.push(`${p.label}: ${e.message}`);
            else throw e;
          }
        }
        await viaAssistant('canon_seed', s.seriesId);
        return { series: s.name, proposed: made, stillToPropose: Math.max(0, plan.length - limit), refused: refused.length ? refused.slice(0, 10) : undefined, note: 'They are waiting for the series lead to approve. Facts for new entries can be proposed once the entries are approved: run canon_seed again then.' };
      })
  );

  // ---- continuity checks ----------------------------------------------------------------------------------------------------

  const check = async (id: string) => {
    const k = await as().continuity.get(id);
    if (!k) throw new Error('That check is not there, or your role cannot see it. Use continuity_checks to list them.');
    return k;
  };

  server.registerTool(
    'continuity_checks',
    {
      description: 'Continuity checks, oldest first: each with its book, the manuscript file and exact version it covers, the canon it was run against, its state, and how many findings are open, fixed, accepted as canon or dismissed.',
      inputSchema: { book: z.string().optional(), state: z.enum(['live', 'any', 'open', 'delivered', 'closed']).optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const { tree } = await o.studio.read();
        const ids = a.book ? subtreeIds(tree, resolveProject(tree, a.book)) : undefined;
        const checks = await as().continuity.list({ projectIds: ids, state: a.state ?? 'live' });
        const counts = checks.length ? await as().continuity.counts(checks.map((k) => k.id)) : {};
        return checks.map((k) => ({ id: k.id, book: pathOf(tree, k.projectId), file: k.filePath, version: k.fileVersion, canonAsOf: k.canonStamp || undefined, state: k.state, findings: counts[k.id] ?? { open: 0, fixed: 0, accepted_as_canon: 0, dismissed: 0 } }));
      })
  );

  server.registerTool(
    'continuity_start',
    {
      description: 'Starts a continuity check of a book\'s manuscript, at its newest version, against the series\' canon as it stands now. `file` is the manuscript\'s path in the vault (files_list shows them). Only one check of a manuscript is live at a time.',
      inputSchema: { book: z.string(), file: z.string() },
      annotations: writes
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const { tree } = await o.studio.read();
        const book = resolveProject(tree, a.book);
        const f = await fileByPath(a.file);
        const k = await as().continuity.start({ projectId: book, fileId: f.id });
        await viaAssistant('continuity_start', k.id);
        return { check: k.id, book: pathOf(tree, book), file: f.path, version: k.fileVersion, canonAsOf: k.canonStamp || undefined, next: 'Read the canon with canon_for_chapter, the text with continuity_read, then continuity_raise.' };
      })
  );

  server.registerTool(
    'continuity_read',
    {
      description: `The text of the exact version a check covers, in pieces: \`from\` is a character offset (0 to start) and \`length\` how many characters (8000 by default, ${TEXT_MAX} at most). Quote from this text, not from another copy.`,
      inputSchema: { check: z.string(), from: z.number().int().min(0).optional(), length: z.number().int().min(1).max(TEXT_MAX).optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const k = await check(a.check);
        const text = await textOf(k.fileId, k.fileVersion);
        const from = Math.min(a.from ?? 0, text.length);
        const to = Math.min(from + (a.length ?? 8000), text.length);
        return { file: k.filePath, version: k.fileVersion, from, to, total: text.length, more: to < text.length ? `continuity_read with from=${to} for the next piece` : undefined, text: text.slice(from, to) };
      })
  );

  server.registerTool(
    'continuity_findings',
    {
      description: 'The findings of one check, numbered, each with the passage, what the conflict is, the canon facts it cites, how serious and how sure, and what a person decided.',
      inputSchema: { check: z.string(), state: z.enum(['live', 'any', 'open', 'fixed', 'accepted_as_canon', 'dismissed']).optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const k = await check(a.check);
        const findings = await as().continuity.findings({ checkId: k.id, state: a.state ?? 'any' });
        return {
          check: { id: k.id, state: k.state, file: k.filePath, version: k.fileVersion },
          findings: findings.map((f) => ({ id: f.id, n: f.seq, kind: f.kind, severity: f.severity, confidence: f.confidence, state: f.state, passage: f.anchor.quote, text: f.body, facts: f.factIds, decision: f.response ?? undefined, fixedInVersion: f.fixedInVersion ?? undefined }))
        };
      })
  );

  const finding = z.object({
    kind: z.enum(['contradiction', 'timeline', 'name', 'rule', 'thread', 'other']).describe('contradiction: the text says the opposite of a fact; timeline: days or order do not fit; name: a name or alias is used for the wrong thing; rule: a rule of the world is broken; thread: something established is dropped or forgotten.'),
    severity: z.enum(['low', 'medium', 'high']),
    confidence: z.enum(['low', 'medium', 'high']).describe('How sure you are. If the text and the canon could both be right, do not raise it.'),
    quote: z.string().describe('The exact passage from continuity_read.'),
    before: z.string().optional().describe('If the quote occurs more than once: the words right before it.'),
    after: z.string().optional().describe('If the quote occurs more than once: the words right after it.'),
    text: z.string().describe('What the conflict is, in a sentence or two.'),
    facts: z.array(z.string()).min(1).max(10).describe('The ids (from canon_facts or canon_for_chapter) of the canon facts it conflicts with.')
  });
  server.registerTool(
    'continuity_raise',
    {
      description: 'Adds findings to a check you started and that is still open (all or none). Each must quote the exact passage and cite canon fact ids; one without a passage that is in the text, or without a fact that is canon in this series, is refused. A finding a person has already dismissed for this manuscript is skipped. They are numbered after the ones already there.',
      inputSchema: { check: z.string(), findings: z.array(finding).min(1).max(100) },
      annotations: writes
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const k = await check(a.check);
        const text = await textOf(k.fileId, k.fileVersion);
        const items: NewFinding[] = a.findings.map((f, n) => {
          try {
            const start = findQuote(text, f.quote, f.before, f.after);
            return { kind: f.kind, severity: f.severity, confidence: f.confidence, body: f.text, anchor: makeAnchor(text, start, start + f.quote.length), factIds: f.facts };
          } catch (e) {
            throw new Error(`Finding ${n + 1}: ${e instanceof Error ? e.message : String(e)}`);
          }
        });
        const r = await as().continuity.raise(k.id, items);
        await viaAssistant('continuity_raise', k.id);
        return { check: k.id, raised: r.raised.map((x) => ({ id: x.id, n: x.seq, kind: x.kind, passage: x.anchor.quote })), skipped: r.skipped.length ? r.skipped : undefined };
      })
  );

  server.registerTool(
    'continuity_deliver',
    {
      description: 'Hands a check you started to the people who decide: no more findings can be added. Do this when you have read the whole manuscript. You cannot dismiss, accept or close findings: tell the author what is waiting.',
      inputSchema: { check: z.string() },
      annotations: writes
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const k = await as().continuity.deliver((await check(a.check)).id);
        await viaAssistant('continuity_deliver', k.id);
        return { check: k.id, state: k.state, note: 'The author and the series lead can now decide each finding in Cadrel.' };
      })
  );
}
