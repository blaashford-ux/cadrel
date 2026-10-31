// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildInviteLink } from '../shared/review/link';
import { JoinDialog } from './JoinDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const link = buildInviteLink({ packageId: 'pkgFILE123', commentsId: 'cmtFILE456', reviewerId: 'rev12345', project: 'Book' });
let host: HTMLDivElement;
const shared = { reviewerId: 'rev12345', dir: '/x', name: 'Book' };
const joinReview = vi.fn(async () => shared);
const onJoined = vi.fn();
let rounds: (string[] | null)[];
const pickInBrowser = vi.fn(async (_url: string) => rounds.shift() ?? null);

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  joinReview.mockClear();
  onJoined.mockClear();
  pickInBrowser.mockClear();
  (window as unknown as { cadrelWrite: unknown }).cadrelWrite = { pickerToken: async () => 'tok', pickInBrowser, joinReview };
});
afterEach(() => host.remove());

const setValue = (el: HTMLInputElement, v: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const run = async () => {
  const root = createRoot(host);
  await act(async () => root.render(createElement(JoinDialog, { onJoined, onClose: () => undefined })));
  await act(async () => setValue(host.querySelector('input')!, link));
  await act(async () => [...host.querySelectorAll('button')].find((b) => /Continue/.test(b.textContent ?? ''))!.click());
  await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
  return root;
};
const askedFor = (call: number) => new URLSearchParams(new URL(pickInBrowser.mock.calls[call][0]).hash.slice(1));

describe('JoinDialog with the picker in the browser', () => {
  it('joins after one round when both files are picked', async () => {
    rounds = [['cmtFILE456', 'pkgFILE123']];
    await run();
    expect(pickInBrowser).toHaveBeenCalledTimes(1);
    expect(joinReview).toHaveBeenCalledTimes(1);
    expect(onJoined).toHaveBeenCalledWith(shared);
  });

  it('asks for the other file when only one was picked, instead of sending the person back to the start', async () => {
    rounds = [['pkgFILE123'], ['cmtFILE456']];
    await run();
    expect(pickInBrowser).toHaveBeenCalledTimes(2);
    expect(askedFor(0).get('p')).toBe('pkgFILE123');
    expect(askedFor(0).get('c')).toBe('cmtFILE456');
    expect(askedFor(1).get('p')).toBe('cmtFILE456'); // only the missing file the second time
    expect(askedFor(1).get('c')).toBe('');
    expect(onJoined).toHaveBeenCalledTimes(1);
  });

  it('shows what came back when Google keeps returning the wrong files', async () => {
    rounds = [['aaaaaaaa'], ['aaaaaaaa'], ['aaaaaaaa'], ['aaaaaaaa']];
    await run();
    expect(onJoined).not.toHaveBeenCalled();
    expect(host.querySelector('.modal-error')?.textContent).toContain('didn’t return the project’s files');
  });

  it('stays quiet when the picker is cancelled', async () => {
    rounds = [null];
    await run();
    expect(onJoined).not.toHaveBeenCalled();
    expect(host.querySelector('.modal-error')).toBeNull();
  });
});

describe('JoinDialog in Cadrel Reader', () => {
  const asReader = () => {
    (window as unknown as { cadrelWrite: unknown }).cadrelWrite = { pickerToken: async () => 'tok', pickInBrowser, joinReview, capabilities: { reader: true } };
  };
  const open = async (initialLink: string) => {
    const root = createRoot(host);
    await act(async () => root.render(createElement(JoinDialog, { initialLink, onJoined, onClose: () => undefined })));
    return root;
  };
  const continueButton = () => [...host.querySelectorAll('button')].find((b) => /Continue/.test(b.textContent ?? ''))!;

  it('starts with the link the app was opened with', async () => {
    asReader();
    await open(link);
    expect((host.querySelector('input') as HTMLInputElement).value).toBe(link);
    expect(continueButton().disabled).toBe(false);
    expect(host.textContent).toContain('Cadrel Reader is allowed to open this one project');
  });

  it('refuses an invitation to edit before Google’s picker is ever opened', async () => {
    asReader();
    const editLink = buildInviteLink({ packageId: 'pkgFILE123', commentsId: 'cmtFILE456', reviewerId: 'rev12345', project: 'Book', role: 'edit' });
    await open(editLink);
    expect(continueButton().disabled).toBe(true);
    expect(host.querySelector('.modal-error')?.textContent).toMatch(/Cadrel Reader can’t do.*Cadrel Write/);
    expect(pickInBrowser).not.toHaveBeenCalled();
  });

  it('tells the invitation page it is Cadrel Reader asking, so the phone is handed back to Reader', async () => {
    asReader();
    rounds = [['pkgFILE123', 'cmtFILE456']];
    const root = await open(link);
    await act(async () => continueButton().click());
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    expect(askedFor(0).get('app')).toBe('reader');
    expect(askedFor(0).get('ret')).toBe('1');
    root.unmount();
  });
});
