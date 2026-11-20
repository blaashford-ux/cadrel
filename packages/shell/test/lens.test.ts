import { describe, expect, it } from 'vitest';
import { buildLens, loadLens, type LensSources } from '../src/main/lens';
import type { ArtLensInput } from '../src/main/lens';
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

describe('the Art view, and what the Director sees of art', () => {
  const art: ArtLensInput = {
    assets: [
      { id: 'a1', name: 'Cover', projectId: 'b4', projectName: 'Book Four', state: 'in_review', licenceDaysLeft: null, needUpdate: 0 },
      { id: 'a2', name: 'Banner', projectId: 'b4', projectName: 'Book Four', state: 'approved', licenceDaysLeft: 9, needUpdate: 2 },
      { id: 'a3', name: 'Map', projectId: 'b1', projectName: 'Book One', state: 'approved', licenceDaysLeft: -3, needUpdate: 0 },
      { id: 'a4', name: 'Old art', projectId: 'b1', projectName: 'Book One', state: 'retired', licenceDaysLeft: -300, needUpdate: 0 },
      { id: 'a5', name: 'Far licence', projectId: 'b1', projectName: 'Book One', state: 'approved', licenceDaysLeft: 400, needUpdate: 0 }
    ],
    briefs: [
      { id: 'br1', title: 'Cover for Book Four', projectId: 'b4', projectName: 'Book Four', submitted: 3, chosen: false },
      { id: 'br2', title: 'Banner brief', projectId: 'b4', projectName: 'Book Four', submitted: 1, chosen: true }, // already chosen: nothing waits
      { id: 'br3', title: 'Empty brief', projectId: 'b1', projectName: 'Book One', submitted: 0, chosen: false }
    ],
    runs: [
      { fileId: 'e4', path: 'Book Four/book.epub', projectId: 'b4', projectName: 'Book Four', errors: 2 },
      { fileId: 'e1', path: 'Book One/book.epub', projectId: 'b1', projectName: 'Book One', errors: 0 },
      { fileId: 'e2', path: 'Book Two/book.epub', projectId: 'b2', projectName: 'Book Two', errors: 5 }
    ]
  };
  const v = buildLens(['art'], { me: 'ada', today: TODAY, passes: [], tasks: [], art }).art!;

  it('lists what waits for approval, the concepts nobody has chosen from, the licences, and the uses to update', () => {
    expect(v.toApprove.map((a) => a.assetId)).toEqual(['a1']);
    expect(v.concepts).toEqual([{ briefId: 'br1', title: 'Cover for Book Four', projectId: 'b4', projectName: 'Book Four', waiting: 3 }]);
    expect(v.licences.map((l) => [l.assetId, l.days])).toEqual([['a3', -3], ['a2', 9]]); // soonest first; a retired asset and a far licence are not listed
    expect(v.toUpdate).toEqual([{ assetId: 'a2', name: 'Banner', projectId: 'b4', projectName: 'Book Four', uses: 2 }]);
  });

  it('shows the Director how many assets are in review and which books are not ready, the worst first', () => {
    const d = buildLens(['director'], { me: 'dana', today: TODAY, passes: [], tasks: [], art }).director!;
    expect(d.art.inReview).toBe(1);
    expect(d.art.notReady.map((n) => [n.path, n.errors])).toEqual([['Book Two/book.epub', 5], ['Book Four/book.epub', 2]]);
    expect(buildLens(['director'], { me: 'dana', today: TODAY, passes: [], tasks: [] }).director!.art).toEqual({ inReview: 0, notReady: [] });
  });

  it('an Artist or Art Director gets the view; it is built only when asked for, and a failure to read art leaves it empty', async () => {
    expect(buildLens(['author'], { me: 'x', today: TODAY, passes: [], tasks: [], art }).art).toBeUndefined();
    const src = (caps: string[]): LensSources => ({ mayAnywhere: async (c) => caps.includes(c), editing: async () => ({ available: false, reason: 'no' }), plan: async () => { throw new Error('away'); }, art: async () => { throw new Error('away'); } });
    const s = await loadLens(src(['asset.write']), 'x', TODAY);
    expect(s).toMatchObject({ lenses: ['art'], views: { art: { toApprove: [], concepts: [], licences: [], toUpdate: [] } } });
    const m = await loadLens(src(['asset.manage', 'manuscript.write']), 'x', TODAY);
    expect(m.available && m.lenses).toEqual(['author', 'art']);
    const both = await loadLens(src(['manuscript.write', 'asset.write']), 'x', TODAY);
    expect(both.available && both.lenses).toEqual(['author']); // an author who may also upload keeps the author view only
  });
});

describe('the Launch view, and which launches the Director sees at risk', () => {
  const plan = (o: object) => ({ id: 'p', name: 'Book Four launch', projectId: 'b4', projectName: 'Book Four', releaseDate: '2026-12-10', daysToRelease: 20, late: 0, blocked: 0, outstanding: 6, state: 'draft', ...o });
  const launch = {
    plans: [
      plan({ id: 'p1', daysToRelease: 20, late: 2, blocked: 1 }),
      plan({ id: 'p2', name: 'Soon', daysToRelease: 5, blocked: 3 }),
      plan({ id: 'p3', name: 'Far and blocked', daysToRelease: 40, blocked: 4 }),
      plan({ id: 'p4', name: 'Done', daysToRelease: -60, state: 'reviewed', late: 5 }),
      plan({ id: 'p5', name: 'Cancelled', daysToRelease: 3, late: 1, state: 'cancelled' }),
      plan({ id: 'p6', name: 'Clean', daysToRelease: 10 })
    ],
    requests: [{ id: 'q1', title: 'Preorder banner', projectName: 'Book Four', due: '2026-11-30' }],
    reviewsDue: [{ planId: 'p7', name: 'Book Three launch', projectName: 'Book Three' }]
  };

  it('lists live plans soonest first with what is late and blocked, the art asked for, and the reviews due', () => {
    const v = buildLens(['launch'], { me: 'mia', today: TODAY, passes: [], tasks: [], launch }).launch!;
    expect(v.upcoming.map((p) => p.planId)).toEqual(['p2', 'p6', 'p1', 'p3']); // not the reviewed, not the cancelled
    expect(v.upcoming[2]).toMatchObject({ late: 2, blocked: 1 });
    expect(v.requests).toEqual(launch.requests);
    expect(v.reviewsDue).toEqual(launch.reviewsDue);
    expect(buildLens(['author'], { me: 'x', today: TODAY, passes: [], tasks: [], launch }).launch).toBeUndefined();
  });

  it('shows the Director launches near their date that are late, or blocked within two weeks; not far ones, finished ones or clean ones', () => {
    const d = buildLens(['director'], { me: 'dana', today: TODAY, passes: [], tasks: [], launch }).director!;
    expect(d.launchAtRisk.map((p) => p.planId)).toEqual(['p2', 'p1']);
    expect(buildLens(['director'], { me: 'dana', today: TODAY, passes: [], tasks: [] }).director!.launchAtRisk).toEqual([]);
  });

  it('is given to a person who manages launches, built only when asked for, and empty when the records cannot be read', async () => {
    const src = (caps: string[]): LensSources => ({ mayAnywhere: async (c) => caps.includes(c), editing: async () => ({ available: false, reason: 'no' }), plan: async () => { throw new Error('away'); }, launch: async () => { throw new Error('away'); } });
    const s = await loadLens(src(['launch.manage']), 'x', TODAY);
    expect(s).toMatchObject({ lenses: ['launch'], views: { launch: { upcoming: [], requests: [], reviewsDue: [] } } });
    const asked: string[] = [];
    const counting = { ...src(['launch.manage']), launch: async () => (asked.push('launch'), launch) };
    const l = await loadLens(counting, 'x', TODAY);
    expect(l.available && l.views.launch!.upcoming).toHaveLength(4);
    await loadLens({ ...counting, mayAnywhere: async (c) => c === 'manuscript.write' }, 'x', TODAY);
    expect(asked).toEqual(['launch']); // an Author's view does not ask
  });
});

