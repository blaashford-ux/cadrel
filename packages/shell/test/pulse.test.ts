import { describe, expect, it } from 'vitest';
import { buildPulse } from '../src/main/pulse';
import type { CatalogueBookRow, CatalogueList, PlanState } from '../src/shared/api';

const TODAY = '2026-11-10';
const task = (id: string, title: string, due: string | null, over: Record<string, unknown> = {}) => ({ id, projectId: 'b1', projectName: 'Book 1', kind: 'task', title, notes: '', assigneeId: 'me', due, state: 'open', doneAt: null, dependsOn: [], createdAt: '', createdBy: 'me', updatedAt: '', ...over });
const stages = [{ key: 'planning', name: 'Planning', color: '#111111', category: 'start' }, { key: 'done', name: 'Published', color: '#222222', category: 'done' }];
const plan = (over: Partial<Extract<PlanState, { available: true }>> = {}): PlanState => ({
  available: true, me: 'me', today: TODAY, people: [{ id: 'me', name: 'Ana' }], workflows: [{ id: 'w', name: 'Writing', stages }],
  projects: [
    { id: 's', name: 'Series', path: [], kind: 'Series', workflowId: 'w', stage: 'planning', openTasks: 0, late: 0, nextDue: null },
    { id: 'b1', name: 'Book 1', path: ['Series'], kind: 'Book', workflowId: 'w', stage: 'planning', openTasks: 3, late: 1, nextDue: '2026-11-01' },
    { id: 'b2', name: 'Book 2', path: ['Series'], kind: 'Book', workflowId: 'w', stage: 'done', openTasks: 0, late: 0, nextDue: null }],
  tasks: [
    task('1', 'Late B', '2026-11-05'), task('2', 'Late A', '2026-11-01'), task('3', 'Soon', '2026-11-20'), task('4', 'Far', '2027-01-01'), task('5', 'No date', null),
    task('6', 'Finished', '2026-11-08', { state: 'done', doneAt: '2026-11-08T10:00:00.000Z' }), task('7', 'Old finish', '2026-10-01', { state: 'done', doneAt: '2026-10-02T10:00:00.000Z' })] as never,
  ...over
});
const book = (id: string, over: Partial<CatalogueBookRow> = {}): CatalogueBookRow => ({ bookId: id, title: id, subtitle: '', penName: '', seriesId: null, seriesName: null, position: null, editions: [], asin: null, market: null, projectId: null, projectName: null, stage: null, stageColor: null, stageCategory: null, words: null, goalWords: null, ...over });
const money = (month: string, usd: number, state: 'final' | 'estimated' | 'pending' = 'final') => ({ asin: 'x', title: 'x', penNames: [], authors: [], captured: true, overallRank: null, listRank: null, kindlePrice: null, ratingValue: null, ratingCount: null, money: { paidUnits: 1, kenpPages: 0, lastSaleDay: null, lastMonth: month, lastMonthUsd: usd, lastMonthState: state } });
const cat = (books: CatalogueBookRow[], over: Partial<CatalogueList> = {}): CatalogueList => ({ available: true, marketAvailable: true, financeVisible: true, may: { create: true, edit: true, archive: true }, series: [], books, unlisted: [], projects: [], ...over });

describe('the studio at a glance', () => {
  it('counts work: late, due in the next fortnight, open, and finished this week', () => {
    const p = buildPulse({ plan: plan(), approvals: [], decisions: [], catalogue: cat([]) });
    if (!p.available) throw new Error('expected a pulse');
    expect(p.work).toEqual({ open: 5, late: 2, dueSoon: 1, approvalsPending: 0, doneThisWeek: 1 });
    expect(p.late.map((t) => t.title)).toEqual(['Late A', 'Late B']); // oldest first
    expect(p.upcoming.map((t) => t.title)).toEqual(['Soon']);
  });

  it('counts projects in each stage of each workflow', () => {
    const p = buildPulse({ plan: plan(), approvals: [], decisions: [], catalogue: cat([]) });
    if (!p.available) throw new Error('x');
    expect(p.pipeline).toEqual([{ id: 'w', name: 'Writing', total: 3, stages: [expect.objectContaining({ key: 'planning', count: 2 }), expect.objectContaining({ key: 'done', count: 1 })] }]);
  });

  it('lists sign-offs waiting, with who has not answered, and the latest decisions', () => {
    const approvals = [
      { id: 'a1', projectId: 'b1', projectName: 'Book 1', label: 'Cover', state: 'pending', approvers: [{ personId: 'me', response: null }, { personId: 'bo', response: 'approved' }] },
      { id: 'a2', projectId: 'b1', projectName: 'Book 1', label: 'Old', state: 'approved', approvers: [] }] as never;
    const decisions = Array.from({ length: 7 }, (_, i) => ({ id: `d${i}`, title: `T${i}`, outcome: 'ok', projectId: 'b1', projectName: 'Book 1', decidedAt: '2026-11-01' })) as never;
    const p = buildPulse({ plan: plan(), approvals, decisions, catalogue: cat([]) });
    if (!p.available) throw new Error('x');
    expect(p.work.approvalsPending).toBe(1);
    expect(p.approvals).toEqual([{ id: 'a1', label: 'Cover', projectId: 'b1', projectName: 'Book 1', waiting: ['me'] }]);
    expect(p.decisions).toHaveLength(5);
  });

  it('summarises the catalogue: published, not yet, in production, series, books Market knows that it lacks, and last month’s royalties', () => {
    const books = [
      book('a', { asin: 'B0AAAAAAA1', seriesId: 's1', projectId: 'p1', stage: 'Drafting', stageCategory: 'active', market: money('2026-10', 100.5) }),
      book('b', { asin: 'B0BBBBBBB2', seriesId: 's1', projectId: 'p2', stage: 'Published', stageCategory: 'done', market: money('2026-10', 50, 'estimated') }),
      book('c', { market: null }), book('d', { asin: 'B0DDDDDDD4', market: money('2026-09', 999) })];
    const p = buildPulse({ plan: plan(), approvals: [], decisions: [], catalogue: cat(books, { unlisted: [{ asin: 'B0ZZZZZZZZ', title: 'Old', penNames: [] }] }) });
    if (!p.available) throw new Error('x');
    expect(p.books).toEqual({ total: 4, published: 3, unpublished: 1, series: 1, inProduction: 1, unlisted: 1, money: { month: '2026-10', usd: 150.5, estimated: true } }); // September's book is not in October's figure
  });

  it('leaves money out when the role may not see it, and copes with no catalogue records', () => {
    const books = [book('a', { asin: 'B0AAAAAAA1', market: money('2026-10', 100) })];
    const hidden = buildPulse({ plan: plan(), approvals: [], decisions: [], catalogue: cat(books, { financeVisible: false }) });
    if (!hidden.available) throw new Error('x');
    expect(hidden.books.money).toBeNull();
    const none = buildPulse({ plan: plan(), approvals: [], decisions: [], catalogue: cat([], { available: false }) });
    if (!none.available) throw new Error('x');
    expect(none.books).toMatchObject({ total: 0, money: null });
    expect(buildPulse({ plan: { available: false, reason: 'owner' }, approvals: [], decisions: [], catalogue: cat([]) })).toEqual({ available: false, reason: 'owner' });
  });
});
