/**
 * The MCP server: MDEdit's AI-reviewer tools (src/shared/agent) described to a model. Claude and GPT clients both speak
 * MCP, so this is the only integration; nothing in it is specific to one vendor except the display name of the AI.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  addNotes,
  AgentError,
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
import { SKILLS } from './skills.generated';

export interface ServerOptions {
  fs: AgentContext['fs'];
  root: string;
  /** Overrides the AI's name; otherwise it is taken from the connecting client ("Claude", "GPT") or is just "AI". */
  agent?: string;
  version?: string;
  /** The folders that were looked at to find the projects, first choice first; named in the reply when there are none. */
  tried?: { root: string; source: string }[];
}

/** Which AI is connected, from the client's own name, so notes say who wrote them. */
export function agentFromClient(clientName: string | undefined, override?: string): { agent: string; agentName: string } {
  if (override?.trim()) return { agent: override.trim(), agentName: override.trim() };
  const n = (clientName ?? '').toLowerCase();
  if (n.includes('claude') || n.includes('anthropic')) return { agent: 'claude', agentName: 'Claude' };
  if (/openai|chatgpt|gpt|codex/.test(n)) return { agent: 'gpt', agentName: 'GPT' };
  return { agent: 'ai', agentName: 'AI' };
}

const project = z.string().describe('Project name, as returned by list_projects.');
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
    `No MDEdit projects were found. Looked in: ${looked}. A project is a folder directly inside the projects folder that contains .mdedit/project.json. ` +
    'Check that the projects folder is the Root Folder from MDEdit (File → Settings → Projects), not a single book\'s folder, and that the book was created in or moved into it. ' +
    'A folder opened with Open Folder from somewhere else is not found here.'
  );
}

export function createServer(o: ServerOptions): McpServer {
  const server = new McpServer(
    { name: 'mdedit', version: o.version ?? '0.0.0' },
    {
      instructions:
        'MDEdit holds a writer\'s book projects as Markdown files. You are an editor: read chapters with read_chapter and leave comments and suggestions with add_notes. ' +
        'You cannot change the manuscript; the author reviews your notes in MDEdit and accepts or rejects each one. Quote text exactly as read_chapter returns it.',
    }
  );

  const ctx = (): AgentContext => ({ fs: o.fs, root: o.root, ...agentFromClient(server.server.getClientVersion()?.name, o.agent) });
  const run = <T>(job: (c: AgentContext) => Promise<T>) => async () => {
    try {
      return reply(await job(ctx()));
    } catch (e) {
      if (e instanceof AgentError) return failure(e.message);
      throw e;
    }
  };
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

  server.registerTool('list_projects', { description: 'List the book projects (with their status) that you can read and review.', inputSchema: {}, annotations: readOnly }, run(async (c) => {
      const projects = await listProjects(c);
      return projects.length ? projects : { projects, message: noProjects(o) };
    }));

  server.registerTool(
    'list_files',
    { description: 'List the manuscript (Markdown) files in a project, with word and chapter counts.', inputSchema: { project }, annotations: readOnly },
    (a) => run((c) => listFiles(c, a.project))()
  );

  server.registerTool(
    'list_chapters',
    { description: 'List the chapters of a file (split at its top-level headings), with their word counts and whether the author has marked each as edited. Chapters are numbered from 0.', inputSchema: { project, file }, annotations: readOnly },
    (a) => run((c) => listChapters(c, a.project, a.file))()
  );

  server.registerTool(
    'read_chapter',
    {
      description:
        'Read one chapter as plain text: Markdown marks are removed and each paragraph is on its own line. This is the text your notes\' quotes must match. ' +
        'The result also lists the notes already on the chapter (yours, the author\'s and other reviewers\'): do not repeat them, and respect ones the author has resolved.',
      inputSchema: {
        project,
        file,
        chapter: z.union([z.number().int().min(0), z.string()]).describe('Chapter number from list_chapters (from 0), or its exact heading text.'),
        include_markdown: z.boolean().optional().describe('Also return the Markdown source, e.g. to check emphasis or heading formatting. Quotes must still come from the plain text.'),
      },
      annotations: readOnly,
    },
    (a) => run((c) => readChapter(c, a.project, a.file, a.chapter, { markdown: a.include_markdown }))()
  );

  server.registerTool(
    'search_text',
    {
      description:
        'Find text across the project\'s manuscript files, as plain text like read_chapter. Use it to check that a name, term, spelling or phrase is used the same way everywhere, or to find every place something is mentioned. ' +
        'Each hit has the file, chapter and a snippet.',
      inputSchema: {
        project,
        query: z.string().describe('Text to find (up to 200 characters). Case-insensitive unless case_sensitive is set.'),
        file: file.optional().describe('Search only this file.'),
        regex: z.boolean().optional().describe('Treat the query as a regular expression.'),
        case_sensitive: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Most hits to return (default 30).'),
      },
      annotations: readOnly,
    },
    (a) => run((c) => searchText(c, a.project, a.query, { file: a.file, regex: a.regex, caseSensitive: a.case_sensitive, limit: a.limit }))()
  );

  server.registerTool(
    'get_notes',
    {
      description: 'List review notes in a project, optionally filtered. Use it to see what the author has already resolved or answered.',
      inputSchema: {
        project,
        file: file.optional(),
        status: z.enum(['open', 'resolved', 'accepted', 'rejected']).optional(),
        kind: z.enum(['comment', 'suggestion']).optional(),
        reviewer: z.string().optional().describe('Part of the reviewer\'s name, e.g. "Line edit".'),
        category: z.string().optional(),
      },
      annotations: readOnly,
    },
    (a) => run((c) => getNotes(c, a.project, { file: a.file, status: a.status, kind: a.kind, reviewer: a.reviewer, category: a.category }))()
  );

  server.registerTool(
    'add_notes',
    {
      description:
        `Add up to ${LIMITS.notesPerCall} comments and suggestions in one call. Each note is checked separately: valid ones are saved and appear in the author's Notes panel, ` +
        'and any that fail come back with the reason (quote not found, quote matches several places, and so on) so you can fix and resend just those. ' +
        'A suggestion must sit inside one paragraph. Notes never change the manuscript.',
      inputSchema: { project, skill, notes: z.array(note).min(1).max(LIMITS.notesPerCall) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (a) => run((c) => addNotes(c, a.project, a.skill, a.notes))()
  );

  server.registerTool(
    'reply_to_note',
    {
      description: 'Reply in the thread of an existing note, for example to answer the author\'s reply. Does not change the note otherwise.',
      inputSchema: { project, skill, note_id: z.string(), body: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (a) => run((c) => replyToNote(c, a.project, a.skill, a.note_id, a.body))()
  );

  server.registerTool(
    'withdraw_note',
    {
      description: 'Remove one of your own notes that you now think is wrong. Cannot remove anyone else\'s notes or a suggestion the author already accepted.',
      inputSchema: { project, note_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (a) => run((c) => withdrawNote(c, a.project, a.note_id))()
  );

  server.registerTool(
    'set_chapters_edited',
    {
      description:
        'Mark chapters as edited, or unmark them: the same marks as Mark Edited and Unmark Edited in MDEdit\'s chapter menu, shown as the dot beside each chapter. ' +
        'Name the chapters, or give "through" to cover every chapter from the first up to and including that one (Mark Edited to Here / Unmark Edited to Here). ' +
        'Only do this when the author asks, or when they have told you to mark chapters as you finish them. It never changes the manuscript or your notes.',
      inputSchema: {
        project,
        file,
        edited: z.boolean().describe('true marks the chapters as edited; false unmarks them.'),
        chapters: z.array(z.union([z.number().int().min(0), z.string()])).optional().describe('Chapter numbers from list_chapters (from 0), or exact headings.'),
        through: z.union([z.number().int().min(0), z.string()]).optional().describe('One chapter number or heading: covers that chapter and every one before it in the file. Use instead of chapters.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (a) => run((c) => setChaptersEdited(c, a.project, a.file, { chapters: a.chapters, through: a.through }, a.edited))()
  );

  // The same instructions the skills carry, for clients that have prompts but not skills (GPT-based ones among them).
  for (const sk of SKILLS) {
    server.registerPrompt(
      sk.id,
      {
        title: sk.tag,
        description: sk.description,
        argsSchema: {
          project: z.string().optional().describe('The project to review. Leave out to be asked.'),
          file: z.string().optional().describe('A manuscript file in the project. Leave out to cover the project, or to be asked.'),
        },
      },
      ({ project: p, file: f }) => ({
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `${sk.body}\n\n---\n\nStart now. ${p ? `Review the project "${p}"${f ? `, file "${f}"` : ''}.` : 'Ask me which project to review.'} Leave your notes with add_notes using skill "${sk.tag}".`,
            },
          },
        ],
      })
    );
  }

  return server;
}
