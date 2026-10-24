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
const exportAiKit = vi.fn(async () => 'C:\\Users\\me\\Downloads\\MDEdit AI Kit');
let remote = { enabled: false, running: false, port: 47831, token: 'tok-0123456789abcdefghij', mcpUrl: 'http://127.0.0.1:47831/mcp', apiUrl: 'http://127.0.0.1:47831/api', openApiUrl: 'http://127.0.0.1:47831/openapi.json', error: null as string | null };
const setAiRemote = vi.fn(async (enabled: boolean) => (remote = { ...remote, enabled, running: enabled }));
const resetAiRemoteToken = vi.fn(async () => (remote = { ...remote, token: 'fresh-0123456789abcdefghij' }));
const deleteReview = vi.fn(async (_p: string, id: string) => {
  files = files.filter((f) => f.id !== id);
});

beforeEach(() => {
  remote = { ...remote, enabled: false, running: false, token: 'tok-0123456789abcdefghij' };
  host = document.createElement('div');
  document.body.appendChild(host);
  files = [
    { id: 'owner', text: reviewFile('owner', 'Me', 1) },
    { id: 'ai-claude-line', text: reviewFile('ai-claude-line', 'Claude · Line edit', 3) },
  ];
  (window as unknown as { mdedit: unknown }).mdedit = {
    getAiServer: async () => ({ root: 'C:\\Users\\me\\MDEdit', command: 'C:\\Program Files\\MDEdit\\MDEdit.exe', args: ['C:\\x\\mdedit-mcp.js', '--root', 'C:\\Users\\me\\MDEdit'], env: { ELECTRON_RUN_AS_NODE: '1' } }),
    listReviews: async () => files,
    deleteReview,
    exportAiKit,
    getAiRemote: async () => remote,
    setAiRemote,
    resetAiRemoteToken,
  };
});
afterEach(() => host.remove());

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const button = (text: RegExp) => [...host.querySelectorAll('button')].find((b) => text.test(b.textContent ?? ''))!;

describe('AiDialog', () => {
  it('shows ready-made settings and the AI reviewers, and deletes one after a confirmation', async () => {
    const root = createRoot(host);
    await act(async () => root.render(createElement(AiDialog, { project: '/p', projectName: 'The Lost King', onClose: () => undefined })));
    await settle();

    const text = host.textContent ?? '';
    expect(text).toContain('C:\\Users\\me\\MDEdit');
    expect(host.querySelectorAll('pre')).toHaveLength(3);
    expect(host.querySelector('pre')!.textContent).toContain('claude mcp add --env ELECTRON_RUN_AS_NODE=1 mdedit --');
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

  it('saves the AI Kit to Downloads and says where', async () => {
    const root = createRoot(host);
    await act(async () => root.render(createElement(AiDialog, { project: '/p', projectName: 'P', onClose: () => undefined })));
    await settle();
    await act(async () => button(/Save files to Downloads/).click());
    await settle();
    expect(exportAiKit).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('Saved to C:\\Users\\me\\Downloads\\MDEdit AI Kit');
    await act(async () => root.unmount());
  });

  it('keeps online access off until turned on, then shows the addresses and token, and can replace the token', async () => {
    const root = createRoot(host);
    await act(async () => root.render(createElement(AiDialog, { project: '/p', projectName: 'P', onClose: () => undefined })));
    await settle();
    expect(host.textContent).toContain('Online apps');
    expect(host.textContent).not.toContain('tok-0123456789abcdefghij'); // the token is not shown while it's off
    expect(host.textContent).toContain('Anyone with the tunnel address and the token'); // the risk is explained up front

    await act(async () => button(/^Turn on$/).click());
    await settle();
    expect(setAiRemote).toHaveBeenCalledWith(true);
    expect(host.textContent).toContain('http://127.0.0.1:47831/openapi.json');
    expect(host.textContent).toContain('tok-0123456789abcdefghij');

    await act(async () => button(/Make a new token/).click());
    await settle();
    expect(resetAiRemoteToken).toHaveBeenCalled();
    expect(host.textContent).toContain('fresh-0123456789abcdefghij');
    expect(host.textContent).not.toContain('tok-0123456789abcdefghij');

    await act(async () => button(/^Turn off$/).click());
    await settle();
    expect(setAiRemote).toHaveBeenLastCalledWith(false);
    await act(async () => root.unmount());
  });

  it('says so when the build has no AI connection', async () => {
    (window as unknown as { mdedit: { getAiServer: () => Promise<null> } }).mdedit.getAiServer = async () => null;
    const root = createRoot(host);
    await act(async () => root.render(createElement(AiDialog, { project: '/p', projectName: 'P', onClose: () => undefined })));
    await settle();
    expect(host.textContent).toContain('doesn’t include the AI connection');
    expect(host.querySelectorAll('pre')).toHaveLength(0);
    await act(async () => root.unmount());
  });
});
