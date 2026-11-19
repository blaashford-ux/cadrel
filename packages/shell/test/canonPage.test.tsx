// @vitest-environment jsdom
// The Canon page drawn for real (React in jsdom) over a stand-in bridge: what a person sees and which calls their clicks make.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonState, ContinuityCheckView, ContinuityState } from '../src/shared/api';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scopeListeners: ((s: unknown) => void)[] = [];
const scopeOf = (project: string | null, book: string | null = null) => ({ project, book, projectName: project && 'Dragon Rider', bookName: book && 'Book Four', bookImplied: false, links: [], hidden: [] });
const bridge = {
  canon: { state: vi.fn(), call: vi.fn() },
  continuity: { state: vi.fn(), check: vi.fn(), call: vi.fn() },
  scope: { get: vi.fn(async () => scopeOf('s')), onChange: (f: (s: unknown) => void) => void scopeListeners.push(f), set: vi.fn(), openMenu: vi.fn() }
};
const changeScope = async (project: string | null, book: string | null = null) => act(async () => scopeListeners.forEach((f) => f(scopeOf(project, book))));
let CanonPage: typeof import('../src/renderer/Canon').CanonPage;
let root: Root;
let host: HTMLElement;

beforeAll(async () => {
  (window as unknown as { cadrel: unknown }).cadrel = bridge;
  CanonPage = (await import('../src/renderer/Canon')).CanonPage;
});
beforeEach(() => {
  for (const m of [...Object.values(bridge.canon), ...Object.values(bridge.continuity)]) m.mockReset();
  scopeListeners.forEach((f) => f(scopeOf('s'))); // every test starts with the series in view and no book
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const T = '2026-11-18T10:00:00.000Z';
const fact = (o: object = {}) => ({ id: 'f1', projectId: 's', entryId: 'e1', text: 'Mara has grey eyes.', status: 'canon', source: { fileId: 'x', version: 1, anchor: { quote: 'grey eyes', prefix: '', suffix: '', start: 9 } }, bookProjectId: 'b1', chapter: 1, supersedesId: null, proposalId: null, createdAt: T, createdBy: 'lea', retiredAt: null, retiredBy: null, retiredReason: null, sourcePath: 'Book One/book.md', established: 'Dragon Rider / Book One, chapter 1', ...o });
const state = (o: Partial<Extract<CanonState, { available: true }>> & { approve?: boolean; propose?: boolean } = {}): CanonState => ({
  available: true, me: 'ann', current: { id: 's', name: 'Dragon Rider' }, may: { read: true, propose: o.propose ?? true, approve: o.approve ?? false },
  entries: [{ id: 'e1', projectId: 's', kind: 'character', name: 'Mara', aliases: ['the Ferrywoman'], state: 'active', summary: 'A ferrywoman.', version: 1, createdAt: T, createdBy: 'lea', updatedAt: T, facts: [fact() as never], pending: 1 }],
  proposals: [{ id: 'p1', projectId: 's', change: 'add_fact', payload: { change: 'add_fact', entryId: 'e1', text: 'Mara limps.' }, state: 'open', reason: null, findingId: null, proposedBy: 'ann', proposedAt: T, decidedBy: null, decidedAt: null, proposerName: 'you', summary: 'Add a fact about Mara: Mara limps.', fromFinding: false }],
  books: [{ id: 'b1', name: 'Book One' }], waitingOnMe: o.approve ? 1 : 0, ...o
} as never);
const draw = async (s: CanonState) => {
  bridge.canon.state.mockResolvedValue(s);
  await act(async () => root.render(<CanonPage studio={null} onProject={() => undefined} />));
  await act(async () => undefined);
};
const click = async (el: Element | null | undefined) => {
  expect(el, 'the control is there').toBeTruthy();
  await act(async () => (el as HTMLElement).click());
};
const byText = (text: string | RegExp, tag = 'button') => [...host.querySelectorAll(tag)].find((e) => (typeof text === 'string' ? e.textContent === text : text.test(e.textContent ?? '')));

describe('the Canon page', () => {
  it('shows the series, each entry with its aliases, and each fact with where it was established and the passage that established it', async () => {
    await draw(state());
    const t = host.textContent!;
    expect(t).toContain('Dragon Rider');
    expect(t).toContain('Mara');
    expect(t).toContain('also the Ferrywoman');
    expect(t).toContain('Mara has grey eyes.');
    expect(t).toContain('Dragon Rider / Book One, chapter 1');
    expect(t).toContain('“grey eyes” in Book One/book.md, version 1');
    expect(t).toContain('1 proposal waiting');
  });

  it('someone who may not propose can read but is offered no way to change anything', async () => {
    await draw(state({ propose: false }));
    expect(byText(/Add an entry|Propose an entry/)).toBeUndefined();
    expect(byText('Add a fact…')).toBeUndefined();
    expect(byText('Replace', 'button')).toBeUndefined();
    expect(host.textContent).toContain("You can read this series' canon");
  });

  it('a proposer asks; an approver changes canon in one step', async () => {
    bridge.canon.call.mockResolvedValue({});
    await draw(state());
    await click(byText('Propose an entry…'));
    expect(byText('Propose')).toBeTruthy();
    expect(byText('Add to canon')).toBeUndefined();
    await act(async () => root.render(<div />));
    await draw(state({ approve: true }));
    await click(byText('Add an entry…'));
    const input = host.querySelector('input[aria-label="Name"]') as HTMLInputElement;
    const area = host.querySelector('textarea[aria-label="Summary"]') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Harrow');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'A town.');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(byText('Add to canon'));
    expect(bridge.canon.call).toHaveBeenCalledWith('apply', 's', { change: 'add_entry', kind: 'character', name: 'Harrow', aliases: [], summary: 'A town.' });
  });

  it('the Proposals tab lists what waits, and an approver can approve it; a person who may not sees no Approve', async () => {
    bridge.canon.call.mockResolvedValue({});
    await draw(state());
    await click(byText(/^Proposals/));
    expect(host.textContent).toContain('Add a fact about Mara: Mara limps.');
    expect(byText('Approve')).toBeUndefined();
    expect(byText('Withdraw')).toBeTruthy(); // their own
    await act(async () => root.render(<div />));
    await draw(state({ approve: true }));
    await click(byText(/^Proposals/));
    await click(byText('Approve'));
    expect(bridge.canon.call).toHaveBeenCalledWith('approve', 'p1');
  });

  it('shows the Studio’s own words when a change is refused', async () => {
    bridge.canon.call.mockRejectedValue(new Error("Error invoking remote method 'shell:canon:call': Error: The series already has a character called Harrow."));
    await draw(state({ approve: true }));
    await click(byText(/^Proposals/));
    await click(byText('Approve'));
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('The series already has a character called Harrow.');
  });

  it('says why there is nothing to show when the role has no access', async () => {
    await draw({ available: false, reason: 'Your role does not let you see the series bible.' });
    expect(host.textContent).toContain('Your role does not let you see the series bible.');
  });
});

describe('the Continuity tab', () => {
  const check = (o: object = {}) => ({ id: 'k1', projectId: 'b4', seriesId: 's', fileId: 'f4', filePath: 'Book Four/book.md', fileVersion: 2, canonStamp: T, state: 'delivered', runBy: 'eve', createdAt: T, deliveredAt: T, closedAt: null, closedBy: null, updatedAt: T, projectName: 'Dragon Rider / Book Four', runByName: 'Eve Editor', counts: { open: 1, fixed: 0, accepted_as_canon: 0, dismissed: 0 }, ...o });
  const finding = (o: object = {}) => ({ id: 'n1', checkId: 'k1', seq: 1, kind: 'contradiction', severity: 'high', confidence: 'high', body: 'Canon says grey, the text says green.', anchor: { quote: 'green eyes', prefix: '', suffix: '', start: 24 }, factIds: ['f1'], state: 'open', response: null, proposalId: null, fixedInVersion: null, raisedBy: 'eve', raisedAt: T, decidedBy: null, decidedAt: null,
    context: { before: 'Mara walked to the ford with her ', quote: 'green eyes', after: ' narrowed.' }, facts: [{ id: 'f1', entry: 'Mara', text: 'Mara has grey eyes.', status: 'canon', established: 'Dragon Rider / Book One, chapter 1', sourcePath: 'Book One/book.md', passage: 'grey eyes' }], proposal: null, ...o });
  const view = (decide = true, f: object = {}, c: object = {}): ContinuityCheckView => ({ available: true, check: check(c) as never, findings: [finding(f) as never], may: { decide, deliver: true, close: decide }, newerVersion: null, people: [] });
  const open = async (v: ContinuityCheckView) => {
    bridge.continuity.state.mockResolvedValue({ available: true, me: 'ann', may: { start: true }, checks: [check()], books: [{ id: 'b4', name: 'Dragon Rider / Book Four' }], manuscripts: [{ fileId: 'f4', path: 'Book Four/book.md', version: 2, projectId: 'b4' }] } as ContinuityState);
    bridge.continuity.check.mockResolvedValue(v);
    await draw(state());
    await click(byText('Continuity checks'));
    await act(async () => undefined);
    await click(byText('Dragon Rider / Book Four'));
    await act(async () => undefined);
  };

  it('lists the checks, and a check shows each finding with the passage marked in its surroundings and the canon fact it cites', async () => {
    await open(view());
    const t = host.textContent!;
    expect(t).toContain('Waiting for decisions');
    expect(t).toContain('Canon says grey, the text says green.');
    expect(host.querySelector('mark')!.textContent).toBe('green eyes');
    expect(host.querySelector('blockquote')!.textContent).toBe('Mara walked to the ford with her green eyes narrowed.');
    expect(t).toContain('Mara: Mara has grey eyes.');
    expect(t).toContain('Dragon Rider / Book One, chapter 1');
    expect(t).toContain('High severity');
  });

  it('dismissing needs a reason, and sends it', async () => {
    bridge.continuity.call.mockResolvedValue({});
    await open(view());
    await click(byText('Dismiss…'));
    expect((byText('Dismiss') as HTMLButtonElement).disabled).toBe(true);
    const input = host.querySelector('input[aria-label="Why dismiss it"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Her eyes change in book three.');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(byText('Dismiss'));
    expect(bridge.continuity.call).toHaveBeenCalledWith('decide', 'n1', { outcome: 'dismiss', reason: 'Her eyes change in book three.' });
  });

  it('accepting the manuscript as right proposes replacing the cited fact, sourced from the passage in this version', async () => {
    bridge.continuity.call.mockResolvedValue({});
    await open(view());
    await click(byText('The manuscript is right…'));
    const input = host.querySelector('input[aria-label="What canon should say"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Mara has green eyes.');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(byText('Propose the change'));
    expect(bridge.continuity.call).toHaveBeenCalledWith('decide', 'n1', { outcome: 'accept_as_canon', change: { change: 'supersede_fact', factId: 'f1', text: 'Mara has green eyes.', source: { fileId: 'f4', version: 2, anchor: { quote: 'green eyes', prefix: '', suffix: '', start: 24 } }, bookProjectId: 'b4', chapter: null } });
  });

  it('cannot close a check with an open finding; a person who may not decide is offered no decision', async () => {
    await open(view());
    expect((byText('Close the check') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => root.render(<div />));
    await open(view(false));
    expect(byText('Dismiss…')).toBeUndefined();
    expect(byText('The manuscript is right…')).toBeUndefined();
    expect(byText('Close the check')).toBeUndefined();
  });

  it('offers a re-check against a newer version and reports what it fixed', async () => {
    bridge.continuity.call.mockResolvedValue({ fixed: [{}], remaining: [{}, {}] });
    const v = view();
    if (v.available) v.newerVersion = 3;
    await open(v);
    await click(byText('Re-check version 3'));
    expect(bridge.continuity.call).toHaveBeenCalledWith('verify', 'k1', 3);
    expect(host.textContent).toContain('Checked against version 3: 1 finding fixed, 2 still there.');
  });
});

describe('following the project in view', () => {
  it('asks for the canon of the project in view, offers no series to choose, and follows a change of project', async () => {
    bridge.canon.state.mockResolvedValue(state());
    await draw(state());
    expect(bridge.canon.state).toHaveBeenLastCalledWith('s');
    expect(host.querySelector('select[aria-label="Series"]')).toBeNull();
    await changeScope('s2');
    expect(bridge.canon.state).toHaveBeenLastCalledWith('s2');
  });

  it('starts a check on the book in view, offering only its own manuscripts', async () => {
    const tree = { projects: [{ id: 's', parentId: null, name: 's', order: 0 }, { id: 'b4', parentId: 's', name: 'b4', order: 0 }, { id: 'b1', parentId: 's', name: 'b1', order: 1 }], links: [] };
    bridge.continuity.state.mockResolvedValue({ available: true, me: 'ann', may: { start: true }, checks: [], books: [{ id: 'b4', name: 'Dragon Rider / Book Four' }, { id: 'b1', name: 'Dragon Rider / Book One' }], manuscripts: [{ fileId: 'f4', path: 'Book Four/book.md', version: 2, projectId: 'b4' }, { fileId: 'f1', path: 'Book One/book.md', version: 1, projectId: 'b1' }] } as ContinuityState);
    bridge.canon.state.mockResolvedValue(state());
    await act(async () => root.render(<CanonPage studio={{ tree } as never} onProject={() => undefined} />));
    await changeScope('s', 'b4');
    await click(byText('Continuity checks'));
    await act(async () => undefined);
    expect(bridge.continuity.state).toHaveBeenLastCalledWith('b4');
    const form = host.querySelector('form')!.textContent!;
    expect(form).toContain('Book Four/book.md (version 2)'); // the one manuscript of the book in view, picked for the person
    expect(form).not.toContain('Book One/book.md');
    expect(host.querySelector('select[aria-label="Book"]')).toBeNull(); // no book to choose: it is the one in view
    expect((byText('Start a check') as HTMLButtonElement).disabled).toBe(false);
  });
});
