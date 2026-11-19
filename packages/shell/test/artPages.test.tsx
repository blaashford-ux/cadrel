// @vitest-environment jsdom
// The Art and Preflight pages drawn for real (React in jsdom) over a stand-in bridge: what a person sees, what they are offered, and which calls their clicks make.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtState, AssetView, PreflightRunView, PreflightState } from '../src/shared/api';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scopeListeners: ((s: unknown) => void)[] = [];
const scopeOf = (project: string | null, book: string | null = null) => ({ project, book, projectName: project && 'Dragon Rider', bookName: book && 'Book Four', bookImplied: false, links: [], hidden: [] });
const bridge = {
  art: { state: vi.fn(), asset: vi.fn(), brief: vi.fn(), call: vi.fn(), preview: vi.fn() },
  preflight: { state: vi.fn(), run: vi.fn(), get: vi.fn(), waive: vi.fn() },
  scope: { get: vi.fn(async () => scopeOf('s')), onChange: (f: (s: unknown) => void) => void scopeListeners.push(f), set: vi.fn(), openMenu: vi.fn() }
};
let ArtPage: typeof import('../src/renderer/Art').ArtPage;
let PreflightPage: typeof import('../src/renderer/Preflight').PreflightPage;
let root: Root;
let host: HTMLElement;
const changeScope = async (project: string | null, book: string | null = null) => act(async () => scopeListeners.forEach((f) => f(scopeOf(project, book))));

beforeAll(async () => {
  (window as unknown as { cadrel: unknown }).cadrel = bridge;
  ArtPage = (await import('../src/renderer/Art')).ArtPage;
  PreflightPage = (await import('../src/renderer/Preflight')).PreflightPage;
});
beforeEach(() => {
  for (const m of [...Object.values(bridge.art), ...Object.values(bridge.preflight)]) m.mockReset();
  bridge.art.preview.mockResolvedValue({ kind: 'none', reason: 'No picture in this test.' });
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
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const T = '2026-11-19T10:00:00.000Z';
const licence = (o: object = {}) => ({ kind: '', licensor: '', ref: '', expires: null, territory: '', creditLine: '', fileId: null, ...o });
const asset = (o: object = {}) => ({ id: 'a1', projectId: 'b4', fileId: 'cov', kind: 'cover', name: 'Cover', channel: '', state: 'approved', licence: licence(), createdAt: T, createdBy: 'art', updatedAt: T, projectName: 'Book Four', path: 'Book Four/Art/cover.psd', latestVersion: 3, approved: [{ version: 2, hash: 'h2', at: T, byName: 'Ada' }], approvedNow: 2, licenceDaysLeft: null, licenceExpired: false, needUpdate: 0, uses: 1, openFeedback: 0, newerThanApproved: true, ...o });
const may = (o: object = {}) => ({ read: true, write: true, comment: true, approve: true, manage: true, brief: true, ...o });
const state = (o: object = {}): ArtState => ({ available: true, me: 'ann', project: { id: 's', name: 'Dragon Rider' }, may: may(), assets: [asset()], briefs: [], candidates: [], licencesDue: [], ...o }) as never;
const drawArt = async (s: ArtState) => {
  bridge.art.state.mockResolvedValue(s);
  await act(async () => root.render(<ArtPage studio={null} />));
  await act(async () => undefined);
};

describe('the Art page', () => {
  it('shows the assets of the project in view, with the approved version, a newer one that is not approved, and the licence', async () => {
    await drawArt(state({ assets: [asset({ licenceDaysLeft: 12, licence: licence({ expires: '2026-12-01' }) })], licencesDue: [{ assetId: 'a1', name: 'Cover', days: 12 }] }));
    expect(bridge.art.state).toHaveBeenLastCalledWith('s');
    const t = host.textContent!;
    expect(t).toContain('Cover');
    expect(t).toContain('version 2 approved');
    expect(t).toContain('newer version not approved');
    expect(t).toContain('Licence runs out in 12 days');
    expect(t).toContain('1 licence to renew');
  });

  it('follows the book in view, and a change of project, without asking which', async () => {
    await drawArt(state());
    await changeScope('s', 'b4');
    expect(bridge.art.state).toHaveBeenLastCalledWith('b4');
    await changeScope('other');
    expect(bridge.art.state).toHaveBeenLastCalledWith('other');
  });

  it('offers only this project’s files to add, picks a lone one, and adds it as the chosen kind', async () => {
    bridge.art.call.mockResolvedValue({});
    await drawArt(state({ assets: [], candidates: [{ fileId: 'jpg', path: 'Book Four/Art/cover-b.jpg', version: 1 }] }));
    expect(host.querySelector('select[aria-label="File"]')).toBeNull(); // one file: no choice to make
    expect(host.textContent).toContain('Book Four/Art/cover-b.jpg');
    await click(byText('Add as an asset'));
    expect(bridge.art.call).toHaveBeenCalledWith('create', { projectId: 's', fileId: 'jpg', kind: 'cover' });
    await act(async () => root.render(<div />));
    await drawArt(state({ assets: [], candidates: [{ fileId: 'a', path: 'A.jpg', version: 1 }, { fileId: 'b', path: 'B.jpg', version: 1 }] }));
    expect(host.querySelector('select[aria-label="File"]')).toBeTruthy();
    expect((byText('Add as an asset') as HTMLButtonElement).disabled).toBe(true);
  });

  it('someone who may only read is offered no way to add, approve or write a brief', async () => {
    await drawArt(state({ may: may({ write: false, approve: false, manage: false, brief: false, comment: false }), candidates: [{ fileId: 'j', path: 'x.jpg', version: 1 }] }));
    expect(byText('Add as an asset')).toBeUndefined();
    await click(byText(/Briefs and concepts/));
    expect(host.querySelector('form[aria-label="New brief"]')).toBeNull();
  });

  it('an asset opens with its versions; an approver approves one exact version, and the unapproved one is the one offered', async () => {
    bridge.art.call.mockResolvedValue({});
    const view: AssetView = {
      available: true, asset: asset() as never, may: may() as never,
      versions: [{ n: 3, hash: 'h3', at: T, byName: 'Artie', comment: 'Recoloured', approved: false }, { n: 2, hash: 'h2', at: T, byName: 'Artie', comment: '', approved: true }],
      approvals: [], uses: [], fileUses: [], replacements: [], feedback: []
    };
    bridge.art.asset.mockResolvedValue(view);
    await drawArt(state());
    await click(byText('Cover'));
    await act(async () => undefined);
    expect(host.textContent).toContain('Version 3');
    expect(byText('Approve version 2')).toBeUndefined(); // already approved
    await click(byText('Approve version 3'));
    expect(bridge.art.call).toHaveBeenCalledWith('approve', 'a1', 3);
    expect(byText('Take back approval of version 2')).toBeTruthy();
  });

  it('taking an approval back needs a reason', async () => {
    bridge.art.call.mockResolvedValue({});
    bridge.art.asset.mockResolvedValue({ available: true, asset: asset() as never, may: may() as never, versions: [{ n: 2, hash: 'h2', at: T, byName: 'Artie', comment: '', approved: true }], approvals: [], uses: [], fileUses: [], replacements: [], feedback: [] } satisfies AssetView);
    await drawArt(state());
    await click(byText('Cover'));
    await act(async () => undefined);
    await click(byText('Take back approval of version 2'));
    expect((byText('Take it back') as HTMLButtonElement).disabled).toBe(true);
    await type(host.querySelector('input[aria-label="Why"]'), 'Wrong trim.');
    await click(byText('Take it back'));
    expect(bridge.art.call).toHaveBeenCalledWith('revoke', 'a1', 2, 'Wrong trim.');
  });

  it('a refusal comes back in the Studio’s own words', async () => {
    bridge.art.call.mockRejectedValue(new Error("Error invoking remote method 'shell:art:call': Error: The licence ran out on 2026-01-01, so a new version cannot be approved until it is renewed."));
    bridge.art.asset.mockResolvedValue({ available: true, asset: asset() as never, may: may() as never, versions: [{ n: 3, hash: 'h3', at: T, byName: 'A', comment: '', approved: false }], approvals: [], uses: [], fileUses: [], replacements: [], feedback: [] } satisfies AssetView);
    await drawArt(state());
    await click(byText('Cover'));
    await act(async () => undefined);
    await click(byText('Approve version 3'));
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('The licence ran out on 2026-01-01, so a new version cannot be approved until it is renewed.');
  });
});

// ---- Preflight ---------------------------------------------------------------------------------------------------------------------

const pack = (o: object = {}) => ({ id: 'kdp-ebook', title: 'Amazon KDP, Kindle eBook', version: '1', verified: '2026-11-19', ageMonths: 1, sources: [{ rule: 'cover', url: 'https://kdp.amazon.com/x', read: '2026-11-19' }], notChecked: ['Print interiors'], ...o });
const run = (o: object = {}) => ({ id: 'r1', projectId: 'b4', editionId: 'e1', fileId: 'epub', fileVersion: 2, fileHash: 'h', coverAssetId: 'a1', coverVersion: 2, metadataHash: '', packId: 'kdp-ebook', packVersion: '1', packVerified: '2026-11-19', runBy: 'ann', at: T, errors: 1, warnings: 0, suggestions: 0, notChecked: ['Print interiors'], ready: false, ...o });
const result = (o: object = {}) => ({ seq: 1, ruleId: 'cover.size', grade: 'error', what: 'The cover is too small to be accepted.', location: 'OEBPS/cover.jpg', measured: '400 × 450 pixels', expected: 'at least 500 pixels on the longest side', state: 'open', waivedBy: null, waivedReason: null, waivedAt: null, carried: false, ...o });
const runView = (o: object = {}, r: object = {}): PreflightRunView => ({ available: true, run: run(o) as never, results: [result(r)] as never, path: 'Book Four/Exports/book.epub', editionLabel: 'Dragon Rider, ebook', pack: pack() as never, may: { run: true }, byName: 'you', coverPath: 'Cover', epubcheck: 'not installed' });
const pstate = (o: object = {}): PreflightState => ({ available: true, me: 'ann', project: { id: 's', name: 'Dragon Rider' }, may: { read: true, run: true }, files: [{ fileId: 'epub', path: 'Book Four/Exports/book.epub', version: 2, latest: null }], editions: [{ id: 'e1', label: 'Dragon Rider, ebook', bookTitle: 'Dragon Rider', projectId: 'b4' }], pack: pack() as never, epubcheck: false, ...o }) as never;
const drawPre = async (s: PreflightState) => {
  bridge.preflight.state.mockResolvedValue(s);
  await act(async () => root.render(<PreflightPage studio={null} />));
  await act(async () => undefined);
};

describe('the Preflight page', () => {
  it('offers the one EPUB and the one edition without asking, runs, and shows each result with what was measured and expected, worst first', async () => {
    bridge.preflight.run.mockResolvedValue(runView());
    await drawPre(pstate());
    expect(bridge.preflight.state).toHaveBeenLastCalledWith('s');
    expect(host.querySelector('select')).toBeNull();
    await click(byText('Run Preflight'));
    expect(bridge.preflight.run).toHaveBeenCalledWith('epub', 'e1');
    const t = host.textContent!;
    expect(t).toContain('Not ready: 1 error');
    expect(t).toContain('The cover is too small to be accepted.');
    expect(t).toContain('Found: 400 × 450 pixels.');
    expect(t).toContain('Expected: at least 500 pixels on the longest side.');
    expect(t).toContain('OEBPS/cover.jpg');
    expect(t).toContain('Errors');
  });

  it('a waiver needs a reason and sends it; a waived result shows its reason, and where it was carried from', async () => {
    bridge.preflight.run.mockResolvedValue(runView());
    bridge.preflight.waive.mockResolvedValue(runView({ errors: 0, ready: true }, { state: 'waived', waivedReason: 'Fine for a box set.', carried: false }));
    await drawPre(pstate());
    await click(byText('Run Preflight'));
    await click(byText('Waive…'));
    expect((byText('Waive it') as HTMLButtonElement).disabled).toBe(true);
    await type(host.querySelector('input[aria-label="Reason to waive"]'), 'Fine for a box set.');
    await click(byText('Waive it'));
    expect(bridge.preflight.waive).toHaveBeenCalledWith('r1', 1, 'Fine for a box set.');
    expect(host.textContent).toContain('Fine for a box set.');
    expect(host.textContent).toContain('No errors');
  });

  it('the earlier run on the file is shown at once, and a rerun is offered as "Check again"', async () => {
    bridge.preflight.get.mockResolvedValue(runView());
    await drawPre(pstate({ files: [{ fileId: 'epub', path: 'Book Four/Exports/book.epub', version: 2, latest: run() }] }));
    await act(async () => undefined);
    expect(bridge.preflight.get).toHaveBeenCalledWith('r1');
    expect(host.textContent).toContain('Not ready: 1 error');
    expect(byText('Check again')).toBeTruthy();
  });

  it('says how old the rules are, warns when they are old, and lists what it does not check', async () => {
    await drawPre(pstate());
    expect(host.textContent).toContain('1 month ago');
    expect(host.textContent).not.toContain('check the retailer’s own pages');
    await act(async () => root.render(<div />));
    await drawPre(pstate({ pack: pack({ ageMonths: 8 }) }));
    expect(host.textContent).toContain('check the retailer’s own pages before relying on a result');
    expect(host.textContent).toContain('Print interiors');
  });

  it('a person who may read but not run sees results and no run button; with no EPUB it says so; it follows the project in view', async () => {
    await drawPre(pstate({ may: { read: true, run: false } }));
    expect(byText('Run Preflight')).toBeUndefined();
    expect(host.textContent).toContain('may read Preflight but not run it');
    await act(async () => root.render(<div />));
    await drawPre(pstate({ files: [], editions: [] }));
    expect(host.textContent).toContain('There is no EPUB in Dragon Rider yet');
    await changeScope('s', 'b4');
    expect(bridge.preflight.state).toHaveBeenLastCalledWith('b4');
  });

  it('with several EPUBs, the person chooses; with none chosen it cannot run', async () => {
    await drawPre(pstate({ files: [{ fileId: 'a', path: 'A.epub', version: 1, latest: null }, { fileId: 'b', path: 'B.epub', version: 1, latest: run({ errors: 2 }) }] }));
    expect(host.querySelector('select[aria-label="EPUB"]')).toBeTruthy();
    expect((byText('Run Preflight') as HTMLButtonElement).disabled).toBe(true);
    expect(host.textContent).toContain('2 errors');
  });
});
