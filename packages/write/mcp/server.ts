/**
 * The MCP server: Cadrel Write's AI-reviewer tools (src/shared/agent) described to a model. Claude and GPT clients both speak
 * MCP, so this is the only integration; nothing in it is specific to one vendor except the display name of the AI.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  addNotes,
  AgentError,
  createFile,
  editFile,
  getNotes,
  listChapters,
  listFiles,
  listProjects,
  LIMITS,
  readChapter,
  replyToNote,
  searchText,
  setChaptersEdited,
  withdrawNote,
  type AgentContext,
} from '../src/shared/agent/tools';
import { checkKeywords } from '../src/shared/agent/keywords';
import { editProjectFile, listProjectFiles, readProjectFile, writeProjectFile } from '../src/shared/agent/projectFiles';
import { buildTrackerView, checkTracker, litrpgLog, litrpgState, timelineLog, type ViewTemplates } from '../src/shared/agent/trackers';
import { EVENT_TYPES } from '../src/shared/agent/litrpg';
import type { AiAccess } from '../src/shared/agent/access';
import { SKILLS } from './skills.generated';

/** The page templates the tracker skills carry as assets. */
function viewTemplates(): ViewTemplates {
  const asset = (skill: string, path: string) => {
    const t = SKILLS.find((s) => s.name === skill)?.files[path];
    if (!t) throw new Error(`The ${skill} skill has no ${path}.`);
    return t;
  };
  return { timeline: asset('cadrel-timeline-tracker', 'assets/timeline-view.html'), litrpg: asset('cadrel-litrpg-tracker', 'assets/litrpg-dashboard.html'), sheet: asset('cadrel-litrpg-tracker', 'assets/character-sheet.html'), chapter: asset('cadrel-litrpg-tracker', 'assets/chapter-record.html') };
}

export interface ServerOptions {
  fs: AgentContext['fs'];
  root: string;
  /** Overrides the AI's name; otherwise it is taken from the connecting client ("Claude", "GPT") or is just "AI". */
  agent?: string;
  version?: string;
  /** The folders that were looked at to find the projects, first choice first; named in the reply when there are none. */
  tried?: { root: string; source: string }[];
  /** What the person has allowed the AI to change, read afresh at each change. Without it nothing may be created or edited. */
  access?: () => Promise<AiAccess>;
  /**
   * Inside Cadrel a project is a Project (a series) with Books under it, each with its own manuscript folder. This turns what the AI named
   * (a Project, a Book, a path such as "Dragon Rider / Book 2", or a plain folder name) into the folder to work in, or throws an AgentError that
   * tells it what to say instead ("which book?"). Without it `project` is simply a folder name.
   */
  resolve?: (ref: ProjectRef) => Promise<string>;
  /** The folders of the Books that come before this Book's in its series, in order, so the trackers can carry what happened in them forward. */
  earlier?: (folder: string) => Promise<string[]>;
}

/** What a tool call names, and what it needs of it. */
export interface ProjectRef {
  /** A folder name from list_projects, or a Project or Book (its name, path or id). */
  project: string;
  /** A Book of that Project, by name or id. */
  book?: string;
  /** "book": the Book's own material (manuscript, outline, trackers). "either": a Book's or the series' (characters, world, style, premise). */
  level: 'book' | 'either';
  /** The call changes something: a closed Book refuses it. */
  write: boolean;
}

/** Which AI is connected, from the client's own name, so notes say who wrote them. */
export function agentFromClient(clientName: string | undefined, override?: string): { agent: string; agentName: string } {
  if (override?.trim()) return { agent: override.trim(), agentName: override.trim() };
  const n = (clientName ?? '').toLowerCase();
  if (n.includes('claude') || n.includes('anthropic')) return { agent: 'claude', agentName: 'Claude' };
  if (/openai|chatgpt|gpt|codex/.test(n)) return { agent: 'gpt', agentName: 'GPT' };
  return { agent: 'ai', agentName: 'AI' };
}

const project = z
  .string()
  .describe('The project: a name from list_projects, or inside Cadrel a Project or Book such as "Dragon Rider" or "Dragon Rider / Book 2" (see studio_projects). With a series, also give `book`.');
const book = z.string().optional().describe('Which Book of the project, such as "Book 2", when the project is a series with more than one open Book. Book-level work (manuscript, outline, blurb, keywords, trackers) needs it then; series-level material (characters, world, style) does not.');
const file = z.string().describe('Path of a manuscript file inside the project, as returned by list_files, e.g. "Manuscript/Book 1.md".');
const skill = z
  .string()
  .max(40)
  .optional()
  .describe(
    'The skill or role you are working as, e.g. "Line edit", "Copy edit", "Developmental edit". Your notes are signed with it ("Claude · Line edit") and kept apart from your other notes. Leave it out if you are not following a skill: the notes are then signed with just your name.'
  );

const note = z.object({
  file,
  kind: z.enum(['comment', 'suggestion']).describe('"comment" raises a point. "suggestion" proposes replacement text the author can accept with one click.'),
  quote: z
    .string()
    .describe(`The exact text the note is about, copied from read_chapter (plain text, no Markdown marks). Keep it short but unique: at most ${LIMITS.commentQuote} characters for comments, ${LIMITS.suggestionQuote} for suggestions.`),
  body: z.string().optional().describe('Comments: the point you are making (required). Suggestions: a one-line reason (optional).'),
  replacement: z.string().optional().describe('Suggestions only: the text that replaces the quote. Must stay within one paragraph. Empty string means delete the quote.'),
  category: z.string().optional().describe('A short label such as "pacing", "continuity", "rhythm", "spelling".'),
  before: z.string().optional().describe('If the quote appears more than once: the few words immediately before it.'),
  after: z.string().optional().describe('If the quote appears more than once: the few words immediately after it.'),
  chapter: z.number().int().min(0).optional().describe('Limit the search for the quote to this chapter number.'),
});

const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const failure = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });

/** Why there is nothing to list, and what to check: shown to the AI (and so the author) instead of a bare empty list. */
export function noProjects(o: Pick<ServerOptions, 'root' | 'tried'>): string {
  const looked = (o.tried?.length ? o.tried : [{ root: o.root, source: 'the server settings' }]).map((t) => `${t.root} (${t.source})`).join('; ');
  return (
    `No Cadrel Write projects were found. Looked in: ${looked}. A project is a folder directly inside the projects folder that contains .cadrel/project.json. ` +
    'Check that the projects folder is the Root Folder from Cadrel Write (File → Settings → Projects), not a single book\'s folder, and that the book was created in or moved into it. ' +
    'A folder opened with Open Folder from somewhere else is not found here.'
  );
}

/** What the AI is told about Cadrel Write's tools. A server that adds other modules' tools puts this beside theirs. */
export const WRITE_INSTRUCTIONS =
  'Cadrel Write holds a writer\'s book projects as Markdown files. Inside Cadrel a project can be a series with Books under it: name the project, and add `book` when it has more than one open Book (a call that needs one and lacks it says which to pick; a closed Book can be read but not changed). Book-level work (manuscript, outline, blurb, keywords, trackers) belongs to a Book; series-level material (series bible, characters, world, style) belongs to the project itself, so leave `book` out for it. As an editor: read chapters with read_chapter and leave comments and suggestions with add_notes. ' +
  'By default you cannot change the manuscript: the author reviews your notes in Cadrel Write and accepts or rejects each one. Quote text exactly as read_chapter returns it. ' +
  'create_file and edit_file work only if the author has allowed them under Settings → MCP in Cadrel (both are off until they do). If one is refused, do not try to get round it: tell the author what you wanted to change, leave add_notes suggestions, and mention the setting. ' +
  'As a development partner: list_project_files, read_project_file, write_project_file and edit_project_file work on the project\'s other files (premise, outline, characters, worldbuilding, blurb, keywords), never on the manuscript, and never replace a file without mode "replace". ' +
  'The trackers keep a LitRPG mechanics ledger (litrpg_log, litrpg_state) and a timeline ledger (timeline_log) in the project\'s Tracking folder, check them with check_tracker, and draw them with build_tracker_view. check_keywords validates KDP backend keywords. ' +
  'The prompts (series_developer, premise_to_outline, outline_to_blurb, outline_to_keywords, timeline_tracker, litrpg_tracker, and the three editing passes) are step-by-step working methods; start one when the author asks for that kind of work.';

export function createServer(o: ServerOptions): McpServer {
  const server = new McpServer({ name: 'cadrel-write', version: o.version ?? '0.0.0' }, { instructions: WRITE_INSTRUCTIONS });
  registerWriteTools(server, o);
  return server;
}

/** Cadrel Write's tools and editing-skill prompts, registered on any MCP server (so one server can carry several modules' tools). */
export function registerWriteTools(server: McpServer, o: ServerOptions): void {
  const ctx = (): AgentContext => ({ fs: o.fs, root: o.root, access: o.access, ...agentFromClient(server.server.getClientVersion()?.name, o.agent) });
  const run = <T>(job: (c: AgentContext) => Promise<T>) => async () => {
    try {
      return reply(await job(ctx()));
    } catch (e) {
      if (e instanceof AgentError) return failure(e.message);
      throw e;
    }
  };
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;
  /** The folder a call works in (see `ServerOptions.resolve`). */
  const ref = (a: { project: string; book?: string }, level: ProjectRef['level'], write = false): Promise<string> => (o.resolve ? o.resolve({ project: a.project, book: a.book, level, write }) : Promise.resolve(a.project));

  server.registerTool('list_projects', { description: 'List the book projects (with their status) that you can read and review.', inputSchema: {}, annotations: readOnly }, run(async (c) => {
      const projects = await listProjects(c);
      return projects.length ? projects : { projects, message: noProjects(o) };
    }));

  server.registerTool(
    'list_files',
    { description: 'List the manuscript (Markdown) files in a project, with word and chapter counts.', inputSchema: { project, book }, annotations: readOnly },
    (a) => run(async (c) => listFiles(c, await ref(a, 'book')))()
  );

  server.registerTool(
    'list_chapters',
    { description: 'List the chapters of a file (split at its top-level headings), with their word counts and whether the author has marked each as edited. Chapters are numbered from 0.', inputSchema: { project, book, file }, annotations: readOnly },
    (a) => run(async (c) => listChapters(c, await ref(a, 'book'), a.file))()
  );

  server.registerTool(
    'read_chapter',
    {
      description:
        'Read one chapter as plain text: Markdown marks are removed and each paragraph is on its own line. This is the text your notes\' quotes must match. ' +
        'The result also lists the notes already on the chapter (yours, the author\'s and other reviewers\'): do not repeat them, and respect ones the author has resolved.',
      inputSchema: {
        project,
        book,
        file,
        chapter: z.union([z.number().int().min(0), z.string()]).describe('Chapter number from list_chapters (from 0), or its exact heading text.'),
        include_markdown: z.boolean().optional().describe('Also return the Markdown source, e.g. to check emphasis or heading formatting. Quotes must still come from the plain text.'),
      },
      annotations: readOnly,
    },
    (a) => run(async (c) => readChapter(c, await ref(a, 'book'), a.file, a.chapter, { markdown: a.include_markdown }))()
  );

  server.registerTool(
    'search_text',
    {
      description:
        'Find text across the project\'s manuscript files, as plain text like read_chapter. Use it to check that a name, term, spelling or phrase is used the same way everywhere, or to find every place something is mentioned. ' +
        'Each hit has the file, chapter and a snippet.',
      inputSchema: {
        project,
        book,
        query: z.string().describe('Text to find (up to 200 characters). Case-insensitive unless case_sensitive is set.'),
        file: file.optional().describe('Search only this file.'),
        regex: z.boolean().optional().describe('Treat the query as a regular expression.'),
        case_sensitive: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Most hits to return (default 30).'),
      },
      annotations: readOnly,
    },
    (a) => run(async (c) => searchText(c, await ref(a, 'book'), a.query, { file: a.file, regex: a.regex, caseSensitive: a.case_sensitive, limit: a.limit }))()
  );

  server.registerTool(
    'get_notes',
    {
      description: 'List review notes in a project, optionally filtered. Use it to see what the author has already resolved or answered.',
      inputSchema: {
        project,
        book,
        file: file.optional(),
        status: z.enum(['open', 'resolved', 'accepted', 'rejected']).optional(),
        kind: z.enum(['comment', 'suggestion']).optional(),
        reviewer: z.string().optional().describe('Part of the reviewer\'s name, e.g. "Line edit".'),
        category: z.string().optional(),
      },
      annotations: readOnly,
    },
    (a) => run(async (c) => getNotes(c, await ref(a, 'book'), { file: a.file, status: a.status, kind: a.kind, reviewer: a.reviewer, category: a.category }))()
  );

  server.registerTool(
    'add_notes',
    {
      description:
        `Add up to ${LIMITS.notesPerCall} comments and suggestions in one call. Each note is checked separately: valid ones are saved and appear in the author's Notes panel, ` +
        'and any that fail come back with the reason (quote not found, quote matches several places, and so on) so you can fix and resend just those. ' +
        'A suggestion must sit inside one paragraph. Notes never change the manuscript.',
      inputSchema: { project, book, skill, notes: z.array(note).min(1).max(LIMITS.notesPerCall) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (a) => run(async (c) => addNotes(c, await ref(a, 'book', true), a.skill, a.notes))()
  );

  server.registerTool(
    'reply_to_note',
    {
      description: 'Reply in the thread of an existing note, for example to answer the author\'s reply. Does not change the note otherwise.',
      inputSchema: { project, book, skill, note_id: z.string(), body: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (a) => run(async (c) => replyToNote(c, await ref(a, 'book', true), a.skill, a.note_id, a.body))()
  );

  server.registerTool(
    'withdraw_note',
    {
      description: 'Remove one of your own notes that you now think is wrong. Cannot remove anyone else\'s notes or a suggestion the author already accepted.',
      inputSchema: { project, book, note_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (a) => run(async (c) => withdrawNote(c, await ref(a, 'book', true), a.note_id))()
  );

  server.registerTool(
    'set_chapters_edited',
    {
      description:
        'Mark chapters as edited, or unmark them: the same marks as Mark Edited and Unmark Edited in Cadrel Write\'s chapter menu, shown as the dot beside each chapter. ' +
        'Name the chapters, or give "through" to cover every chapter from the first up to and including that one (Mark Edited to Here / Unmark Edited to Here). ' +
        'Only do this when the author asks, or when they have told you to mark chapters as you finish them. It never changes the manuscript or your notes.',
      inputSchema: {
        project,
        book,
        file,
        edited: z.boolean().describe('true marks the chapters as edited; false unmarks them.'),
        chapters: z.array(z.union([z.number().int().min(0), z.string()])).optional().describe('Chapter numbers from list_chapters (from 0), or exact headings.'),
        through: z.union([z.number().int().min(0), z.string()]).optional().describe('One chapter number or heading: covers that chapter and every one before it in the file. Use instead of chapters.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (a) => run(async (c) => setChaptersEdited(c, await ref(a, 'book', true), a.file, { chapters: a.chapters, through: a.through }, a.edited))()
  );


  // ---- the project's other files, for the authoring skills ----
  server.registerTool(
    'list_project_files',
    {
      description: 'List the project\'s text files (Markdown, text, JSON, HTML, CSV) with a guessed kind: manuscript, premise, outline, bible, character, world, research, copy, tracker, view, style or other. Look here before creating anything, so existing work is built on, not duplicated.',
      inputSchema: { project, book, folder: z.string().optional().describe('Only files inside this folder, e.g. "Characters".') },
      annotations: readOnly,
    },
    (a) => run(async (c) => listProjectFiles(c, await ref(a, 'either'), a.folder))()
  );
  server.registerTool(
    'read_project_file',
    {
      description: 'Read one text file of the project (not only the manuscript). A long file comes in parts: when the result says truncated, call again with start set to nextStart.',
      inputSchema: {
        project,
        book,
        file: z.string().describe('Path inside the project from list_project_files, e.g. "Characters/Mira.md".'),
        start: z.number().int().min(0).optional().describe('Character offset to start from (default 0).'),
        max_chars: z.number().int().min(1).optional().describe('Most characters to return (default 40000, at most 120000).'),
      },
      annotations: readOnly,
    },
    (a) => run(async (c) => readProjectFile(c, await ref(a, 'either'), a.file, { start: a.start, maxChars: a.max_chars }))()
  );
  server.registerTool(
    'write_project_file',
    {
      description:
        'Save a text file in the project: a premise, character sheet, outline, blurb and so on. Folders are created as needed. Never writes into a manuscript or exports folder. ' +
        'mode "create" (default) refuses to overwrite; "replace" overwrites and keeps the old version in .cadrel/previous; "append" adds to the end of a Markdown or text file, which is how to save a long document in parts. Read the file first before replacing it.',
      inputSchema: {
        project,
        book,
        file: z.string().describe('Path inside the project, e.g. "Premise.md" or "Characters/Mira.md".'),
        content: z.string().describe('The whole text (for append, the text to add). At most 400000 characters per call.'),
        mode: z.enum(['create', 'replace', 'append']).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (a) => run(async (c) => writeProjectFile(c, await ref(a, 'either', true), a.file, a.content, a.mode))()
  );
  server.registerTool(
    'edit_project_file',
    {
      description: 'Change one exact piece of text in a project file (a find-and-replace that must match exactly once unless replace_all). The old version is kept. Use it for small changes instead of rewriting a long file.',
      inputSchema: { project, book, file: z.string(), old_text: z.string().describe('Exact text to change, copied from read_project_file.'), new_text: z.string().describe('What replaces it (empty deletes it).'), replace_all: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (a) => run(async (c) => editProjectFile(c, await ref(a, 'either', true), a.file, a.old_text, a.new_text, a.replace_all))()
  );
  server.registerTool(
    'check_keywords',
    {
      description:
        'Check seven KDP backend keyword phrases against the rules: at most 50 characters each, no punctuation, no word used twice across the seven, no word from the title, subtitle or categories, no claims or time-sensitive terms, and no opposite-market terms for male-targeted HaremLit. Returns every problem with its slot, and each phrase\'s length.',
      inputSchema: {
        slots: z.array(z.string()).describe('The seven phrases, in slot order.'),
        title: z.string().optional(),
        subtitle: z.string().optional(),
        categories: z.array(z.string()).optional().describe('The browse categories already chosen.'),
        male_targeted: z.boolean().optional().describe('Default true. Set false to skip the HaremLit opposite-market check.'),
      },
      annotations: readOnly,
    },
    async (a) => reply(checkKeywords(a.slots, { title: a.title, subtitle: a.subtitle, categories: a.categories, maleTargeted: a.male_targeted }))
  );

  // ---- the trackers ----
  const event = z.object({
    type: z.enum(EVENT_TYPES),
    chapter: z.number().int().min(0).describe('The chapter as the book numbers it (Chapter 1 is 1).'),
    details: z.record(z.unknown()).describe('Type-specific fields; see the LitRPG tracker skill. Use null, never a guess, for a number the text does not give.'),
    source_quote: z.string().optional().describe('The manuscript\'s exact words, where they matter.'),
    note: z.string().optional(),
    corrects: z.string().optional().describe('The id of an earlier event that was extracted wrongly; replay will skip it.'),
  });
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
  server.registerTool(
    'litrpg_log',
    {
      description:
        'Append mechanics events (levels, XP, stats, class, skills, items, titles, companions) to the project\'s LitRPG ledger, creating it on first use. Events are validated (a bad one saves nothing and says which), kept in chapter order, each character is replayed from the log, and the arithmetic checks run. Returns what changed and any new flags. Each chapter you log also gets a permanent page of its own, Tracking/Chapters/Chapter N.html (what changed in it, and where each character stands after it); a later correction writes a new version and keeps the old one.',
      inputSchema: {
        project,
        book,
        characters: z.array(z.object({ name: z.string(), events: z.array(event) })).describe('Events by character, in chapter order.'),
        flags: z.array(z.object({ type: z.enum(['arithmetic_mismatch', 'threshold_contradiction', 'ability_drift', 'silent_jump']), character: z.string().optional(), chapters_involved: z.array(z.number().int()).optional(), description: z.string() })).optional().describe('Contradictions you found by reading that the checks cannot see.'),
        resolve_flags: z.array(z.string()).optional().describe('Flag ids the author has said are resolved. Never resolve one yourself.'),
        last_updated_chapter: z.number().int().min(0).optional().describe('The last chapter you processed, if later than the last event.'),
      },
      annotations: write,
    },
    (a) => run(async (c) => { const f = await ref(a, 'book', true); return litrpgLog(c, f, a as never, { templates: viewTemplates(), earlier: await o.earlier?.(f) }); })()
  );
  server.registerTool(
    'litrpg_state',
    {
      description: 'A character\'s level, XP, class, attributes, skills, items, titles and companions as of a chapter (or the end of the ledger), replayed from the event log. as_of_day uses the timeline ledger to find the last chapter narrated by that in-story day. Answers from the ledger; does not read the manuscript.',
      inputSchema: { project, book, character: z.string().optional().describe('Leave out for every character.'), as_of_chapter: z.number().int().min(0).optional(), as_of_day: z.union([z.number().int(), z.string()]).optional() },
      annotations: readOnly,
    },
    (a) => run(async (c) => { const f = await ref(a, 'book'); return litrpgState(c, f, { character: a.character, as_of_chapter: a.as_of_chapter, as_of_day: a.as_of_day }, await o.earlier?.(f)); })()
  );
  server.registerTool(
    'timeline_log',
    {
      description:
        'Merge what the text says about in-story days into the project\'s timeline ledger, creating it on first use: chapters on each day, locations, characters, events, and every elapsed-time or calendar statement with its exact quote. Lists grow and duplicates are ignored, so send only what is new. The chronology checks run and new flags come back. Each chapter the days mention also gets its permanent page, Tracking/Chapters/Chapter N.html, with the in-story days it narrates.',
      inputSchema: {
        project,
        book,
        days: z
          .array(
            z.object({
              day: z.union([z.number().int(), z.string()]).describe('The day number, or "uncertain" when the text does not pin it down.'),
              chapters: z.array(z.object({ chapter: z.number().int().min(0), mode: z.enum(['full_scene', 'summarized', 'off_page']).optional(), flashback: z.boolean().optional() })).optional(),
              locations: z.array(z.string()).optional(),
              characters_present: z.array(z.string()).optional(),
              pov_character: z.string().nullable().optional(),
              major_events: z.array(z.string()).optional(),
              elapsed_time_claims: z.array(z.object({ quote: z.string(), source_chapter: z.number().int(), days: z.number().nullable().optional(), since_day: z.union([z.string(), z.number()]).nullable().optional() })).optional(),
              calendar_claims: z.array(z.object({ quote: z.string(), source_chapter: z.number().int() })).optional(),
              daily_quests_completed: z.array(z.string()).optional().describe('A pointer only; never XP numbers.'),
              time_of_day_markers: z.array(z.string()).optional(),
              weekday: z.string().nullable().optional().describe('Only when the text states or fixes it.'),
              day_type: z.enum(['weekday', 'weekend']).nullable().optional(),
              day_confidence: z.enum(['confirmed', 'uncertain']).optional(),
              day_range_if_uncertain: z.array(z.number()).length(2).nullable().optional(),
            })
          )
          .describe('One entry per day touched.'),
        flags: z.array(z.object({ type: z.enum(['overlapping_days', 'day_of_week_contradiction', 'duration_mismatch', 'untracked_gap', 'compression_imbalance']), days_involved: z.array(z.union([z.string(), z.number()])).optional(), chapters_involved: z.array(z.number().int()).optional(), description: z.string(), quotes: z.array(z.object({ quote: z.string(), chapter: z.number().int() })).describe('Both conflicting quotes, with their chapters.') })).optional(),
        resolve_flags: z.array(z.string()).optional().describe('Flag ids the author has said are resolved. Never resolve one yourself.'),
        last_updated_chapter: z.number().int().min(0).optional(),
      },
      annotations: write,
    },
    (a) => run(async (c) => { const f = await ref(a, 'book', true); return timelineLog(c, f, a as never, { templates: viewTemplates(), earlier: await o.earlier?.(f) }); })()
  );
  server.registerTool(
    'check_tracker',
    {
      description: 'Run every consistency check over a whole ledger ("does the math check out?", "does the timeline hold together?"), save any new flags, and list every flag still open. Flags are the author\'s to resolve.',
      inputSchema: { project, book, tracker: z.enum(['litrpg', 'timeline']) },
      annotations: write,
    },
    (a) => run(async (c) => { const f = await ref(a, 'book', true); return checkTracker(c, f, a.tracker, await o.earlier?.(f)); })()
  );
  server.registerTool(
    'build_tracker_view',
    {
      description:
        'Draw a ledger as a self-contained HTML page and save it in the project\'s Tracking folder: "timeline" (day ribbon, chapter map, progression chart, flags), "litrpg" (dashboard with an as-of-chapter slider), "character_sheet" (a printable sheet that shows only known values and no notes; optionally as of a chapter), or "chapters" (the permanent record of each chapter, Tracking/Chapters/Chapter N.html; litrpg_log and timeline_log write these as they go, so use this only to bring up to date a ledger logged before they existed, or one chapter with as_of_chapter). ' +
        'Set return_html to get the page itself back, to show it as an artifact; otherwise only the saved path comes back.',
      inputSchema: {
        project,
        book,
        view: z.enum(['timeline', 'litrpg', 'character_sheet', 'chapters']),
        character: z.string().optional().describe('For a character sheet: the character\'s name, or "all".'),
        as_of_chapter: z.number().int().min(0).optional().describe('For a character sheet: the state as of this chapter. For "chapters": write just this chapter\'s record.'),
        return_html: z.boolean().optional(),
      },
      annotations: write,
    },
    (a) => run(async (c) => { const f = await ref(a, 'book', true); return buildTrackerView(c, f, { view: a.view, character: a.character, as_of_chapter: a.as_of_chapter, return_html: a.return_html }, viewTemplates(), await o.earlier?.(f)); })()
  );

  const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

  server.registerTool(
    'create_file',
    {
      description:
        'Create a new Markdown manuscript file in a project (for example a new chapter or a notes file). It never replaces a file that exists. ' +
        'Off unless the author has allowed AI tools to create files in Cadrel (Settings → MCP): if it is off the call is refused and nothing is written.',
      inputSchema: {
        project,
        book,
        file: z.string().describe('Path of the new file inside the project, ending in .md, e.g. "Manuscript/Chapter 2.md". Folders on the way are made if needed.'),
        content: z.string().describe(`The Markdown text of the file (up to ${LIMITS.fileContent} characters).`),
      },
      annotations: writes,
    },
    (a) => run(async (c) => createFile(c, await ref(a, 'book', true), a.file, a.content))()
  );

  server.registerTool(
    'edit_file',
    {
      description:
        'Change the text of an existing manuscript file by replacing exact passages of its Markdown. Every edit must match exactly one place; if any does not, nothing is changed. ' +
        'Off unless the author has allowed AI tools to edit files in Cadrel (Settings → MCP): if it is off the call is refused and nothing is written. ' +
        'Prefer add_notes suggestions unless the author has asked you to make the change yourself.',
      inputSchema: {
        project,
        book,
        file,
        edits: z
          .array(
            z.object({
              old_text: z.string().describe('The exact Markdown now in the file (see read_chapter with include_markdown). Must occur once: include enough surrounding text.'),
              new_text: z.string().describe('What replaces it. Empty deletes the passage.'),
            })
          )
          .min(1)
          .max(LIMITS.editsPerCall),
      },
      annotations: { ...writes, destructiveHint: true },
    },
    (a) => run(async (c) => editFile(c, await ref(a, 'book', true), a.file, a.edits))()
  );

  // The same instructions the skills carry, for clients that have prompts but not skills (GPT-based ones among them).
  for (const sk of SKILLS) {
    const review = sk.kind === 'review';
    server.registerPrompt(
      sk.id,
      {
        title: sk.tag,
        description: sk.description,
        argsSchema: review
          ? {
              project: z.string().optional().describe('The project to review. Leave out to be asked.'),
              file: z.string().optional().describe('A manuscript file in the project. Leave out to cover the project, or to be asked.'),
            }
          : {
              project: z.string().optional().describe('The project to work in. Leave out to be asked.'),
              request: z.string().optional().describe('What you want, in your own words. Leave out to be asked.'),
            },
      },
      ({ project: p, file: f, request: r }) => ({
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: review
                ? `${sk.body}\n\n---\n\nStart now. ${p ? `Review the project "${p}"${f ? `, file "${f}"` : ''}.` : 'Ask me which project to review.'} Leave your notes with add_notes using skill "${sk.tag}".`
                : `${sk.body}\n\n---\n\nStart now. ${p ? `Work in the project "${p}".` : 'Ask me which project to work in.'} ${r ? `What I want: ${r}` : 'Ask me what I want to do.'}`,
            },
          },
        ],
      })
    );
  }
}
