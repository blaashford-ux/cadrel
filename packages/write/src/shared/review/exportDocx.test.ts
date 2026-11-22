import { describe, expect, it } from 'vitest'
import { importTracked } from '../trackedChanges'
import { buildReviewDocx } from './exportDocx'
import { makeAnchor, type ReviewItem } from './comments'
import { flattenMarkdown } from '../agent/flatten'

const CH1 = '# One\n\nShe walked *slowly* to the door.\n\n"Don\'t," he said.\n'
const CH2 = '# Two\n\nThe **river** ran cold.\n'

function note(ch: string, quote: string, o: Partial<ReviewItem>): ReviewItem {
  const flat = flattenMarkdown(ch)
  const start = flat.indexOf(quote)
  return { id: `n${Math.random()}`, kind: 'comment', file: 'Manuscript/Book.md', anchor: makeAnchor(flat, start, start + quote.length), body: '', status: 'open', author: 'Pat', createdAt: '2026-03-01T10:00:00Z', updatedAt: '2026-03-01T10:00:00Z', replies: [], ...o }
}

describe('buildReviewDocx', () => {
  it('puts comments and suggestions in as Word comments and tracked changes that read back as the same notes', async () => {
    const c = note(CH2, 'river', { body: 'Cold how?', editType: 'line' })
    const s = note(CH1, 'walked slowly', { kind: 'suggestion', replacement: 'crept', body: 'Stronger verb', category: 'word choice' })
    const r = await buildReviewDocx({ title: 'Book', chapters: [{ title: 'One', markdown: CH1 }, { title: 'Two', markdown: CH2 }], notes: [c, s], chapterOf: new Map([[s.id, 0], [c.id, 1]]) })
    expect(r.placed).toBe(2)
    expect(r.skipped).toBe(0)
    const back = importTracked(r.bytes)
    expect(back.markdown).toContain('She walked slowly to the door.')
    const sug = back.notes.find((n) => n.kind === 'suggestion')!
    expect(sug).toMatchObject({ quote: 'walked slowly', replacement: 'crept', author: 'Pat' })
    expect(sug.body).toBe('[word choice] Stronger verb') // the reason, not a second note
    const com = back.notes.filter((n) => n.kind === 'comment')
    expect(com.map((n) => [n.quote, n.body])).toEqual([['river', '[line] Cold how?']])
  })

  it('leaves out notes whose text is gone or that overlap an earlier one, and says how many', async () => {
    const a = note(CH2, 'river ran', { body: 'one' })
    const b = note(CH2, 'ran cold', { body: 'overlaps' })
    const gone = { ...note(CH2, 'river', { body: 'cut' }), anchor: { ...note(CH2, 'river', {}).anchor, gone: true } }
    const r = await buildReviewDocx({ title: 'Book', chapters: [{ title: 'Two', markdown: CH2 }], notes: [a, b, gone], chapterOf: new Map([[a.id, 0], [b.id, 0], [gone.id, 0]]) })
    expect(r.placed).toBe(1)
    expect(r.skipped).toBe(2)
  })
})
