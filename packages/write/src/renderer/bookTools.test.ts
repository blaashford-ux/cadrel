// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TextBlock } from '../shared/textBlocks';
import { BackMatterForm } from './bookForms';
import { defaultBookDetails } from '../shared/export/model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let blocks: TextBlock[];
const saveTextBlock = vi.fn(async (i: { kind: 'back'; name: string; text: string }) => {
  const b = { id: `b${blocks.length}`, ...i, updatedAt: '' } as TextBlock;
  blocks = [...blocks, b];
  return b;
});
const kit = {
  profile: { displayName: 'Ann', penNames: ['Ann Pen'], bio: 'Ann writes.', patreonUrl: 'https://www.patreon.com/ann', patreonCta: 'Read ahead.' },
  books: [{ asin: 'B0AAAAAAA1', title: 'Saga 1', url: 'https://www.amazon.com/dp/B0AAAAAAA1', penNames: ['Ann Pen'], series: 'Saga', position: 1 }, { asin: 'B0AAAAAAA2', title: 'Saga 2', url: 'https://www.amazon.com/dp/B0AAAAAAA2', penNames: ['Ann Pen'], series: 'Saga', position: 2 }]
};
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  blocks = [{ id: 'x', kind: 'back', name: 'Short bio', text: 'A short bio.', updatedAt: '' }];
  (window as unknown as { cadrelWrite: unknown }).cadrelWrite = { authorKit: async () => kit, listTextBlocks: async () => blocks, saveTextBlock, deleteTextBlock: async () => undefined };
  saveTextBlock.mockClear();
});
afterEach(() => host.remove());


async function show(patch: (d: ReturnType<typeof defaultBookDetails>) => void) {
  const d = defaultBookDetails({ title: 'Current', author: 'Ann Pen' });
  patch(d);
  let latest = d;
  const render = (root: ReturnType<typeof createRoot>) => root.render(createElement(BackMatterForm, { details: latest, set: (p) => { latest = { ...latest, ...p } as typeof d; render(root); } }));
  const root = createRoot(host);
  await act(async () => render(root));
  await act(async () => undefined); // the lookups settle
  return { get: () => latest };
}
const button = (label: RegExp) => [...host.querySelectorAll('button')].find((b) => label.test(b.textContent ?? ''));

describe('Book Details conveniences', () => {
  it('Also by: adds every book of this author from My Books in one click, with links, once', async () => {
    const f = await show((d) => (d.back.alsoBy.enabled = true));
    await act(async () => button(/Add all 2 by Ann Pen/)!.click());
    expect(f.get().back.alsoBy.items.map((i) => [i.title, i.url])).toEqual([['Saga 1', 'https://www.amazon.com/dp/B0AAAAAAA1'], ['Saga 2', 'https://www.amazon.com/dp/B0AAAAAAA2']]);
    expect(button(/Add all/)).toBeUndefined(); // nothing left to add
  });

  it('a saved back-matter block is put into the About page, and a bio from the profile too', async () => {
    const f = await show((d) => (d.back.about.enabled = true));
    await act(async () => button(/^Use$/)!.click());
    expect(f.get().back.about.text).toBe('A short bio.');
    await act(async () => button(/Use my profile bio/)!.click());
    expect(f.get().back.about.text).toBe('A short bio.\n\nAnn writes.');
  });

  it('saves what is typed in a field as a named block', async () => {
    const f = await show((d) => { d.back.custom.enabled = true; d.back.custom.text = 'Thank you for reading.'; });
    const tools = [...host.querySelectorAll('.block-tools')].at(-1)!;
    await act(async () => [...tools.querySelectorAll('button')].find((b) => /Save as block/.test(b.textContent ?? ''))!.click());
    const input = tools.querySelector<HTMLInputElement>('input[aria-label="Name for this block"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Thanks');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => [...tools.querySelectorAll('button')].find((b) => b.textContent === 'Save')!.click());
    expect(saveTextBlock).toHaveBeenCalledWith({ kind: 'back', name: 'Thanks', text: 'Thank you for reading.' });
    void f;
  });

  it('Patreon: shows what the profile will supply, or says the profile has none', async () => {
    await show((d) => (d.back.patreon.enabled = true));
    expect(host.querySelector('[aria-label="Patreon page preview"]')!.textContent).toContain('https://www.patreon.com/ann');
    host.innerHTML = '';
    kit.profile.patreonUrl = '';
    await show((d) => (d.back.patreon.enabled = true));
    expect(host.textContent).toMatch(/no Patreon link yet/);
  });
});
