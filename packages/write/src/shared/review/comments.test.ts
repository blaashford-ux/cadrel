import { describe, expect, it } from 'vitest'
import {
  applySuggestion,
  locateAnchor,
  makeAnchor,
  mergeReviewFiles,
  newReviewFile,
  parseReviewFile,
  serializeReviewFile,
  type ReviewItem,
} from './comments'

const text = 'The cat sat. The dog sat. The cat ran.'

function item(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: 'a',
    kind: 'comment',
    file: 'Ch 1.md',
    anchor: makeAnchor(text, 0, 7),
    body: 'hmm',
    status: 'open',
    author: 'Sam',
    createdAt: '2026-10-07T10:00:00Z',
    updatedAt: '2026-10-07T10:00:00Z',
    replies: [],
    ...over,
  }
}

describe('anchors', () => {
  it('finds the quote where it was written', () => {
    const a = makeAnchor(text, 26, 33)
    expect(a.quote).toBe('The cat')
    expect(locateAnchor(text, a)).toEqual({ start: 26, end: 33 })
  })

  it('follows the quote when text is inserted before it', () => {
    const a = makeAnchor(text, 26, 33)
    const edited = 'Intro. ' + text
    expect(locateAnchor(edited, a)).toEqual({ start: 33, end: 40 })
  })

  it('tells repeated phrases apart by their surroundings', () => {
    const a = makeAnchor(text, 26, 33) // the second "The cat"
    const edited = 'x'.repeat(50) + text
    expect(locateAnchor(edited, a)?.start).toBe(76)
  })

  it('reports a detached note when the quote is gone', () => {
    expect(locateAnchor('Nothing alike here.', makeAnchor(text, 0, 7))).toBeNull()
  })
})

describe('suggestions', () => {
  it('replaces the quoted text', () => {
    const s = item({ kind: 'suggestion', replacement: 'A bird', anchor: makeAnchor(text, 13, 20) })
    expect(applySuggestion(text, s)).toBe('The cat sat. A bird sat. The cat ran.')
  })

  it('refuses when the text has changed under it, and for plain comments', () => {
    const s = item({ kind: 'suggestion', replacement: 'x' })
    expect(applySuggestion('gone', s)).toBeNull()
    expect(applySuggestion(text, item())).toBeNull()
  })
})

describe('files', () => {
  it('round-trips and survives garbage', () => {
    const f = newReviewFile('Novel', { id: 'u1', name: 'Sam' })
    f.items.push(item())
    expect(parseReviewFile(serializeReviewFile(f))).toEqual(f)
    expect(parseReviewFile('not json')).toBeNull()
    expect(parseReviewFile('{"version":99,"reviewer":{"id":"x"},"project":"p"}')).toBeNull()
  })

  it('drops malformed items but keeps the rest', () => {
    const raw = JSON.stringify({ version: 1, reviewer: { id: 'u', name: 'S' }, project: 'p', items: [item(), { nope: 1 }] })
    expect(parseReviewFile(raw)?.items).toHaveLength(1)
  })

  it('merges two copies: newer item wins, replies are united', () => {
    const base = newReviewFile('p', { id: 'u', name: 'S' })
    const mine = { ...base, items: [item({ replies: [{ id: 'r1', author: 'S', createdAt: '1', body: 'x' }] })] }
    const theirs = {
      ...base,
      items: [
        item({
          status: 'resolved',
          updatedAt: '2026-10-07T11:00:00Z',
          replies: [{ id: 'r2', author: 'Owner', createdAt: '2', body: 'done' }],
        }),
        item({ id: 'b', createdAt: '2026-10-07T12:00:00Z', updatedAt: '2026-10-07T12:00:00Z' }),
      ],
    }
    const merged = mergeReviewFiles(mine, theirs)
    expect(merged.items.map((i) => i.id)).toEqual(['a', 'b'])
    expect(merged.items[0].status).toBe('resolved')
    expect(merged.items[0].replies.map((r) => r.id)).toEqual(['r1', 'r2'])
  })
})
