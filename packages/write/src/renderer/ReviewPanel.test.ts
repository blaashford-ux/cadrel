// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewPanel } from './ReviewPanel';
import type { ReviewState, ShownItem } from './useReview';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const note = (id: string, o: Partial<ShownItem> = {}): ShownItem => ({
  id, kind: 'comment', file: 'f.md', anchor: { quote: `text of ${id}`, prefix: '', suffix: '', start: 0 }, body: `body ${id}`, status: 'open', author: 'Claude', createdAt: id, updatedAt: id, replies: [],
  reviewerId: 'ai-claude', reviewerName: 'Claude', ...o,
});
const state = (items: ShownItem[]): ReviewState => ({
  items, detached: new Set(), add: vi.fn(), selection: () => null, setStatus: vi.fn(async () => undefined), reply: vi.fn(async () => undefined), remove: vi.fn(async () => undefined),
  accept: vi.fn(async () => null), focus: vi.fn(), reload: vi.fn(), setCategory: vi.fn(async () => undefined),
});

let host: HTMLDivElement;
let scrollTo: ReturnType<typeof vi.fn>;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  scrollTo = vi.fn();
  HTMLElement.prototype.scrollTo = scrollTo as never;
});
afterEach(() => host.remove());

const render = async (items: ShownItem[], focus: { id: string; n: number } | null) => {
  const root = createRoot(host);
  const props = (f: typeof focus) => ({ state: state(items), me: { id: 'owner', name: 'Me' }, role: 'owner' as const, onRename: () => undefined, onClose: () => undefined, focus: f });
  await act(async () => root.render(createElement(ReviewPanel, props(focus))));
  return { root, again: (f: typeof focus) => act(async () => root.render(createElement(ReviewPanel, props(f)))) };
};
const rows = () => [...host.querySelectorAll<HTMLElement>('[data-note-id]')];
const focused = () => host.querySelector<HTMLElement>('.review-item.focused')?.dataset.noteId;

describe('clicking the text of a note', () => {
  it('marks that note in the list and scrolls it to the top', async () => {
    const items = ['a', 'b', 'c'].map((id) => note(id));
    const { again, root } = await render(items, null);
    expect(focused()).toBeUndefined();
    await again({ id: 'c', n: 1 });
    expect(focused()).toBe('c');
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect((scrollTo.mock.calls[0][0] as { top: number }).top).toBe(0); // jsdom has no layout: the offset arithmetic is exercised in the browser
    expect(host.querySelector('.review-list')?.className).toContain('has-focus'); // room below the last note so it can reach the top
    await again({ id: 'a', n: 2 });
    expect(focused()).toBe('a');
    expect(scrollTo).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it('shows the note even when a filter or "finished" would hide it', async () => {
    const items = [note('a'), note('b', { reviewerId: 'sam', reviewerName: 'Sam', category: 'style' }), note('c', { status: 'resolved' })];
    const { again, root } = await render(items, null);
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Show notes from"]')!;
    await act(async () => {
      select.value = 'sam';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(rows().map((r) => r.dataset.noteId)).toEqual(['b']);
    await again({ id: 'a', n: 1 }); // another reviewer's note
    expect(rows().map((r) => r.dataset.noteId)).toContain('a');
    expect(focused()).toBe('a');
    await again({ id: 'c', n: 2 }); // a finished note
    expect(rows().map((r) => r.dataset.noteId)).toContain('c');
    expect(focused()).toBe('c');
    await act(async () => root.unmount());
  });

  it('ignores a note that is not in the list', async () => {
    const { again, root } = await render([note('a')], null);
    await again({ id: 'zzz', n: 1 });
    expect(focused()).toBeUndefined();
    expect(scrollTo).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});

describe('the "This chapter only" switch', () => {
  const mount = async (items: ShownItem[], inChapter: Set<string> | null) => {
    const root = createRoot(host);
    await act(async () => root.render(createElement(ReviewPanel, { state: state(items), me: { id: 'owner', name: 'Me' }, role: 'owner', onRename: () => undefined, onClose: () => undefined, inChapter })));
    return root;
  };
  const sw = () => host.querySelector<HTMLInputElement>('input[role=switch]');
  beforeEach(() => localStorage.clear());

  it('is not offered for a one-chapter file', async () => {
    const root = await mount([note('a')], null);
    expect(sw()).toBeNull();
    await act(async () => root.unmount());
  });

  it('limits the list to the notes in the open chapter, and remembers the choice', async () => {
    const items = ['a', 'b', 'c'].map((id) => note(id));
    const root = await mount(items, new Set(['b']));
    expect(rows().map((r) => r.dataset.noteId)).toEqual(['a', 'b', 'c']); // off by default
    await act(async () => sw()!.click());
    expect(rows().map((r) => r.dataset.noteId)).toEqual(['b']);
    expect(localStorage.getItem('mdedit.notes.chapterOnly')).toBe('1');
    await act(async () => root.unmount());
    const again = await mount(items, new Set(['b']));
    expect(sw()!.checked).toBe(true); // still on the next time the panel opens
    expect(rows().map((r) => r.dataset.noteId)).toEqual(['b']);
    await act(async () => again.unmount());
  });

  it('says so when the chapter has no open notes', async () => {
    localStorage.setItem('mdedit.notes.chapterOnly', '1');
    const root = await mount([note('a')], new Set());
    expect(host.querySelector('.review-empty')?.textContent).toBe('No open notes in this chapter.');
    await act(async () => root.unmount());
  });
});

describe('topics', () => {
  const mount = async (items: ShownItem[], role: 'owner' | 'reviewer', me = { id: 'owner', name: 'Me' }, extra: Record<string, unknown> = {}) => {
    const st = state(items);
    Object.assign(st, extra);
    const root = createRoot(host);
    await act(async () => root.render(createElement(ReviewPanel, { state: st, me, role, onRename: () => undefined, onClose: () => undefined })));
    return { st, root };
  };
  const type = async (el: HTMLInputElement, value: string) => {
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const click = (el: Element | null) => act(async () => void (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })));

  it('lets the author give an AI note a topic, and change or clear one', async () => {
    const { st, root } = await mount([note('a'), note('b', { category: 'pacing' })], 'owner');
    await click(host.querySelector('[data-note-id="a"] .review-cat.add'));
    const input = host.querySelector<HTMLInputElement>('[data-note-id="a"] .review-topic-edit input')!;
    await type(input, '  Continuity ');
    await act(async () => void host.querySelector('[data-note-id="a"] .review-topic-edit')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(st.setCategory).toHaveBeenCalledWith('a', '  Continuity ');
    await click(host.querySelector('[data-note-id="b"] .review-cat.editable'));
    const clear = [...host.querySelectorAll('[data-note-id="b"] .review-topic-edit button')].find((b) => b.textContent === 'Clear');
    await click(clear ?? null);
    expect(st.setCategory).toHaveBeenCalledWith('b', '');
    await act(async () => root.unmount());
  });

  it('lets a reviewer retag only their own notes', async () => {
    const mine = note('m', { reviewerId: 'sam', reviewerName: 'Sam', category: 'style' });
    const theirs = note('t', { category: 'style' });
    const { root } = await mount([mine, theirs], 'reviewer', { id: 'sam', name: 'Sam' });
    expect(host.querySelector('[data-note-id="m"] .review-cat.editable')).not.toBeNull();
    expect(host.querySelector('[data-note-id="t"] .review-cat.editable')).toBeNull();
    expect(host.querySelector('[data-note-id="t"] .review-cat')?.textContent).toBe('style');
    expect(host.querySelector('[data-note-id="t"] .review-cat.add')).toBeNull();
    await act(async () => root.unmount());
  });

  it('suggests the topics in use and the standard ones, and sends the topic with a new note', async () => {
    const sel = { anchor: { quote: 'some words', prefix: '', suffix: '', start: 0 }, oneBlock: true };
    const { st, root } = await mount([note('a', { category: 'worldbuilding' })], 'owner', undefined, { selection: () => sel });
    const options = [...host.querySelectorAll('#review-topics option')].map((o) => (o as HTMLOptionElement).value);
    expect(options[0]).toBe('worldbuilding');
    expect(options).toContain('pacing');
    expect(options.filter((o) => o === 'worldbuilding')).toHaveLength(1);
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Add note on selection') ?? null);
    const area = host.querySelector<HTMLTextAreaElement>('.review-compose textarea[autofocus], .review-compose textarea:last-of-type')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(area, 'Too slow here');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await type(host.querySelector<HTMLInputElement>('.review-compose input[list="review-topics"]')!, 'pacing');
    await click([...host.querySelectorAll('.review-compose button')].find((b) => b.textContent === 'Add') ?? null);
    expect(st.add).toHaveBeenCalledWith(sel, 'comment', 'Too slow here', undefined, 'pacing');
    await act(async () => root.unmount());
  });
});
