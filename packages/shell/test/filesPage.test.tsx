// @vitest-environment jsdom
// The Files page's filters drawn for real over a stand-in bridge: narrowing to one project, to manuscripts only, the marker on a manuscript, and the
// right-click menu that sets a file as one (the same setting as Write's menu).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultState } from '../src/shared/api';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (path: string, o: object = {}) => ({ path, kind: /\.(png|psd)$/.test(path) ? 'asset' : 'manuscript', fileId: `f-${path}`, status: 'latest', version: 1, localVersion: 1, modified: false, lock: null, size: 2048, state: null, ...o });
const state = (o: object = {}): VaultState => ({
  available: true, dir: 'C:/Projects', machine: 'pc', me: 'me', people: [{ id: 'me', name: 'Ana' }], may: { force: false }, staleDays: 14, kept: [], orphans: [], sync: null,
  entries: [entry('Saga/Manuscripts/One.md'), entry('Saga/Manuscripts/Two.md'), entry('Saga/Notes/Ideas.md'), entry('Saga/Art/cover.png'), entry('Other/Draft.md'), entry('loose.md', { status: 'untracked', fileId: null })],
  projects: [{ folder: 'Saga', name: 'The Saga' }, { folder: 'Other', name: 'Other' }],
  manuscripts: ['Saga/Manuscripts/One.md', 'Saga/Manuscripts/Two.md'],
  ...o
}) as never;
const bridge = { vault: { state: vi.fn(), syncNow: vi.fn(), add: vi.fn(), setManuscript: vi.fn(), checkOut: vi.fn(), checkIn: vi.fn(), undoCheckOut: vi.fn(), discardLocalChanges: vi.fn(), getLatest: vi.fn(), forceRelease: vi.fn(), history: vi.fn(), detail: vi.fn() } };
let Files: typeof import('../src/renderer/Files').Files;
let root: Root;
let host: HTMLElement;

beforeAll(async () => {
  (window as unknown as { cadrel: unknown }).cadrel = bridge;
  Files = (await import('../src/renderer/Files')).Files;
});
beforeEach(() => {
  for (const m of Object.values(bridge.vault)) m.mockReset();
  bridge.vault.state.mockResolvedValue(state());
  bridge.vault.setManuscript.mockResolvedValue(undefined);
  try { localStorage.clear(); } catch { /* none */ }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const draw = async () => {
  await act(async () => root.render(<Files />));
  await act(async () => undefined);
};
const paths = () => [...host.querySelectorAll('tr[data-path]')].map((r) => r.getAttribute('data-path'));
const pick = async (el: Element | null, value: string) => {
  const sel = el as HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(sel, value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const click = async (el: Element | null | undefined) => {
  expect(el, 'the control is there').toBeTruthy();
  await act(async () => (el as HTMLElement).click());
};
const menuOn = async (path: string) => act(async () => void host.querySelector(`tr[data-path="${path}"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 50 })));
const project = () => host.querySelector('select[aria-label="Project"]') as HTMLSelectElement;
const only = () => [...host.querySelectorAll('label')].find((l) => l.textContent!.includes('Manuscripts only'))!.querySelector('input') as HTMLInputElement;

describe('the Files page’s filters', () => {
  it('lists every file at first, with a marker on the manuscripts and the project filter offering each project', async () => {
    await draw();
    expect(paths()).toHaveLength(6);
    expect([...project().options].map((o) => o.textContent)).toEqual(['All projects', 'The Saga', 'Other', 'Not in a project']);
    expect(host.querySelectorAll('tr .chip.ok')).toHaveLength(2);
    expect(host.querySelector('tr[data-path="Saga/Manuscripts/One.md"] .chip.ok')!.textContent).toContain('set as manuscript');
    expect(host.textContent).not.toContain('Showing');
  });

  it('narrows to one project, to the files that are in no project, and back', async () => {
    await draw();
    await pick(project(), 'Saga');
    expect(paths()).toEqual(['Saga/Manuscripts/One.md', 'Saga/Manuscripts/Two.md', 'Saga/Notes/Ideas.md', 'Saga/Art/cover.png']);
    expect(host.textContent).toContain('Showing 4 of 6 files');
    await pick(project(), '\u0000none');
    expect(paths()).toEqual(['loose.md']);
    await pick(project(), '');
    expect(paths()).toHaveLength(6);
  });

  it('shows only the manuscripts when asked, and the two filters and the search work together', async () => {
    await draw();
    await click(only());
    expect(paths()).toEqual(['Saga/Manuscripts/One.md', 'Saga/Manuscripts/Two.md']);
    expect(host.textContent).toContain('Showing 2 of 6 files');
    await pick(project(), 'Other');
    expect(paths()).toEqual([]); // nothing in Other is a manuscript
    expect(host.textContent).toContain('No files match.');
    await pick(project(), 'Saga');
    const search = host.querySelector('input[aria-label="Search files"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'two');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(paths()).toEqual(['Saga/Manuscripts/Two.md']);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'zzz');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Show all files'));
    await act(async () => undefined);
    expect(paths()).toHaveLength(6);
    expect(only().checked).toBe(false);
  });

  it('says how to set a manuscript when none is set, instead of an empty page', async () => {
    bridge.vault.state.mockResolvedValue(state({ manuscripts: [] }));
    await draw();
    await click(only());
    expect(paths()).toEqual([]);
    expect(host.textContent).toContain('No file is set as a manuscript yet');
    expect(host.textContent).toContain('Set as Manuscript');
  });

  it('remembers both filters, and ignores a project that is no longer there', async () => {
    await draw();
    await pick(project(), 'Saga');
    await click(only());
    await act(async () => root.unmount());
    root = createRoot(host);
    await draw();
    expect(project().value).toBe('Saga');
    expect(only().checked).toBe(true);
    expect(paths()).toEqual(['Saga/Manuscripts/One.md', 'Saga/Manuscripts/Two.md']);
    await act(async () => root.unmount());
    root = createRoot(host);
    bridge.vault.state.mockResolvedValue(state({ projects: [{ folder: 'Other', name: 'Other' }] }));
    await draw();
    expect(project().value).toBe(''); // Saga is gone: the list is not narrowed to nothing
  });
});

describe('the right-click menu of a file', () => {
  it('sets a file as a manuscript, through the project’s own setting, and shows it afterwards', async () => {
    await draw();
    await menuOn('Saga/Notes/Ideas.md');
    expect([...host.querySelectorAll('[role=menuitem]')].map((b) => b.textContent)).toEqual(['Set as Manuscript']);
    bridge.vault.state.mockResolvedValue(state({ manuscripts: ['Saga/Manuscripts/One.md', 'Saga/Manuscripts/Two.md', 'Saga/Notes/Ideas.md'] }));
    await click(host.querySelector('[role=menuitem]'));
    expect(bridge.vault.setManuscript).toHaveBeenCalledWith('Saga/Notes/Ideas.md', true);
    expect(host.querySelector('[role=menu]')).toBeNull();
    expect(host.textContent).toContain('Saga/Notes/Ideas.md is set as a manuscript.');
    expect(host.querySelectorAll('tr .chip.ok')).toHaveLength(3);
  });

  it('takes a manuscript back out', async () => {
    await draw();
    await menuOn('Saga/Manuscripts/Two.md');
    expect(host.querySelector('[role=menuitem]')!.textContent).toBe('Remove from Manuscripts');
    await click(host.querySelector('[role=menuitem]'));
    expect(bridge.vault.setManuscript).toHaveBeenCalledWith('Saga/Manuscripts/Two.md', false);
  });

  it('is not offered for a picture or a file outside a project, and says why', async () => {
    await draw();
    for (const p of ['Saga/Art/cover.png', 'loose.md']) {
      await menuOn(p);
      const item = host.querySelector('[role=menuitem]') as HTMLButtonElement;
      expect(item.disabled).toBe(true);
      expect(item.title).toContain('Markdown file inside a project');
      await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
      expect(host.querySelector('[role=menu]')).toBeNull();
    }
  });

  it('shows a refusal in the Studio’s words', async () => {
    bridge.vault.setManuscript.mockRejectedValue(new Error("Error invoking remote method 'shell:vault:setManuscript': Error: That project could not be found."));
    await draw();
    await menuOn('Saga/Notes/Ideas.md');
    await click(host.querySelector('[role=menuitem]'));
    expect(host.querySelector('[role=alert]')!.textContent).toContain('That project could not be found.');
  });
});
