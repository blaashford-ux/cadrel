import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WriteApi } from '../shared/api';
import {
  newReviewFile,
  normalizeCategory,
  type Anchor,
  parseReviewFile,
  serializeReviewFile,
  type ReviewFile,
  type ReviewItem
} from '../shared/review/comments';
import type { NoteChange, NoteMark, ReviewApi } from './reviewPlugin';

export interface Identity {
  id: string;
  name: string;
}

const KEY = 'cadrel-write.reviewer';

/** How often the review files are re-read, to pick up notes written by someone or something else. */
const POLL_MS = 4000;

/** Who is writing the notes on this device. The owner's own notes use the id "owner". */
export function loadIdentity(): Identity {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Identity | null;
    if (v && typeof v.id === 'string' && typeof v.name === 'string') return v;
  } catch {
    /* no storage: fall through */
  }
  return { id: 'owner', name: 'Me' };
}

export function saveIdentity(i: Identity): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(i));
  } catch {
    /* ignore */
  }
}

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export interface ShownItem extends ReviewItem {
  /** Whose file it lives in. */
  reviewerId: string;
  reviewerName: string;
}

export interface ReviewState {
  items: ShownItem[];
  /** The notes on every file of the project, not only the open one (the tree counts them per chapter). */
  all: ShownItem[];
  /** Notes that are not in the open chapter, or whose place can't be found. */
  detached: Set<string>;
  /** Notes shown at the start of their paragraph, because the text they were about has changed (or their place is not certain). */
  pinned: Set<string>;
  /** Gives old notes a place (chapter, paragraph, offset). Does not count as editing them. Resolves when saved. */
  upgrade(updates: { id: string; anchor: Anchor }[]): Promise<void>;
  /** Saves a note on a selection captured earlier with `selection()`. */
  add(sel: { anchor: Anchor; oneBlock: boolean }, kind: 'comment' | 'suggestion', body: string, replacement?: string, category?: string): void;
  /** Sets or (with an empty topic) clears a note's topic. */
  setCategory(id: string, category: string): Promise<void>;
  selection(): { anchor: Anchor; oneBlock: boolean } | null;
  setStatus(id: string, status: ReviewItem['status']): Promise<void>;
  reply(id: string, body: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Puts a suggestion's text into the chapter and marks it accepted; returns an error message if it can't. */
  accept(id: string): Promise<string | null>;
  focus(id: string): void;
  /** Reads the review files again (after another device's notes arrived). */
  reload(): void;
}

/**
 * The review notes for the open file: loaded from the project's review files, drawn in the editor, and saved back to
 * whichever reviewer's file each note lives in.
 */
export function useReview(
  api: Pick<WriteApi, 'listReviews' | 'saveReview'>,
  project: string | null,
  file: string | null,
  review: ReviewApi | undefined,
  me: Identity,
  chapterKey: string,
  /** The open chapter's key (`chapterKeys`), so notes are looked for in their own chapter and no other. */
  chapter?: string
): ReviewState {
  const [files, setFiles] = useState<Map<string, ReviewFile>>(new Map());
  const [detached, setDetached] = useState<Set<string>>(new Set());
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);
  const filesRef = useRef(files);
  filesRef.current = files;

  // What was last read from disk, and how many saves this app has made: a read that began before a save of ours
  // finished would bring back the old text, so it is dropped.
  // Edits to highlighted text not yet saved to the note; saved shortly after typing stops.
  const pending = useRef(new Map<string, NoteChange>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushRef = useRef<() => void>(() => undefined);
  const seen = useRef('');
  const saves = useRef(0);

  useEffect(() => {
    let live = true;
    if (!project) {
      setFiles(new Map());
      return;
    }
    const load = () => {
      const before = saves.current;
      void api
        .listReviews(project)
        .then((list) => {
          if (!live || saves.current !== before) return;
          const signature = list.map((f) => `${f.id}\u0000${f.text}`).join('\u0001');
          if (signature === seen.current) return;
          seen.current = signature;
          const m = new Map<string, ReviewFile>();
          for (const { id, text } of list) {
            const f = parseReviewFile(text);
            if (f) m.set(id, f);
          }
          setFiles(m);
        })
        .catch(() => undefined);
    };
    seen.current = '';
    load();
    // Notes added from outside (an AI reviewer, or the other side of a share) show up without a restart.
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) load();
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, project, tick]);

  useEffect(() => setFiles(new Map()), [project]);

  const items = useMemo<ShownItem[]>(() => {
    const out: ShownItem[] = [];
    for (const [id, f] of files) for (const i of f.items) if (i.file === file && i.status !== 'deleted') out.push({ ...i, reviewerId: id, reviewerName: f.reviewer.name });
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [files, file]);

  const all = useMemo<ShownItem[]>(() => {
    const out: ShownItem[] = [];
    for (const [id, f] of files) for (const i of f.items) if (i.status !== 'deleted') out.push({ ...i, reviewerId: id, reviewerName: f.reviewer.name });
    return out;
  }, [files]);

  // Draw the open notes in the editor (resolved and rejected ones fade out of the text).
  useEffect(() => {
    if (!review) return;
    const marks: NoteMark[] = items.filter((i) => i.status === 'open').map((i) => ({ id: i.id, anchor: pending.current.get(i.id)?.anchor ?? i.anchor, kind: i.kind }));
    const { detached: lost, pinned: kept } = review.setNotes(marks, chapter);
    setDetached(new Set(lost));
    setPinned(new Set(kept));
  }, [review, items, chapterKey, chapter]);

  const write = useCallback(
    async (reviewerId: string, change: (f: ReviewFile) => ReviewFile) => {
      if (!project) return;
      const current = filesRef.current.get(reviewerId) ?? newReviewFile(project, { id: me.id, name: me.name });
      const next = change(current);
      saves.current += 1;
      setFiles((prev) => new Map(prev).set(reviewerId, next));
      filesRef.current = new Map(filesRef.current).set(reviewerId, next);
      try {
        await api.saveReview(project, reviewerId, serializeReviewFile(next));
      } finally {
        saves.current += 1; // reads that started while this save was in flight are stale
      }
    },
    [api, project, me.id, me.name]
  );

  const upgrade = useCallback(
    async (updates: { id: string; anchor: Anchor }[]) => {
      const byId = new Map(updates.map((u) => [u.id, u.anchor]));
      const owners = [...filesRef.current].filter(([, f]) => f.items.some((i) => byId.has(i.id)));
      for (const [owner] of owners) await write(owner, (f) => ({ ...f, items: f.items.map((i) => (byId.has(i.id) ? { ...i, anchor: byId.get(i.id)! } : i)) }));
    },
    [write]
  );

  const ownerOf = (id: string) => items.find((i) => i.id === id)?.reviewerId;
  const touch = (i: ReviewItem, patch: Partial<ReviewItem>): ReviewItem => ({ ...i, ...patch, updatedAt: new Date().toISOString() });
  const edit = (id: string, patch: (i: ReviewItem) => ReviewItem) => {
    const owner = ownerOf(id);
    if (!owner) return Promise.resolve();
    return write(owner, (f) => ({ ...f, items: f.items.map((i) => (i.id === id ? patch(i) : i)) }));
  };

  // Editing a note's text keeps the note on the edited text; deleting all of it resolves the note, which stays at that spot. A change of
  // only where the note is (its text as it was) is kept without counting as an edit of the note. One save per reviewer's file.
  flushRef.current = () => {
    flushTimer.current = null;
    const batch = [...pending.current.values()];
    pending.current.clear();
    const byOwner = new Map<string, Map<string, NoteChange>>();
    for (const c of batch) {
      const owner = filesRef.current && [...filesRef.current].find(([, f]) => f.items.some((i) => i.id === c.id))?.[0];
      if (owner) byOwner.set(owner, (byOwner.get(owner) ?? new Map()).set(c.id, c));
    }
    for (const [owner, changes] of byOwner) {
      void write(owner, (f) => ({
        ...f,
        items: f.items.map((i) => {
          const c = changes.get(i.id);
          if (!c) return i;
          if (c.place) return { ...i, anchor: c.anchor };
          if (c.gone) return touch(i, { anchor: { ...c.anchor, quote: i.anchor.quote, gone: true }, status: 'resolved' });
          return touch(i, { anchor: c.anchor });
        })
      }));
    }
  };
  useEffect(() => {
    if (!review) return;
    review.onChanges((changes) => {
      for (const c of changes) pending.current.set(c.id, c);
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = setTimeout(() => flushRef.current(), 400);
    });
    return () => {
      review.onChanges(null);
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushRef.current();
      }
    };
  }, [review]);

  return {
    items,
    all,
    detached,
    pinned,
    upgrade,
    selection: () => review?.selection() ?? null,
    add(sel, kind, body, replacement, category) {
      if (!file || (kind === 'suggestion' && !sel.oneBlock)) return;
      const now = new Date().toISOString();
      const item: ReviewItem = {
        id: uid(),
        kind,
        file,
        anchor: sel.anchor,
        body,
        ...(kind === 'suggestion' ? { replacement: replacement ?? '' } : {}),
        status: 'open',
        ...(normalizeCategory(category) ? { category: normalizeCategory(category) } : {}),
        author: me.name,
        createdAt: now,
        updatedAt: now,
        replies: []
      };
      void write(me.id, (f) => ({ ...f, reviewer: { id: me.id, name: me.name }, items: [...f.items, item] }));
    },
    setCategory: (id, category) =>
      edit(id, (i) => {
        const { category: _old, ...rest } = i;
        const next = normalizeCategory(category);
        return touch(next ? { ...rest, category: next } : rest, {});
      }),
    setStatus: (id, status) => edit(id, (i) => touch(i, { status })),
    reply: (id, body) =>
      edit(id, (i) => touch(i, { replies: [...i.replies, { id: uid(), author: me.name, createdAt: new Date().toISOString(), body }] })),
    remove: (id) => edit(id, (i) => touch(i, { status: 'deleted' })),
    async accept(id) {
      const item = items.find((i) => i.id === id);
      if (!item || item.kind !== 'suggestion' || item.replacement === undefined) return 'That is not a suggestion.';
      if (!review?.replace(id, item.replacement)) return 'The text has changed since this was suggested, so it can’t be applied here.';
      await edit(id, (i) => touch(i, { status: 'accepted' }));
      return null;
    },
    focus: (id) => void review?.reveal(id),
    reload: () => setTick((t) => t + 1)
  };
}
