/**
 * The same tools as the MCP server, as a small REST API, for apps that take an OpenAPI description instead of MCP
 * (a Custom GPT's Actions). Pure: a request in, a status and JSON out, so it is tested without sockets.
 */
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
  type NoteFilter,
} from '../src/shared/agent/tools';

export interface RestResult {
  status: number;
  json: unknown;
}

const ok = (json: unknown): RestResult => ({ status: 200, json });
const bad = (status: number, error: string): RestResult => ({ status, json: { error } });

const flag = (v: string | null): boolean | undefined => (v === null ? undefined : v === 'true' || v === '1');
const opt = (v: string | null): string | undefined => (v === null || v === '' ? undefined : v);
/** A chapter given as a number or a heading; digits sent as text (as an OpenAPI string field carries them) mean the number. */
const chap = (v: unknown): number | string | undefined => (typeof v === 'number' || (typeof v === 'string' && v !== '') ? (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v) : undefined);
const object = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Routes `/api/...`. Mistakes the caller can fix come back as 400 with a message; unknown routes as 404. */
export async function handleRest(ctx: AgentContext, method: string, url: URL, body: unknown): Promise<RestResult> {
  try {
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const q = url.searchParams;
    if (parts[0] !== 'projects') return bad(404, 'Not found.');
    if (parts.length === 1 && method === 'GET') return ok(await listProjects(ctx));
    const project = parts[1];
    const rest = parts.slice(2).join('/');
    if (!project) return bad(404, 'Not found.');
    const need = (name: string) => {
      const v = q.get(name);
      if (!v) throw new AgentError(`The "${name}" parameter is required.`);
      return v;
    };

    if (method === 'GET') {
      switch (rest) {
        case 'files':
          return ok(await listFiles(ctx, project));
        case 'chapters':
          return ok(await listChapters(ctx, project, need('file')));
        case 'chapter': {
          const c = need('chapter');
          return ok(await readChapter(ctx, project, need('file'), /^\d+$/.test(c) ? Number(c) : c, { markdown: flag(q.get('markdown')) }));
        }
        case 'search':
          return ok(await searchText(ctx, project, need('query'), { file: opt(q.get('file')), regex: flag(q.get('regex')), caseSensitive: flag(q.get('caseSensitive')), limit: q.get('limit') ? Number(q.get('limit')) : undefined }));
        case 'notes': {
          const f: NoteFilter = { file: opt(q.get('file')), status: opt(q.get('status')) as NoteFilter['status'], kind: opt(q.get('kind')) as NoteFilter['kind'], reviewer: opt(q.get('reviewer')), category: opt(q.get('category')) };
          return ok(await getNotes(ctx, project, f));
        }
      }
    }
    if (method === 'POST' && rest === 'notes') {
      const b = object(body);
      return ok(await addNotes(ctx, project, typeof b.skill === 'string' ? b.skill : undefined, b.notes as never));
    }
    if (method === 'POST' && rest === 'edited') {
      const b = object(body);
      return ok(await setChaptersEdited(ctx, project, String(b.file ?? ''), { chapters: Array.isArray(b.chapters) ? b.chapters.map(chap).filter((c): c is number | string => c !== undefined) : undefined, through: chap(b.through) }, b.edited !== false));
    }
    const note = /^notes\/([^/]+)(\/replies)?$/.exec(rest);
    if (note && method === 'POST' && note[2]) {
      const b = object(body);
      return ok(await replyToNote(ctx, project, typeof b.skill === 'string' ? b.skill : undefined, note[1], String(b.body ?? '')));
    }
    if (note && method === 'DELETE' && !note[2]) return ok(await withdrawNote(ctx, project, note[1]));
    return bad(404, 'Not found.');
  } catch (e) {
    if (e instanceof AgentError) return bad(400, e.message);
    throw e;
  }
}

// ---- OpenAPI ---------------------------------------------------------------------------------

const str = (description: string) => ({ type: 'string', description });
const projectParam = { name: 'project', in: 'path', required: true, description: 'Project name from listProjects.', schema: { type: 'string' } };
const query = (name: string, description: string, type = 'string', required = false) => ({ name, in: 'query', required, description, schema: { type } });
const fileQuery = (required = true) => query('file', 'Manuscript file path from listFiles, e.g. "Manuscript/Book 1.md".', 'string', required);
const json = (schema: unknown) => ({ 'application/json': { schema } });
const done = (description = 'OK') => ({ '200': { description, content: json({ type: 'object' }) }, '400': { description: 'A mistake you can fix; the message says how.' } });

const noteSchema = {
  type: 'object',
  required: ['file', 'kind', 'quote'],
  properties: {
    file: str('Manuscript file path from listFiles.'),
    kind: { type: 'string', enum: ['comment', 'suggestion'], description: '"suggestion" proposes replacement text the author can accept.' },
    quote: str(`Exact text from readChapter (plain text). At most ${LIMITS.commentQuote} characters for comments, ${LIMITS.suggestionQuote} for suggestions.`),
    body: str('Comments: the point (required). Suggestions: a one-line reason.'),
    replacement: str('Suggestions only: text that replaces the quote, within one paragraph.'),
    category: str('Short label such as "pacing" or "spelling".'),
    before: str('If the quote appears more than once: words right before it.'),
    after: str('If the quote appears more than once: words right after it.'),
    chapter: { type: 'integer', description: 'Limit the search for the quote to this chapter number.' },
  },
};
const skillProp = str('Skill or role you are working as, e.g. "Line edit". Notes are signed with it. Leave out if none.');

/** An OpenAPI 3.1 description of the REST API, for a Custom GPT's Actions. Descriptions are kept short (Actions limit their length). */
export function openApiDocument(baseUrl: string): unknown {
  const op = (operationId: string, summary: string, description: string, parameters: unknown[], extra: Record<string, unknown> = {}) => ({ operationId, summary, description, parameters, responses: done(), ...extra });
  return {
    openapi: '3.1.0',
    info: {
      title: 'MDEdit AI reviewer',
      version: '1.0.0',
      description: 'Read an author\'s chapters and leave comments and suggestions in their MDEdit Notes panel. Cannot change the manuscript.',
    },
    servers: [{ url: baseUrl }],
    security: [{ bearer: [] }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    paths: {
      '/api/projects': { get: op('listProjects', 'List projects', 'The book projects you can review.', []) },
      '/api/projects/{project}/files': { get: op('listFiles', 'List manuscript files', 'Manuscript files in a project with word and chapter counts.', [projectParam]) },
      '/api/projects/{project}/chapters': { get: op('listChapters', 'List chapters', 'Chapters of a file, numbered from 0.', [projectParam, fileQuery()]) },
      '/api/projects/{project}/chapter': {
        get: op('readChapter', 'Read a chapter', 'A chapter as plain text, with the notes already on it. Quotes in your notes must match this text exactly.', [
          projectParam,
          fileQuery(),
          query('chapter', 'Chapter number from listChapters (from 0) or its exact heading.', 'string', true),
          query('markdown', 'true to also return the Markdown source.', 'boolean'),
        ]),
      },
      '/api/projects/{project}/search': {
        get: op('searchText', 'Search the book', 'Find a name, term or spelling across the manuscript. Returns file, chapter and a snippet.', [
          projectParam,
          query('query', 'Text to find (up to 200 characters).', 'string', true),
          fileQuery(false),
          query('regex', 'true to treat query as a regular expression.', 'boolean'),
          query('caseSensitive', 'true for a case-sensitive search.', 'boolean'),
          query('limit', 'Most hits to return (default 30, at most 100).', 'integer'),
        ]),
      },
      '/api/projects/{project}/notes': {
        get: op('getNotes', 'List notes', 'Review notes in a project; filter to see what is already resolved or answered.', [
          projectParam,
          fileQuery(false),
          { ...query('status', 'open, resolved, accepted or rejected.'), schema: { type: 'string', enum: ['open', 'resolved', 'accepted', 'rejected'] } },
          { ...query('kind', 'comment or suggestion.'), schema: { type: 'string', enum: ['comment', 'suggestion'] } },
          query('reviewer', 'Part of the reviewer name, e.g. "Line edit".'),
          query('category', 'A category label.'),
        ]),
        post: op(
          'addNotes',
          'Add notes',
          `Add up to ${LIMITS.notesPerCall} comments and suggestions. Each is checked separately; failures come back with the reason so you can resend them.`,
          [projectParam],
          { requestBody: { required: true, content: json({ type: 'object', required: ['notes'], properties: { skill: skillProp, notes: { type: 'array', maxItems: LIMITS.notesPerCall, items: noteSchema } } }) } }
        ),
      },
      '/api/projects/{project}/notes/{noteId}/replies': {
        post: op('replyToNote', 'Reply to a note', 'Add a reply in an existing note\'s thread.', [projectParam, { name: 'noteId', in: 'path', required: true, description: 'Note id from getNotes.', schema: { type: 'string' } }], {
          requestBody: { required: true, content: json({ type: 'object', required: ['body'], properties: { skill: skillProp, body: str('The reply.') } }) },
        }),
      },
      '/api/projects/{project}/edited': {
        post: op(
          'setChaptersEdited',
          'Mark chapters edited',
          'Mark chapters as edited or unmark them, like the chapter menu in MDEdit. Give chapters, or through for every chapter up to and including that one. Only when the author asks.',
          [projectParam],
          {
            requestBody: {
              required: true,
              content: json({
                type: 'object',
                required: ['file'],
                properties: {
                  file: str('Manuscript file path from listFiles.'),
                  edited: { type: 'boolean', description: 'true (default) marks the chapters as edited; false unmarks them.' },
                  chapters: { type: 'array', items: { type: 'string' }, description: 'Chapter numbers from listChapters (from 0) or exact headings.' },
                  through: str('One chapter number or heading: covers it and every chapter before it. Use instead of chapters.'),
                },
              }),
            },
          }
        ),
      },
      '/api/projects/{project}/notes/{noteId}': {
        delete: op('withdrawNote', 'Withdraw a note', 'Remove one of your own notes. Cannot remove anyone else\'s.', [projectParam, { name: 'noteId', in: 'path', required: true, description: 'Note id from getNotes.', schema: { type: 'string' } }]),
      },
    },
  };
}
