import { describe, expect, it } from 'vitest'
import { autoSummary, computeStats, embedReport, emptyReport, extractReport, renderReportHtml, renderReportMarkdown } from './editingReport'
import type { ReviewItem } from './comments'

let n = 0
const item = (o: Partial<ReviewItem>): ReviewItem => ({ id: `i${++n}`, kind: 'comment', file: 'Manuscript/Book.md', anchor: { quote: 'q', prefix: '', suffix: '', start: 0 }, body: 'a point', status: 'open', author: 'Pat', createdAt: '2026-03-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z', replies: [], ...o })
const chapters = [{ title: 'One' }, { title: 'Two' }]

describe('editing report', () => {
  const items = [
    item({ category: 'pacing', editType: 'developmental', round: 'First read' }),
    item({ category: 'pacing', kind: 'suggestion', replacement: 'x', status: 'accepted', editType: 'line', round: 'First read' }),
    item({ kind: 'suggestion', replacement: 'y', status: 'rejected', origin: 'ai', editType: 'line', round: 'Second read' }),
    item({ status: 'resolved', origin: 'outside' }),
    item({ status: 'deleted' }),
    item({ file: 'elsewhere' })
  ]
  const chapterOf = new Map(items.slice(0, 5).map((i, k) => [i.id, k < 3 ? 0 : 1]))

  it('counts the notes by status, kind, type, source, round and chapter, leaving out deleted ones and other files', () => {
    const s = computeStats(items, chapters, chapterOf)
    expect(s.total).toBe(4)
    expect(s.byStatus).toEqual({ open: 1, accepted: 1, rejected: 1, resolved: 1 })
    expect(s.byKind).toEqual({ comment: 2, suggestion: 2 })
    expect(s.byEditType).toEqual({ developmental: 1, line: 2, untagged: 1 })
    expect(s.bySource).toEqual({ human: 2, ai: 1, outside: 1 })
    expect(s.byRound).toEqual({ 'First read': 2, 'Second read': 1, 'No round': 1 })
    expect(s.suggestions).toEqual({ open: 0, accepted: 1, rejected: 1 })
    expect(s.perChapter.map((c) => c.count)).toEqual([3, 1])
    expect(s.themes[0]).toMatchObject({ topic: 'pacing', count: 2 })
    expect(s.open).toHaveLength(1)
  })

  it('counts only one round when asked', () => {
    expect(computeStats(items, chapters, chapterOf, 'first READ').total).toBe(2)
  })

  it('writes a summary from the numbers, and says so plainly when there are no notes', () => {
    const data = emptyReport('Book', 'Sam', '2026-03-05T00:00:00Z')
    expect(autoSummary(computeStats(items, chapters, chapterOf), data)).toMatch(/4 notes on Book.*1 are still open.*50% were accepted.*pacing/)
    expect(autoSummary(computeStats([], chapters, new Map()), data)).toBe('There are no notes on Book yet.')
  })

  it('keeps what the editor typed, and shows the automatic summary only when there is none', () => {
    const s = computeStats(items, chapters, chapterOf)
    const data = { ...emptyReport('Book', 'Sam', '2026-03-05T00:00:00Z'), sections: [{ id: 's1', title: 'Overall', body: 'Strong voice.\n\n- Trim chapter two\n- Check the timeline' }] }
    const md = renderReportMarkdown(data, s)
    expect(md).toContain('## Summary\n\n4 notes on Book')
    expect(md).toContain('## Overall\n\nStrong voice.')
    const typed = renderReportMarkdown({ ...data, summary: 'My own words.' }, s)
    expect(typed).toContain('## Summary\n\nMy own words.')
    expect(typed).not.toContain('4 notes on Book')
  })

  it('stores the typed part in the Markdown file and reads it back, and rejects damage', () => {
    const data = { ...emptyReport('Book', 'Sam', '2026-03-05T00:00:00Z'), round: 'First read', summary: 'It -- works', sections: [{ id: 's1', title: 'T', body: 'B' }] }
    const text = embedReport(renderReportMarkdown(data, computeStats([], chapters, new Map())), data)
    expect(extractReport(text)).toEqual(data)
    expect(extractReport(embedReport(embedReport('x', data), { ...data, summary: 'new' }))!.summary).toBe('new') // replaced, not stacked
    expect(extractReport('no data here')).toBeNull()
    expect(extractReport('<!-- cadrel-editing-report {not json} -->')).toBeNull()
  })

  it('makes a printable page that escapes what was typed', () => {
    const data = { ...emptyReport('Book <1>', 'Sam', '2026-03-05T00:00:00Z'), sections: [{ id: 's', title: 'A & B', body: '<script>x</script>' }] }
    const html = renderReportHtml(data, computeStats(items, chapters, chapterOf))
    expect(html).toContain('Book &lt;1&gt;')
    expect(html).toContain('A &amp; B')
    expect(html).not.toContain('<script>')
    expect(html).toContain('@page')
  })
})
