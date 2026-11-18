import { describe, expect, it } from 'vitest';
import { buildLens, loadLens, type LensSources } from '../src/main/lens';
import type { EditingPassRow, EditingState, PlanState } from '../src/shared/api';

const TODAY = '2026-11-16';
const zero = { open: 0, answered: 0, resolved: 0, withdrawn: 0 };
const pass = (o: Partial<EditingPassRow> & { id: string }): EditingPassRow =>
  ({ projectId: 'b1', projectName: 'Lead Me', kind: 'line', title: 'Line edit', fileId: 'f', filePath: 'book.md', fileVersion: 1, briefId: null, briefVersion: null, editorId: 'eve', editorName: 'Eve', state: 'delivered', createdAt: '2026-11-01T00:00:00Z', createdBy: 'eve', startedAt: null, deliveredAt: '2026-11-06T00:00:00Z', respondedAt: null, closedAt: null, closedBy: null, updatedAt: '2026-11-06T00:00:00Z', counts: zero, unanswered: 0, undecided: 0, next: null, ...o }) as EditingPassRow;
const task = (o: { id: string; title?: string; kind?: 'task' | 'deadline'; due: string | null; projectId?: string; projectName?: string; assigneeId?: string | null; state?: 'open' | 'done' }) =>
  ({ title: 'T', kind: 'task', projectId: 'b1', projectName: 'Lead Me', assigneeId: null, state: 'open', ...o }) as never;

describe('the Director’s view: late books and unanswered queries', () => {
  const passes = [
    pass({ id: 'p1', projectId: 'b1', projectName: 'Lead Me', unanswered: 3, deliveredAt: '2026-11-04T00:00:00Z' }), // 12 days
    pass({ id: 'p2', projectId: 'b1', projectName: 'Lead Me', unanswered: 2, deliveredAt: '2026-11-14T00:00:00Z' }), // 2 days, same book
    pass({ id: 'p3', projectId: 'b2', projectName: 'Follow Me', unanswered: 1, deliveredAt: '2026-11-13T00:00:00Z' }), // 3 days
    pass({ id: 'p4', projectId: 'b3', projectName: 'Answered', unanswered: 0 }), // nothing waiting
    pass({ id: 'p5', projectId: 'b4', projectName: 'Under way', state: 'in_progress', unanswered: 4, deliveredAt: null }), // not delivered yet: not waiting on an author
    pass({ id: 'p6', projectId: 'b5', projectName: 'Closed', state: 'closed', unanswered: 9 })
  ];
  const tasks = [
    task({ id: 't1', kind: 'deadline', title: 'Manuscript to the editor', due: '2026-11-10', projectId: 'b1', projectName: 'Lead Me' }), // 6 days late
    task({ id: 't2', kind: 'deadline', title: 'Cover final', due: '2026-11-15', projectId: 'b1', projectName: 'Lead Me' }), // 1 day late, same book
    task({ id: 't3', kind: 'deadline', title: 'Blurb', due: '2026-11-12', projectId: 'b2', projectName: 'Follow Me' }), // 4 days late
    task({ id: 't4', kind: 'deadline', title: 'Launch', due: '2026-11-16', projectId: 'b3', projectName: 'Answered' }), // today: not late
    task({ id: 't5', kind: 'deadline', title: 'Later', due: '2026-12-01', projectId: 'b3', projectName: 'Answered' }),
    task({ id: 't6', kind: 'task', title: 'A plain late task', due: '2026-11-01', projectId: 'b4', projectName: 'Under way' }), // a task, not a deadline
    task({ id: 't7', kind: 'deadline', title: 'Already done', due: '2026-11-01', projectId: 'b5', projectName: 'Closed', state: 'done' })
  ];
  const v = buildLens(['director'], { me: 'dana', today: TODAY, passes, tasks }).director!;

  it('lists a book once with every open deadline past its date, the worst first', () => {
    expect(v.lateBooks.map((b) => [b.name, b.daysLate])).toEqual([['Lead Me', 6], ['Follow Me', 4]]);
    expect(v.lateBooks[0]!.deadlines.map((d) => [d.title, d.daysLate])).toEqual([['Manuscript to the editor', 6], ['Cover final', 1]]);
    expect(v.totals.lateBooks).toBe(2);
  });
  it('lists books whose delivered passes have unanswered queries, the longest wait first, and ignores passes that are not delivered or are closed', () => {
    expect(v.unanswered).toEqual([
      { projectId: 'b1', name: 'Lead Me', queries: 5, passes: 2, oldestDays: 12 },
      { projectId: 'b2', name: 'Follow Me', queries: 1, passes: 1, oldestDays: 3 }
    ]);
    expect(v.totals.unansweredQueries).toBe(6);
  });
  it('carries how many canon proposals wait on the Director, and none when it is not known', () => {
    expect(buildLens(['director'], { me: 'dana', today: TODAY, passes, tasks, canonWaiting: 3 }).director!.canonWaiting).toBe(3);
    expect(buildLens(['director'], { me: 'dana', today: TODAY, passes, tasks }).director!.canonWaiting).toBe(0);
  });
  it('builds only the views asked for', () => {
    expect(Object.keys(buildLens(['director'], { me: 'dana', today: TODAY, passes, tasks }))).toEqual(['director']);
  });
});

describe('the Editor’s view', () => {
  it('lists their own passes by what they have to do, and counts the author’s answers', () => {
    const v = buildLens(['editor'], {
      me: 'eve', today: TODAY, tasks: [],
      passes: [
        pass({ id: 'a', state: 'planned', createdAt: '2026-11-14T00:00:00Z', deliveredAt: null }),
        pass({ id: 'b', state: 'in_progress', deliveredAt: null, createdAt: '2026-11-10T00:00:00Z' }),
        pass({ id: 'c', state: 'delivered', counts: { ...zero, answered: 2 }, unanswered: 1 }),
        pass({ id: 'd', state: 'delivered', editorId: 'someone-else', counts: { ...zero, answered: 5 } }), // not theirs
        pass({ id: 'e', state: 'closed' })
      ]
    }).editor!;
    expect(v.toStart.map((p) => p.passId)).toEqual(['a']);
    expect(v.toDeliver.map((p) => p.passId)).toEqual(['b']);
    expect(v.withAuthor.map((p) => [p.passId, p.waitingDays])).toEqual([['c', 10]]);
    expect(v.answered).toBe(2);
  });
});

describe('the Author’s view', () => {
  it('lists what the service says waits on them, and only their own dates that are late or within a week', () => {
    const v = buildLens(['author'], {
      me: 'ann', today: TODAY,
      passes: [
        pass({ id: 'q', next: 'answer', unanswered: 2, undecided: 3 }),
        pass({ id: 'r', next: 'respond', projectName: 'Ready' }),
        pass({ id: 'x', next: null }), // delivered but nothing for this person to do
        pass({ id: 'y', next: 'deliver', state: 'in_progress' })
      ],
      tasks: [
        task({ id: 'a', title: 'Mine, late', due: '2026-11-12', assigneeId: 'ann' }),
        task({ id: 'b', title: 'Mine, soon', due: '2026-11-20', assigneeId: 'ann' }),
        task({ id: 'c', title: 'Mine, far off', due: '2026-12-25', assigneeId: 'ann' }),
        task({ id: 'd', title: 'Someone else’s', due: '2026-11-12', assigneeId: 'eve' })
      ]
    }).author!;
    expect(v.answer.map((p) => [p.passId, p.unanswered, p.undecided])).toEqual([['q', 2, 3]]);
    expect(v.respond.map((p) => p.passId)).toEqual(['r']);
    expect(v.tasks.map((t) => [t.title, t.daysLate])).toEqual([['Mine, late', 4], ['Mine, soon', -4]]);
  });
});

describe('which views a person gets, and what it costs', () => {
  const editing = { available: true, me: 'x', may: { run: true, assign: true, respond: true, approve: true }, passes: [pass({ id: 'p1', unanswered: 2 })], offline: null } as EditingState;
  const plan = { available: true, me: 'x', today: TODAY, people: [], workflows: [], projects: [], tasks: [] } as PlanState;
  const sources = (caps: string[], calls: string[]): LensSources => ({
    mayAnywhere: async (c) => caps.includes(c),
    editing: async () => (calls.push('editing'), editing),
    plan: async () => (calls.push('plan'), plan)
  });

  it('reads nothing for a role that has no working view, so its Home is unchanged and costs the Studio nothing', async () => {
    const calls: string[] = [];
    expect(await loadLens(sources([], calls), 'x', TODAY)).toEqual({ available: true, today: TODAY, lenses: [], views: {} });
    expect(calls).toEqual([]);
  });
  it('gives the Owner every view, the Director’s first', async () => {
    const s = await loadLens(sources(['roles.manage', 'edit.approve', 'edit.run', 'manuscript.write'], []), 'x', TODAY);
    expect(s.available && s.lenses).toEqual(['director', 'editor', 'author']);
    expect(s.available && Object.keys(s.views).sort()).toEqual(['author', 'director', 'editor']);
  });
  it('gives an Author only the Author’s view', async () => {
    const s = await loadLens(sources(['manuscript.write'], []), 'x', TODAY);
    expect(s.available && Object.keys(s.views)).toEqual(['author']);
  });
  it('treats a role that may not read editorial passes or the plan as having none there, not as an error', async () => {
    const s = await loadLens({ mayAnywhere: async (c) => c === 'roles.manage', editing: async () => ({ available: false, reason: 'no' }), plan: async () => { throw new Error('away'); } }, 'x', TODAY);
    expect(s).toMatchObject({ available: true, lenses: ['director'], views: { director: { lateBooks: [], unanswered: [], totals: { lateBooks: 0, unansweredQueries: 0 } } } });
  });
  it('asks for the canon proposals only for a Director’s view, and treats a failure there as none', async () => {
    const asked: string[] = [];
    const src = (caps: string[], waiting: () => Promise<number>) => ({ ...sources(caps, []), canonWaiting: async () => (asked.push('canon'), waiting()) });
    const dir = await loadLens(src(['roles.manage'], async () => 4), 'x', TODAY);
    expect(dir.available && dir.views.director!.canonWaiting).toBe(4);
    const author = await loadLens(src(['manuscript.write'], async () => 9), 'x', TODAY);
    expect(author.available && author.views.director).toBeUndefined();
    expect(asked).toEqual(['canon']); // not asked for an Author
    const broken = await loadLens(src(['roles.manage'], async () => { throw new Error('away'); }), 'x', TODAY);
    expect(broken.available && broken.views.director!.canonWaiting).toBe(0);
  });
  it('treats a capability check that fails as not held', async () => {
    const s = await loadLens({ mayAnywhere: async () => { throw new Error('away'); }, editing: async () => editing, plan: async () => plan }, 'x', TODAY);
    expect(s).toMatchObject({ lenses: [] });
  });
});
