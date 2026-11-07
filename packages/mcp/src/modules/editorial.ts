import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WorkError, ProjectError, ancestorsOf, getProject, makeAnchor, pathOf, subtreeIds, type Db, type NewQuery, type PassRecord, type ProjectTree } from '@cadrel/kernel';
import { PermissionDenied, type StudioService } from '@cadrel/service';
import { DirBlobs } from '@cadrel/store';
import type { Studio } from '@cadrel/studio';
import { agentFromClient } from '@cadrel/write/mcp/server';
import type { McpModule } from '../server.js';
import { STUDIO_HINT } from '@cadrel/write/src/shared/agent/tools';

export const EDITORIAL_INSTRUCTIONS =
  'These tools are for editorial passes: an editor\'s developmental, line, copy or proof read of one exact version of a manuscript file. ' +
  'edit_passes lists the passes (use `mine` for the ones you are the editor of); edit_items shows a pass\'s queries, comments and suggestions with the author\'s answers and decisions. ' +
  'To raise your own: edit_read gives the text of the version the pass covers (quote from it, not from another copy), then edit_raise adds items to a pass that is in progress and that you are the editor of. ' +
  'A query asks the author something and needs an answer; a comment needs none; a suggestion carries the replacement text for the quoted passage. Quote exactly; if a quote occurs more than once, give `before` or `after`. ' +
  'You cannot start, deliver, answer, decide on, resolve or close anything: answering and deciding are the author\'s own words and choices, and moving a pass along is for the person to do in Cadrel. Tell them what is waiting. Never invent a pass or an item: look them up first.';

export interface EditorialToolOptions {
  service: StudioService;
  /** The person the assistant acts for. */
  personId: string;
  studio: Studio;
  /** The records file, to read the pinned version's hash and to note in its audit log that a change was made through the assistant. */
  db: Db;
  /** Where the vault keeps the contents of every version. Without it the text of a manuscript cannot be read, so nothing can be quoted. */
  blobsDir?: string;
}

const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const failure = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });
async function guarded<T>(job: () => Promise<T>) {
  try {
    return reply(await job());
  } catch (e) {
    if (e instanceof PermissionDenied || e instanceof WorkError || e instanceof ProjectError) return failure(e.message);
    if (e instanceof Error && /^(There is|That |This computer|The text|Quote|A suggestion|Item \d+:)/.test(e.message)) return failure(e.message);
    throw e;
  }
}

export function editorialModule(o: EditorialToolOptions): McpModule {
  return { id: 'editorial', title: 'Editorial passes (queries, comments and suggestions)', instructions: EDITORIAL_INSTRUCTIONS, register: (server) => registerEditorialTools(server, o) };
}

/** Where `quote` is in `text`: the one place, or the one that follows `before` / precedes `after`. */
export function findQuote(text: string, quote: string, before?: string, after?: string): number {
  if (!quote.trim()) throw new Error('Quote must not be empty.');
  const at: number[] = [];
  for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) at.push(i);
  if (!at.length) throw new Error(`Quote not found in the text of this version: “${quote.slice(0, 60)}”. Quote it exactly as edit_read shows it.`);
  const fits = at.filter((i) => (!before || text.slice(0, i).endsWith(before)) && (!after || text.slice(i + quote.length).startsWith(after)));
  if (fits.length === 1) return fits[0]!;
  if (fits.length === 0) throw new Error(`Quote found ${at.length} time${at.length === 1 ? '' : 's'}, but not with the text before/after that you gave: “${quote.slice(0, 60)}”.`);
  throw new Error(`Quote occurs ${fits.length} times: “${quote.slice(0, 60)}”. Give \`before\` or \`after\` (the words right around it) to say which.`);
}

export function registerEditorialTools(server: McpServer, o: EditorialToolOptions): void {
  const as = () => o.service.as(o.personId);
  const agent = () => agentFromClient(server.server.getClientVersion()?.name).agentName;
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;
  const allowed = async () => {
    if (!(await as().canOn('assistant.use'))) throw new PermissionDenied('assistant.use', 'your role does not include using the assistant');
  };
  const viaAssistant = async (tool: string, target: string) => {
    await o.db.run('INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)', [new Date().toISOString(), o.personId, 'assistant', target, JSON.stringify({ tool, agent: agent() })]);
  };
  const people = async () => as().people.list().catch(() => [{ id: o.personId, name: 'me' }]);
  const nameOf = (list: { id: string; name: string }[], id: string) => (id === o.personId ? 'me' : list.find((p) => p.id === id)?.name ?? id);
  const projectName = (t: ProjectTree, id: string) => (getProject(t, id) ? pathOf(t, id) : '(removed project)');
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
  const pass = async (id: string): Promise<PassRecord> => {
    const p = await as().passes.get(id);
    if (!p) throw new Error('That pass is not there, or your role cannot see it. Use edit_passes to list them.');
    return p;
  };
  /** The exact text of the version a pass covers; needs the right to read manuscripts, as the vault does. */
  const pinnedText = async (p: PassRecord): Promise<string> => {
    if (!(await as().canOn('manuscript.read', p.projectId))) throw new PermissionDenied('manuscript.read', 'your role cannot read this manuscript');
    if (!o.blobsDir) throw new Error('This computer did not say where the vault keeps its files, so the text of a manuscript cannot be read here.');
    const v = await o.db.first<{ hash: string }>('SELECT hash FROM file_version WHERE file_id = ? AND n = ?', [p.fileId, p.fileVersion]);
    if (!v) throw new Error('That version of the file is not there.');
    const bytes = await new DirBlobs(o.blobsDir).get(v.hash);
    if (!bytes) throw new Error('The text of that version is not on this computer. Open it from Files in Cadrel (Get latest) first.');
    return new TextDecoder().decode(bytes);
  };

  server.registerTool(
    'edit_passes',
    {
      description: 'Editorial passes, oldest first: each with its project, kind, state, the file and version it covers, its editor, and how many items are open or unanswered. Live passes (not closed or called off) by default; `state` can be one state or "any". Filter by `project` (includes subprojects) and `kind`; `mine` limits it to passes you are the editor of.',
      inputSchema: {
        project: z.string().optional().describe('A project: its id, or its name or path such as "Dragon Rider / Book 1".'),
        state: z.enum(['live', 'any', 'planned', 'in_progress', 'delivered', 'responded', 'closed', 'cancelled']).optional(),
        kind: z.enum(['developmental', 'line', 'copy', 'proof']).optional(),
        mine: z.boolean().optional()
      },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const { tree } = await o.studio.read();
        const projectIds = a.project ? subtreeIds(tree, resolveProject(tree, a.project)) : undefined;
        const passes = (await as().passes.list({ state: a.state ?? 'live', kind: a.kind, editorId: a.mine ? o.personId : undefined, projectIds })).filter((p) => p.state !== 'cancelled' || a.state === 'cancelled' || a.state === 'any');
        const counts = passes.length ? await as().queries.counts(passes.map((p) => p.id)) : {};
        const names = await people();
        return passes.map((p) => ({
          id: p.id,
          title: p.title,
          kind: p.kind,
          state: p.state,
          project: projectName(tree, p.projectId),
          file: p.filePath,
          version: p.fileVersion,
          editor: nameOf(names, p.editorId),
          items: counts[p.id] ?? { open: 0, answered: 0, resolved: 0, withdrawn: 0 }
        }));
      })
  );

  server.registerTool(
    'edit_items',
    {
      description: 'The queries, comments and suggestions in one pass, numbered, each with its quoted passage, the text, any replacement, the author\'s answer, the author\'s decision (accept, reject or defer, and why), and, once the revision has been checked, whether the change was made.',
      inputSchema: { pass: z.string().describe('A pass id from edit_passes.'), state: z.enum(['live', 'any', 'open', 'answered', 'resolved', 'withdrawn']).optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const p = await pass(a.pass);
        const [items, decisions, checks] = await Promise.all([as().queries.list({ passId: p.id, state: a.state ?? 'any' }), as().queries.decisions({ passId: p.id }), as().queries.verification(p.id)]);
        return {
          pass: { id: p.id, title: p.title, kind: p.kind, state: p.state, file: p.filePath, version: p.fileVersion },
          items: items.map((i) => {
            const d = decisions.find((x) => x.queryId === i.id);
            const v = checks.find((x) => x.queryId === i.id);
            return {
              id: i.id,
              n: i.seq,
              kind: i.kind,
              state: i.state,
              category: i.category ?? undefined,
              passage: i.anchor?.quote,
              text: i.body || undefined,
              replacement: i.replacement ?? undefined,
              answer: i.response ?? undefined,
              decision: d ? { outcome: d.outcome, reason: d.reason || undefined, revisit: d.revisit ?? undefined } : undefined,
              revision: v ? { result: v.result, note: v.note || undefined } : undefined
            };
          })
        };
      })
  );

  server.registerTool(
    'edit_read',
    {
      description: 'The text of the exact version of the file a pass covers, in pieces: `from` is a character offset (0 to start) and `length` how many characters (8000 by default, 20000 at most). Quote from this text, exactly, when you raise items. Needs permission to read manuscripts.',
      inputSchema: { pass: z.string(), from: z.number().int().min(0).optional(), length: z.number().int().min(1).max(20000).optional() },
      annotations: readOnly
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const p = await pass(a.pass);
        const text = await pinnedText(p);
        const from = Math.min(a.from ?? 0, text.length);
        const to = Math.min(from + (a.length ?? 8000), text.length);
        return { file: p.filePath, version: p.fileVersion, from, to, total: text.length, more: to < text.length ? `edit_read with from=${to} for the next piece` : undefined, text: text.slice(from, to) };
      })
  );

  const item = z.object({
    kind: z.enum(['query', 'comment', 'suggestion']).describe('A query needs the author\'s answer; a comment does not; a suggestion has replacement text.'),
    quote: z.string().optional().describe('Exact text from edit_read. Needed for a suggestion; leave out for a point about the whole pass.'),
    before: z.string().optional().describe('If the quote occurs more than once: the words right before it.'),
    after: z.string().optional().describe('If the quote occurs more than once: the words right after it.'),
    text: z.string().optional().describe('What you want to say (needed for a query or comment; optional for a suggestion).'),
    replacement: z.string().optional().describe('Suggestions only: the text that replaces the quote (empty to take it out).'),
    category: z.string().optional().describe('What it is about: pacing, dialogue, clarity…')
  });
  server.registerTool(
    'edit_raise',
    {
      description: 'Adds queries, comments and suggestions to a pass that is in progress and that you are the editor of (all or none). Each is anchored to a passage you quote exactly from edit_read. They are numbered after the ones already there. You cannot do this for a pass someone else is editing, or one already delivered.',
      inputSchema: { pass: z.string(), items: z.array(item).min(1).max(200) }
    },
    (a) =>
      guarded(async () => {
        await allowed();
        const p = await pass(a.pass);
        const needsText = a.items.some((i) => i.quote);
        const text = needsText ? await pinnedText(p) : '';
        const items: NewQuery[] = a.items.map((i, n) => {
          const where = `Item ${n + 1}: `;
          try {
            let anchor: NewQuery['anchor'] = null;
            if (i.quote) {
              const start = findQuote(text, i.quote, i.before, i.after);
              anchor = makeAnchor(text, start, start + i.quote.length);
            } else if (i.kind === 'suggestion') throw new Error('A suggestion needs the passage it changes: give a quote.');
            return { kind: i.kind, body: i.text, anchor, ...(i.kind === 'suggestion' ? { replacement: i.replacement ?? '' } : {}), category: i.category };
          } catch (e) {
            throw new Error(where + (e instanceof Error ? e.message : String(e)));
          }
        });
        const raised = await as().queries.raise(p.id, items);
        await viaAssistant('edit_raise', p.id);
        return { pass: p.id, raised: raised.map((r) => ({ id: r.id, n: r.seq, kind: r.kind, passage: r.anchor?.quote })) };
      })
  );
}
