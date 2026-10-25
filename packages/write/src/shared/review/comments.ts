// The review file: one JSON file per reviewer holding their comments and suggestions on a
// shared project. Pure functions only, so the same code runs on Windows and on the phone.

export const REVIEW_VERSION = 1

export interface Anchor {
  /** The exact text the note is about. */
  quote: string
  /** A little text either side, to tell repeated phrases apart. */
  prefix: string
  suffix: string
  /** Where it was when written; a hint, not the truth (the text may have moved). */
  start: number
  /** The quoted text was edited away entirely; the note stays at this spot (between `prefix` and `suffix`) and is resolved. */
  gone?: boolean
}

export interface Reply {
  id: string
  author: string
  createdAt: string
  body: string
}

/** `deleted` is kept (not removed) so the deletion travels to the other side when files are merged. */
export type ItemStatus = 'open' | 'resolved' | 'accepted' | 'rejected' | 'deleted'

export interface ReviewItem {
  id: string
  kind: 'comment' | 'suggestion'
  /** Project-relative path of the file the note is on. */
  file: string
  anchor: Anchor
  body: string
  /** Suggestions only: the text that should replace the quote. */
  replacement?: string
  status: ItemStatus
  /** What kind of point it makes (e.g. "pacing", "spelling"); set by AI reviewers, shown as a chip. Optional. */
  category?: string
  /** Who made it. Absent means a person. */
  origin?: 'human' | 'ai'
  author: string
  createdAt: string
  updatedAt: string
  replies: Reply[]
}

/** Topics offered as suggestions in the Notes panel, besides any already used in the project. */
export const STANDARD_TOPICS = ['pacing', 'continuity', 'dialogue', 'character', 'plot', 'style', 'rhythm', 'clarity', 'spelling', 'grammar', 'punctuation', 'research']

export const CATEGORY_MAX = 40

/** A topic as stored: trimmed, lower case, one line, at most CATEGORY_MAX characters. Undefined when there is nothing left. */
export function normalizeCategory(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const t = raw.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, CATEGORY_MAX).trim()
  return t || undefined
}

export interface ReviewFile {
  version: number
  reviewer: { id: string; name: string }
  project: string
  items: ReviewItem[]
}

const CONTEXT = 40

export function makeAnchor(text: string, start: number, end: number): Anchor {
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(end, end + CONTEXT),
    start,
  }
}

/** All places the quote occurs, best match first. Null when the text no longer contains it. */
export function locateAnchor(text: string, a: Anchor): { start: number; end: number } | null {
  if (a.gone) {
    const i = text.indexOf(a.prefix + a.suffix)
    return i === -1 ? null : { start: i + a.prefix.length, end: i + a.prefix.length }
  }
  if (!a.quote) return null
  if (text.startsWith(a.quote, a.start)) {
    const here = score(text, a, a.start)
    // Unchanged around it: no need to look further.
    if (here === 2) return { start: a.start, end: a.start + a.quote.length }
  }
  let best: { start: number; score: number; dist: number } | null = null
  for (let i = text.indexOf(a.quote); i !== -1; i = text.indexOf(a.quote, i + 1)) {
    const s = score(text, a, i)
    const dist = Math.abs(i - a.start)
    if (!best || s > best.score || (s === best.score && dist < best.dist)) best = { start: i, score: s, dist }
  }
  return best ? { start: best.start, end: best.start + a.quote.length } : null
}

function score(text: string, a: Anchor, at: number): number {
  const before = text.slice(Math.max(0, at - a.prefix.length), at)
  const after = text.slice(at + a.quote.length, at + a.quote.length + a.suffix.length)
  return (before === a.prefix ? 1 : 0) + (after === a.suffix ? 1 : 0)
}

/** The text with the suggestion applied, or null if the quote can't be found any more. */
export function applySuggestion(text: string, item: ReviewItem): string | null {
  if (item.kind !== 'suggestion' || item.replacement === undefined) return null
  const at = locateAnchor(text, item.anchor)
  if (!at) return null
  return text.slice(0, at.start) + item.replacement + text.slice(at.end)
}

export function newReviewFile(project: string, reviewer: { id: string; name: string }): ReviewFile {
  return { version: REVIEW_VERSION, reviewer, project, items: [] }
}

/** Reads a review file; anything malformed becomes an empty file rather than an error. */
export function parseReviewFile(raw: string): ReviewFile | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const d = data as Partial<ReviewFile>
  if (typeof d.version !== 'number' || d.version > REVIEW_VERSION) return null
  if (!d.reviewer || typeof d.reviewer.id !== 'string' || typeof d.project !== 'string') return null
  const items = Array.isArray(d.items) ? d.items.filter(validItem) : []
  return { version: REVIEW_VERSION, reviewer: { id: d.reviewer.id, name: String(d.reviewer.name ?? '') }, project: d.project, items }
}

function validItem(i: unknown): i is ReviewItem {
  if (!i || typeof i !== 'object') return false
  const x = i as Partial<ReviewItem>
  return (
    typeof x.id === 'string' &&
    (x.kind === 'comment' || x.kind === 'suggestion') &&
    typeof x.file === 'string' &&
    !!x.anchor &&
    typeof x.anchor.quote === 'string' &&
    typeof x.body === 'string' &&
    typeof x.updatedAt === 'string'
  )
}

export function serializeReviewFile(f: ReviewFile): string {
  return JSON.stringify(f, null, 2) + '\n'
}

/**
 * Combines two copies of the same reviewer's file (the reviewer and the owner both write
 * to it). Items are matched by id; the newer `updatedAt` wins, and replies are united.
 */
export function mergeReviewFiles(a: ReviewFile, b: ReviewFile): ReviewFile {
  const byId = new Map<string, ReviewItem>()
  for (const item of [...a.items, ...b.items]) {
    const have = byId.get(item.id)
    if (!have) {
      byId.set(item.id, item)
      continue
    }
    const [newer, older] = item.updatedAt >= have.updatedAt ? [item, have] : [have, item]
    const replies = new Map<string, Reply>()
    for (const r of [...older.replies, ...newer.replies]) replies.set(r.id, r)
    byId.set(item.id, {
      ...newer,
      replies: [...replies.values()].sort((x, y) => x.createdAt.localeCompare(y.createdAt)),
    })
  }
  const items = [...byId.values()].sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id))
  return { ...a, items }
}
