// @vitest-environment jsdom
// The Launch page drawn for real (React in jsdom) over a stand-in bridge: what a person sees, what they are offered, and which calls their clicks make.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scopeListeners: ((s: unknown) => void)[] = [];
const scopeOf = (project: string | null, book: string | null = null) => ({ project, book, projectName: project && 'Dragon Rider', bookName: book && 'Book Four', bookImplied: false, links: [], hidden: [] });
const bridge = {
  launch: { state: vi.fn(), plan: vi.fn(), readers: vi.fn(), brief: vi.fn(), market: vi.fn(), call: vi.fn(), deliver: vi.fn(), publishFigures: vi.fn(), decisionWindow: vi.fn() },
  art: { state: vi.fn() },
  scope: { get: vi.fn(async () => scopeOf('s')), onChange: (f: (s: unknown) => void) => void scopeListeners.push(f), set: vi.fn(), openMenu: vi.fn() }
};
let LaunchPage: typeof import('../src/renderer/Launch').LaunchPage;
let root: Root;
let host: HTMLElement;
const changeScope = async (project: string | null, book: string | null = null) => act(async () => scopeListeners.forEach((f) => f(scopeOf(project, book))));
beforeAll(async () => {
  (window as unknown as { cadrel: unknown }).cadrel = bridge;
  LaunchPage = (await import('../src/renderer/Launch')).LaunchPage;
});
beforeEach(() => {
  for (const m of [...Object.values(bridge.launch), ...Object.values(bridge.art)]) m.mockReset();
  bridge.art.state.mockResolvedValue({ available: true, assets: [] });
  scopeListeners.forEach((f) => f(scopeOf('s')));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const click = async (el: Element | null | undefined) => {
  expect(el, 'the control is there').toBeTruthy();
  await act(async () => (el as HTMLElement).click());
};
const byText = (text: string | RegExp, tag = 'button') => [...host.querySelectorAll(tag)].find((e) => (typeof text === 'string' ? e.textContent === text : text.test(e.textContent ?? '')));
const type = async (el: Element | null, value: string) => {
  const input = el as HTMLInputElement | HTMLTextAreaElement;
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
};

const T = '2026-11-20T10:00:00.000Z';
const may = (o: object = {}) => ({ read: true, manage: true, approve: true, capture: true, ...o });
const plan = (o: object = {}) => ({ id: 'p1', projectId: 'b4', editionId: 'e1', templateId: 't1', templateVersion: 1, name: 'Ebook launch, 2027-03-31', releaseDate: '2027-03-31', state: 'draft', targets: {}, approvedRevision: null, approvedBy: null, approvedAt: null, liveAt: null, createdAt: T, createdBy: 'mia', updatedAt: T, ...o });
const counts = { done: 1, late: 1, blocked: 2, outstanding: 4, cancelled: 0 };
const summary = (o: object = {}) => ({ plan: plan(), projectName: 'Book Four', editionLabel: 'Dragon Rider, ebook', counts, outstanding: 6, late: 1, blocked: 2, daysToRelease: 131, changedSinceApproval: false, ...o });
const state = (o: object = {}) => ({ available: true, me: 'mia', project: { id: 's', name: 'Dragon Rider' }, may: may(), plans: [summary()], templates: [{ id: 't1', name: 'Ebook launch', version: 1, items: 10 }, { id: 't2', name: 'Series launch', version: 1, items: 12 }], editions: [{ id: 'e1', label: 'Dragon Rider, ebook', asin: 'B0ABCDEF12', projectId: 'b4' }], people: [{ id: 'u1', name: 'Mia' }], briefs: [], requests: [], ...o }) as never;
const draw = async (s: unknown) => {
  bridge.launch.state.mockResolvedValue(s);
  await act(async () => root.render(<LaunchPage studio={null} />));
  await act(async () => undefined);
};
const item = (key: string, title: string, o: { status?: string; reasons?: string[]; due?: string; manual?: boolean; required?: boolean; assignee?: string | null } = {}) => ({
  view: { item: { id: key, planId: 'p1', key, taskId: `t-${key}`, offsetDays: -10, required: o.required ?? true, role: 'marketing', requirement: o.manual ? { kind: 'manual' } : { kind: 'cover_approved' } },
    task: { id: `t-${key}`, projectId: 'b4', kind: 'task', title, notes: '', assigneeId: o.assignee === undefined ? 'u1' : o.assignee, due: o.due ?? '2027-03-21', state: 'open', doneAt: null, dependsOn: [], createdAt: T, createdBy: 'mia', updatedAt: T }, status: o.status ?? 'outstanding', reasons: o.reasons ?? [], daysLate: o.status === 'late' ? 4 : 0 },
  assigneeName: o.assignee === null ? null : 'Mia'
});
const planView = (o: object = {}) => {
  const items = [item('cover', 'Cover approved', { status: 'blocked', reasons: ['The cover is not approved yet.'] }), item('upload', 'Upload and set the preorder', { manual: true }), item('brief', 'Write the marketing brief', { status: 'late', reasons: ['There is no marketing brief yet.'] })];
  return { available: true, plan: plan(), projectName: 'Book Four', editionLabel: 'Dragon Rider, ebook', asin: 'B0ABCDEF12', may: may(), items, outstanding: items, counts, revision: 'rev1', changedSinceApproval: false, daysToRelease: 131, approvedByName: null, proposals: [], campaigns: [], requests: [], review: null, figures: { count: 2, latest: null }, ...o } as never;
};

describe('the Launch page', () => {
  it('shows the plans of the project in view with what is late, blocked and outstanding; and follows the book in view', async () => {
    await draw(state());
    expect(bridge.launch.state).toHaveBeenLastCalledWith('s');
    const t = host.textContent!;
    expect(t).toContain('Ebook launch, 2027-03-31');
    expect(t).toContain('131 days to go');
    expect(t).toContain('1 late item');
    expect(t).toContain('2 blocked items');
    expect(t).toContain('6 outstanding');
    await changeScope('s', 'b4');
    expect(bridge.launch.state).toHaveBeenLastCalledWith('b4');
  });

  it('a manager makes a plan from a template for a date; the lone edition is picked for them; a reader of plans is offered nothing to make', async () => {
    bridge.launch.call.mockResolvedValue({});
    await draw(state({ plans: [] }));
    expect(byText('Make the plan')).toBeTruthy();
    expect((byText('Make the plan') as HTMLButtonElement).disabled).toBe(true); // a template is chosen for them (Ebook launch), but not a date
    await type(host.querySelector('input[aria-label="Release date"]'), '2027-03-31');
    await click(byText('Make the plan'));
    expect(bridge.launch.call).toHaveBeenCalledWith('createPlan', { projectId: 's', templateId: 't1', releaseDate: '2027-03-31', editionId: 'e1', assignees: { marketing: null, art: null } });
    await act(async () => root.render(<div />));
    await draw(state({ may: may({ manage: false, approve: false, capture: false }), plans: [] }));
    expect(byText('Make the plan')).toBeUndefined();
    expect(host.textContent).toContain('No release plan for Dragon Rider yet.');
  });

  it('a plan opens with what is outstanding and why; a manual item can be marked done; the approver approves the revision shown', async () => {
    bridge.launch.plan.mockResolvedValue(planView());
    bridge.launch.call.mockResolvedValue({});
    await draw(state());
    await click(byText('Ebook launch, 2027-03-31'));
    await act(async () => undefined);
    const t = host.textContent!;
    expect(t).toContain('Outstanding for 2027-03-31');
    expect(t).toContain('The cover is not approved yet.');
    expect(t).toContain('There is no marketing brief yet.');
    expect(t).toContain('4 days late');
    await click(byText('Mark done'));
    expect(bridge.launch.call).toHaveBeenCalledWith('mark', 'p1', 'upload', true);
    await click(byText('Approve this plan as it stands'));
    expect(bridge.launch.call).toHaveBeenCalledWith('approve', 'p1', 'rev1');
  });

  it('moving the date proposes; the proposal lists each item’s old and new date and nothing is applied until it is', async () => {
    bridge.launch.call.mockResolvedValue({});
    bridge.launch.plan.mockResolvedValue(planView());
    await draw(state());
    await click(byText('Ebook launch, 2027-03-31'));
    await act(async () => undefined);
    await type(host.querySelector('input[aria-label="New release date"]'), '2027-04-14');
    await type(host.querySelector('input[aria-label="Why the date moves"]'), 'The cover is late.');
    await click(byText('Propose the new date'));
    expect(bridge.launch.call).toHaveBeenCalledWith('proposeDate', 'p1', '2027-04-14', 'The cover is late.');
    const proposal = { id: 'd1', planId: 'p1', fromDate: '2027-03-31', newDate: '2027-04-14', state: 'open', reason: 'The cover is late.', proposedBy: 'mia', proposedAt: T, decidedBy: null, decidedAt: null, proposerName: 'you', changes: [{ key: 'cover', title: 'Cover approved', taskId: 't', from: '2027-02-03', to: '2027-02-17', past: false, beforeDependency: null }, { key: 'brief', title: 'Write the marketing brief', taskId: 't2', from: '2027-01-30', to: '2027-02-13', past: true, beforeDependency: 'Odd item' }] };
    await act(async () => root.render(<div />));
    bridge.launch.plan.mockResolvedValue(planView({ proposals: [proposal] }));
    await draw(state());
    await click(byText('Ebook launch, 2027-03-31'));
    await act(async () => undefined);
    const t = host.textContent!;
    expect(t).toContain('Move from 2027-03-31 to 2027-04-14');
    expect(t).toContain('nothing changes until it is applied');
    expect(t).toContain('2027-02-03');
    expect(t).toContain('2027-02-17');
    expect(t).toContain('already past');
    expect(t).toContain('before “Odd item”');
    await click(byText('Apply the new dates'));
    expect(bridge.launch.call).toHaveBeenCalledWith('applyDate', 'd1');
  });

  it('ARC: counts for everyone and no names; the readers are only shown on asking, and the page says no rating is kept', async () => {
    const campaign = { id: 'k1', planId: 'p1', name: 'Round one', targetReaders: 10, reviewTarget: 4, sendBy: null, reviewBy: null, fileId: 'epub', fileVersion: 2, state: 'open', reportedReviews: 3, createdAt: T, createdBy: 'mia', counts: { total: 6, byState: { invited: 1, sent: 4, received: 0, reviewed: 1, declined: 0, bounced: 0 }, withFile: 5, reviewed: 1, targetReaders: 10, reviewTarget: 4 }, cross: { reported: 3, readersReviewed: 1, measured: { ratings: 14, capturedAt: '2026-11-18T08:00:00.000Z' } } };
    bridge.launch.plan.mockResolvedValue(planView({ campaigns: [campaign] }));
    bridge.launch.readers.mockResolvedValue({ readers: [{ id: 'r1', campaignId: 'k1', name: 'Rae Reader', email: 'rae@example.com', source: 'newsletter', state: 'sent', sentAt: T, reviewedAt: null, reviewUrl: null, note: '', erasedAt: null, createdAt: T }] });
    bridge.launch.call.mockResolvedValue({});
    await draw(state());
    await click(byText('Ebook launch, 2027-03-31'));
    await act(async () => undefined);
    let t = host.textContent!;
    expect(t).toContain('5 of 10 have the file');
    expect(t).toContain('1 marked reviewed of 4');
    expect(t).toContain('Reviews the studio reports: 3 (reported). Ratings counted on the book\'s page: 14 (measured, captured 2026-11-18)');
    expect(t).toContain('No star rating is kept');
    expect(t).not.toContain('Rae Reader'); // not until asked
    await click(byText('Show the readers (logged)'));
    await act(async () => undefined);
    expect(bridge.launch.readers).toHaveBeenCalledWith('k1');
    t = host.textContent!;
    expect(t).toContain('Rae Reader');
    await click(byText('Erase their details'));
    expect(bridge.launch.call).toHaveBeenCalledWith('eraseReader', 'r1');
  });

  it('a person who may only read a plan sees no readers button, no approve and no move-the-date', async () => {
    const campaign = { id: 'k1', planId: 'p1', name: 'Round one', targetReaders: 10, reviewTarget: 0, sendBy: null, reviewBy: null, fileId: null, fileVersion: null, state: 'open', reportedReviews: 0, createdAt: T, createdBy: 'mia', counts: { total: 2, byState: { invited: 2, sent: 0, received: 0, reviewed: 0, declined: 0, bounced: 0 }, withFile: 0, reviewed: 0, targetReaders: 10, reviewTarget: 0 }, cross: { reported: 0, readersReviewed: 0, measured: null } };
    bridge.launch.plan.mockResolvedValue(planView({ may: may({ manage: false, approve: false, capture: false }), campaigns: [campaign] }));
    await draw(state({ may: may({ manage: false, approve: false, capture: false }) }));
    await click(byText('Ebook launch, 2027-03-31'));
    await act(async () => undefined);
    expect(byText('Show the readers (logged)')).toBeUndefined();
    expect(byText('Approve this plan as it stands')).toBeUndefined();
    expect(host.querySelector('input[aria-label="New release date"]')).toBeNull();
    expect(host.textContent).toContain('0 of 10 have the file');
  });

  it('a brief shows its comps with the figures it saw and their age, says when newer ones exist, and pins them again on asking', async () => {
    const comp = { briefId: 'br1', briefVersion: 1, asin: 'B0COMPETE1', role: 'comp', note: '', ageDays: 40, figure: { id: 'f1', asin: 'B0COMPETE1', capturedAt: '2026-10-11T08:00:00.000Z', title: 'Dragon Bound', price: 4.99, currency: 'USD', rank: 1200, ratings: 300, ratingAvg: 4.6, categories: [], publishedBy: 'mia', publishedAt: T } };
    bridge.launch.state.mockResolvedValue(state({ briefs: [{ id: 'br1', title: 'Launch brief', kind: 'launch', version: 1, projectName: 'Book Four', comps: 1, updatedAt: T }] }));
    bridge.launch.brief.mockResolvedValue({ available: true, brief: { id: 'br1', title: 'Launch brief', kind: 'launch', projectId: 'b4', version: 1, body: 'Against the comps.', note: '', writtenAt: T, writtenByName: 'Mia' }, versions: [], comps: [comp], may: may(), newer: ['B0COMPETE1'] });
    bridge.launch.call.mockResolvedValue({});
    await act(async () => root.render(<LaunchPage studio={null} />));
    await act(async () => undefined);
    await click(byText(/Briefs/, 'button'));
    await click(byText('Launch brief'));
    await act(async () => undefined);
    const t = host.textContent!;
    expect(t).toContain('Dragon Bound');
    expect(t).toContain('rank 1200, price 4.99, 300 ratings; captured 2026-10-11 (40 days before today)');
    expect(t).toContain('newer figure exists');
    await click(byText('Pin the newer figures'));
    expect(bridge.launch.call).toHaveBeenCalledWith('pinComps', 'br1', 1, [{ asin: 'B0COMPETE1' }]);
  });

  it('Market: figures with their capture date, publishing from this computer, and what the figures did around a change, with the caveats', async () => {
    const latest = { id: 'f', asin: 'B0ABCDEF12', capturedAt: '2026-11-18T08:00:00.000Z', title: '', price: 4.99, currency: 'USD', rank: 900, ratings: 44, ratingAvg: 4.5, categories: [], publishedBy: 'mia', publishedAt: T };
    bridge.launch.market.mockResolvedValue({ available: true, project: { id: 's', name: 'Dragon Rider' }, may: may(), editions: [{ id: 'e1', label: 'Dragon Rider, ebook', asin: 'B0ABCDEF12', figures: 2, latest }], compSets: [], reports: [], decisions: [{ id: 'm1', editionId: 'e1', asin: 'B0ABCDEF12', kind: 'cover', fromValue: 'Old', toValue: 'New', reason: 'Better thumbnail.', assetId: null, briefId: null, decisionId: null, decidedBy: 'mia', decidedAt: '2026-11-15T09:00:00.000Z', editionLabel: 'Dragon Rider, ebook', byName: 'you' }] });
    bridge.launch.publishFigures.mockResolvedValue({ added: 2, skipped: 0, books: 1 });
    bridge.launch.decisionWindow.mockResolvedValue({ decision: {}, days: 30, before: { points: [{}], median: { rank: 1200, price: 4.99, ratings: 40 } }, after: { points: [{}, {}], median: { rank: 900, price: 4.99, ratings: 44 } }, alsoChanged: [{ kind: 'price', decidedAt: '2026-11-16T09:00:00.000Z' }], caveats: ['Only 1 figure on the thinner side: a comparison of so few points says little.'] });
    await draw(state());
    await click(byText('Market'));
    await act(async () => undefined);
    expect(host.textContent).toContain('rank 900, price 4.99, 44 ratings; newest capture 2026-11-18; 2 figures');
    await click(byText('Publish from this computer'));
    await act(async () => undefined);
    expect(bridge.launch.publishFigures).toHaveBeenCalledWith('s');
    expect(host.textContent).toContain('Published 2 new figures for 1 book');
    await click(byText('What the figures did around it'));
    await act(async () => undefined);
    const t = host.textContent!;
    expect(t).toContain('Before: 1 figure, middle rank 1200');
    expect(t).toContain('After: 2 figures, middle rank 900');
    expect(t).toContain('Also changed in the same 30 days: price (2026-11-16)');
    expect(t).toContain('Only 1 figure on the thinner side');
    expect(t).not.toMatch(/caused/);
  });

  it('art requests: a request can be fulfilled by offering an asset; a refusal is shown in the Studio’s own words', async () => {
    bridge.art.state.mockResolvedValue({ available: true, assets: [{ id: 'a1', name: 'Banner', latestVersion: 2, state: 'draft' }] });
    bridge.launch.deliver.mockRejectedValue(new Error("Error invoking remote method 'shell:launch:deliver': Error: That file does not meet what was asked for (1200 × 628 pixels). Found 800 × 600 pixels; wanted 1200 pixels wide."));
    const request = { request: { id: 'q1', projectId: 'b4', planId: 'p1', briefId: null, kind: 'banner', title: 'Preorder banner', spec: { width: 1200, height: 628 }, due: '2026-12-15', assigneeId: 'u2', taskId: 't', state: 'open', assetId: null, deliveredVersion: null, measured: null, requestedBy: 'mia', requestedAt: T, updatedAt: T }, fulfilled: false, reasons: ['Nothing has been delivered yet (1200 × 628 pixels).'], projectName: 'Book Four', assigneeName: 'Artie' };
    await draw(state({ requests: [request] }));
    await click(byText(/Art requests/));
    await act(async () => undefined);
    expect(host.textContent).toContain('Preorder banner');
    expect(host.textContent).toContain('Nothing has been delivered yet');
    await click(byText('Offer version 2'));
    expect(bridge.launch.deliver).toHaveBeenCalledWith('q1', 'a1', 2);
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('That file does not meet what was asked for (1200 × 628 pixels). Found 800 × 600 pixels; wanted 1200 pixels wide.');
  });
});
