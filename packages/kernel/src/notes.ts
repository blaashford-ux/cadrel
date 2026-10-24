/**
 * Notes: one way to leave a comment, a suggestion or a question on anything in any module. MDEdit's Notes (comments and
 * suggestions anchored in a manuscript, written by people and by AI reviewers) are the model; here the thing a note is
 * about is a `NoteTarget` rather than a file, so a module that makes records (a Market category, a cover brief, a
 * royalty statement) gets Notes by naming its records, with no Notes code of its own.
 *
 * Write keeps its manuscript notes in the review files beside the manuscript, because they are shared with reviewers
 * through Google Drive. The studio-wide Notes list reads those too (see `NoteView`); everything else is stored here.
 */

import { newId } from './projects';

export const NOTES_VERSION = 1;
export const BODY_MAX = 4000;
export const REPLY_MAX = 4000;
export const CATEGORY_MAX = 40;
/** A cap on notes an AI can leave open on one project, so a runaway assistant cannot bury it (MDEdit uses the same figure). */
export const AI_OPEN_MAX = 1000;

export type NoteStatus = 'open' | 'resolved' | 'accepted' | 'rejected' | 'deleted';
export type NoteKind = 'comment' | 'suggestion';

/** The same shape as MDEdit's text anchor, so text notes in any module can be re-found after the text moves. */
export interface NoteAnchor {
  quote: string;
  prefix: string;
  suffix: string;
  start: number;
}

/** What a note is about. `module` is the module id; `kind` and `id` are that module's own words ("category" / a key). */
export interface NoteTarget {
  module: string;
  kind: string;
  id: string;
  /** What to show for it, kept with the note so the list reads well even when the module is not running. */
  label?: string;
  anchor?: NoteAnchor;
}

export interface NoteReply {
  id: string;
  author: string;
  createdAt: string;
  body: string;
}

export interface Note {
  id: string;
  /** The project it belongs to, or null for a note on the studio itself. */
  projectId: string | null;
  target: NoteTarget | null;
  kind: NoteKind;
  body: string;
  /** Suggestions: the text that should replace the anchored quote. */
  replacement?: string;
  status: NoteStatus;
  /** What it is about ("pacing", "pricing"); a small chip. */
  category?: string;
  /** Absent means a person. */
  origin?: 'human' | 'ai';
  author: string;
  createdAt: string;
  updatedAt: string;
  replies: NoteReply[];
}

export class NoteError extends Error {}
const fail = (m: string): never => {
  throw new NoteError(m);
};

export const STANDARD_TOPICS = ['pacing', 'continuity', 'dialogue', 'character', 'plot', 'style', 'clarity', 'research', 'pricing', 'positioning', 'cover', 'blurb', 'keywords'];

export function normalizeCategory(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  return raw.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, CATEGORY_MAX).trim() || undefined;
}

const text = (raw: unknown, what: string, max: number): string => {
  const t = typeof raw === 'string' ? raw.trim() : '';
  if (!t) return fail(`A ${what} cannot be empty.`);
  if (t.length > max) return fail(`A ${what} can be at most ${max} characters.`);
  return t;
};

const noteId = (): string => newId('n');

export interface NewNote {
  projectId?: string | null;
  target?: NoteTarget | null;
  kind?: NoteKind;
  body: string;
  replacement?: string;
  category?: string;
  origin?: 'human' | 'ai';
  author: string;
  id?: string;
  now?: string;
}

export function createNote(notes: Note[], o: NewNote): { notes: Note[]; note: Note } {
  const kind = o.kind ?? 'comment';
  const projectId = o.projectId ?? null;
  if (kind === 'suggestion' && (o.replacement === undefined || !o.target?.anchor)) fail('A suggestion needs the text to change and what to put there instead.');
  if (o.origin === 'ai' && notes.filter((n) => n.origin === 'ai' && n.status === 'open' && n.projectId === projectId).length >= AI_OPEN_MAX) {
    fail(`There are already ${AI_OPEN_MAX} open AI notes here; resolve some before adding more.`);
  }
  const now = o.now ?? new Date().toISOString();
  const note: Note = {
    id: o.id ?? noteId(),
    projectId,
    target: o.target ?? null,
    kind,
    body: text(o.body, 'note', BODY_MAX),
    ...(kind === 'suggestion' ? { replacement: String(o.replacement) } : {}),
    status: 'open',
    ...(normalizeCategory(o.category) ? { category: normalizeCategory(o.category) } : {}),
    ...(o.origin ? { origin: o.origin } : {}),
    author: text(o.author, 'author name', 80),
    createdAt: now,
    updatedAt: now,
    replies: []
  };
  return { notes: [...notes, note], note };
}

const change = (notes: Note[], id: string, fn: (n: Note) => Note): Note[] => {
  if (!notes.some((n) => n.id === id)) fail(`There is no note "${id}".`);
  return notes.map((n) => (n.id === id ? { ...fn(n), updatedAt: new Date().toISOString() } : n));
};

export function setNoteStatus(notes: Note[], id: string, status: NoteStatus): Note[] {
  return change(notes, id, (n) => {
    if ((status === 'accepted' || status === 'rejected') && n.kind !== 'suggestion') fail('Only suggestions are accepted or rejected.');
    return { ...n, status };
  });
}

export function editNote(notes: Note[], id: string, patch: { body?: string; category?: string | null }): Note[] {
  return change(notes, id, (n) => {
    const next = { ...n };
    if (patch.body !== undefined) next.body = text(patch.body, 'note', BODY_MAX);
    if (patch.category !== undefined) {
      const c = normalizeCategory(patch.category);
      if (c) next.category = c;
      else delete next.category;
    }
    return next;
  });
}

export function replyToNote(notes: Note[], id: string, reply: { author: string; body: string; now?: string }): Note[] {
  return change(notes, id, (n) => ({
    ...n,
    replies: [...n.replies, { id: newId('r'), author: text(reply.author, 'author name', 80), createdAt: reply.now ?? new Date().toISOString(), body: text(reply.body, 'reply', REPLY_MAX) }]
  }));
}

/** A person's own notes can be taken back; "deleted" is kept, not removed, so it can travel when stores are merged. */
export function deleteNote(notes: Note[], id: string): Note[] {
  return setNoteStatus(notes, id, 'deleted');
}

export interface NoteQuery {
  /** Notes on these projects (pass a subtree to include subprojects). */
  projectIds?: string[];
  module?: string;
  status?: NoteStatus | 'any';
  origin?: 'human' | 'ai';
  category?: string;
  kind?: NoteKind;
  /** Notes whose body, replies or target label contain this. */
  text?: string;
}

/** Newest first. Deleted notes are only returned when asked for by status. */
export function queryNotes<T extends Pick<Note, 'projectId' | 'target' | 'status' | 'origin' | 'category' | 'kind' | 'body' | 'replies' | 'updatedAt'>>(notes: T[], q: NoteQuery = {}): T[] {
  const ids = q.projectIds && new Set(q.projectIds);
  const needle = q.text?.toLowerCase();
  return notes
    .filter((n) => {
      if (ids && !(n.projectId !== null && ids.has(n.projectId))) return false;
      if (q.module && n.target?.module !== q.module) return false;
      const status = q.status ?? 'open';
      if (status === 'any' ? n.status === 'deleted' : n.status !== status) return false;
      if (q.origin && (n.origin ?? 'human') !== q.origin) return false;
      if (q.category && n.category !== normalizeCategory(q.category)) return false;
      if (q.kind && n.kind !== q.kind) return false;
      if (needle && ![n.body, n.target?.label ?? '', ...n.replies.map((r) => r.body)].some((s) => s.toLowerCase().includes(needle))) return false;
      return true;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Notes counted per project: how many open notes each project (and, with `rollUp`, everything below it) has. */
export function openCounts(notes: Pick<Note, 'projectId' | 'status'>[]): Map<string | null, number> {
  const m = new Map<string | null, number>();
  for (const n of notes) if (n.status === 'open') m.set(n.projectId, (m.get(n.projectId) ?? 0) + 1);
  return m;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const STATUSES: NoteStatus[] = ['open', 'resolved', 'accepted', 'rejected', 'deleted'];

/** Reads notes defensively; anything malformed is dropped. */
export function sanitizeNotes(raw: unknown): Note[] {
  const out: Note[] = [];
  const seen = new Set<string>();
  for (const x of Array.isArray(raw) ? raw : []) {
    const n = x as Partial<Note> | null;
    if (!n || !isStr(n.id) || seen.has(n.id) || !isStr(n.body) || !isStr(n.author)) continue;
    seen.add(n.id);
    const t = n.target as Partial<NoteTarget> | null | undefined;
    const target: NoteTarget | null = t && isStr(t.module) && isStr(t.kind) && isStr(t.id)
      ? { module: t.module, kind: t.kind, id: t.id, ...(isStr(t.label) ? { label: t.label } : {}), ...(t.anchor && isStr(t.anchor.quote) ? { anchor: { quote: t.anchor.quote, prefix: String(t.anchor.prefix ?? ''), suffix: String(t.anchor.suffix ?? ''), start: Number(t.anchor.start) || 0 } } : {}) }
      : null;
    const now = new Date(0).toISOString();
    out.push({
      id: n.id,
      projectId: isStr(n.projectId) ? n.projectId : null,
      target,
      kind: n.kind === 'suggestion' ? 'suggestion' : 'comment',
      body: n.body,
      ...(n.kind === 'suggestion' && typeof n.replacement === 'string' ? { replacement: n.replacement } : {}),
      status: STATUSES.includes(n.status as NoteStatus) ? (n.status as NoteStatus) : 'open',
      ...(normalizeCategory(n.category) ? { category: normalizeCategory(n.category) } : {}),
      ...(n.origin === 'ai' || n.origin === 'human' ? { origin: n.origin } : {}),
      author: n.author,
      createdAt: isStr(n.createdAt) ? n.createdAt : now,
      updatedAt: isStr(n.updatedAt) ? n.updatedAt : isStr(n.createdAt) ? n.createdAt : now,
      replies: (Array.isArray(n.replies) ? n.replies : []).filter((r): r is NoteReply => !!r && isStr((r as NoteReply).id) && isStr((r as NoteReply).body) && isStr((r as NoteReply).author)).map((r) => ({ id: r.id, author: r.author, createdAt: isStr(r.createdAt) ? r.createdAt : now, body: r.body }))
    });
  }
  return out;
}

/** A note as the studio-wide list shows it: stored notes, and notes a module keeps itself (Write's), told apart by `source`. */
export interface NoteView extends Note {
  /** `studio` notes can be changed here; `module` notes are read here and changed in their module. */
  source: 'studio' | 'module';
}
