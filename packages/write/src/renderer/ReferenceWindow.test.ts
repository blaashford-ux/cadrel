// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReferenceWindow } from './ReferenceWindow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
const readFile = vi.fn(async (p: string) => ({ text: `text of ${p}`, stamp: { mtimeMs: 1, size: 1 } }));
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  (window as unknown as { cadrelWrite: unknown }).cadrelWrite = { readFile };
  readFile.mockClear();
});
afterEach(() => host.remove());

const root = { kind: 'dir' as const, name: 'p', path: '/p', children: [{ kind: 'file' as const, name: 'a.md', path: '/p/a.md' }, { kind: 'file' as const, name: 'b.md', path: '/p/Notes/b.md' }] };
const show = async (onClose = vi.fn()) => act(async () => createRoot(host).render(createElement(ReferenceWindow, { root, base: '/p', onClose })));

describe('Check Reference', () => {
  it('floats over the app without a backdrop, so the editor behind it stays usable', async () => {
    await show();
    expect(host.querySelector('.ref-window')).not.toBeNull();
    expect(host.querySelector('.modal-backdrop')).toBeNull();
    expect(host.querySelector('[aria-modal]')).toBeNull();
  });

  it('lists the files, filters them, and shows the one picked as read-only text', async () => {
    await show();
    const items = () => [...host.querySelectorAll<HTMLButtonElement>('.ref-item')];
    expect(items().map((b) => b.textContent)).toEqual(['a.md', 'Notes/b.md']);
    await act(async () => items()[1]!.click());
    expect(readFile).toHaveBeenCalledWith('/p/Notes/b.md');
    expect(host.querySelector('.ref-text')!.textContent).toBe('text of /p/Notes/b.md');
    expect(host.querySelector('textarea, [contenteditable="true"], input')).toBeNull();
  });

  it('closes from its button', async () => {
    const onClose = vi.fn();
    await show(onClose);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close reference"]')!.click());
    expect(onClose).toHaveBeenCalled();
  });
});
