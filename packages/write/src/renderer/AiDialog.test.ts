// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newReviewFile, serializeReviewFile } from '../shared/review/comments';
import { AiDialog } from './AiDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const reviewFile = (id: string, name: string, n: number) =>
  serializeReviewFile({
    ...newReviewFile('P', { id, name }),
    items: Array.from({ length: n }, (_, i) => ({ id: `${id}${i}`, kind: 'comment' as const, file: 'f.md', anchor: { quote: 'q', prefix: '', suffix: '', start: 0 }, body: 'b', status: 'open' as const, origin: id.startsWith('ai-') ? ('ai' as const) : undefined, author: name, createdAt: '', updatedAt: '', replies: [] })),
  });

let host: HTMLDivElement;
let files: { id: string; text: string }[];
const deleteReview = vi.fn(async (_p: string, id: string) => {
  files = files.filter((f) => f.id !== id);
});

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  files = [
    { id: 'owner', text: reviewFile('owner', 'Me', 1) },
    { id: 'ai-claude-line', text: reviewFile('ai-claude-line', 'Claude · Line edit', 3) },
  ];
  (window as unknown as { cadrelWrite: unknown }).cadrelWrite = {
    listReviews: async () => files,
    deleteReview,
  };
});
afterEach(() => host.remove());

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const button = (text: RegExp) => [...host.querySelectorAll('button')].find((b) => text.test(b.textContent ?? ''))!;

describe('AiDialog', () => {
  it('lists the AI reviewers, and deletes one after a confirmation', async () => {
    const root = createRoot(host);
    await act(async () => root.render(createElement(AiDialog, { project: '/p', projectName: 'The Lost King', onClose: () => undefined })));
    await settle();

    const text = host.textContent ?? '';
    expect(text).toContain('Extensions'); // where to connect an AI app
    expect(host.querySelectorAll('pre')).toHaveLength(0);
    expect(text).toContain('Claude · Line edit');
    expect(text).toContain('3 open of 3 notes');
    expect(text).not.toContain('Me3'); // the author's own file isn't listed

    await act(async () => button(/Delete all/).click());
    expect(deleteReview).not.toHaveBeenCalled(); // asks first
    await act(async () => button(/Yes, delete 3/).click());
    await settle();
    expect(deleteReview).toHaveBeenCalledWith('/p', 'ai-claude-line');
    expect(host.textContent).toContain('None yet.');
    await act(async () => root.unmount());
  });
});
