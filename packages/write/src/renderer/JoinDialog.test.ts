// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JoinDialog } from './JoinDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const studioLink = 'cadrel-reader://join?s=https%3A%2F%2Fstudio.example&c=abcdefghijklmnop&f=ABCD-ABCD-ABCD-ABCD&n=Acme';
const shared = { reviewerId: 'rev12345', dir: '/x', project: 'Book' };
let host: HTMLDivElement;
const joinReview = vi.fn(async (_link: string, _name: string) => shared);
const onJoined = vi.fn();

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  joinReview.mockClear();
  onJoined.mockClear();
  (window as unknown as { cadrelWrite: unknown }).cadrelWrite = { joinReview, capabilities: { reader: true } };
});
afterEach(() => host.remove());

const setValue = (el: HTMLInputElement, v: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const open = async (initialLink = '') => {
  const root = createRoot(host);
  await act(async () => root.render(createElement(JoinDialog, { initialLink, onJoined, onClose: () => undefined })));
  return root;
};
const continueButton = () => [...host.querySelectorAll('button')].find((b) => /Continue/.test(b.textContent ?? ''))!;

describe('the invitation dialog', () => {
  it('starts with the invitation the app was opened with and joins the Studio', async () => {
    await open(studioLink);
    expect((host.querySelector('input') as HTMLInputElement).value).toBe(studioLink);
    expect(host.textContent).toContain('joins the author’s Studio');
    expect(continueButton().disabled).toBe(false);
    await act(async () => continueButton().click());
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    expect(joinReview).toHaveBeenCalledWith(studioLink, expect.any(String));
    expect(onJoined).toHaveBeenCalledWith(shared);
  });

  it('finds the link in a whole pasted message', async () => {
    await open();
    await act(async () => setValue(host.querySelector('input')!, `Hi Bea, please read my book: ${studioLink} thanks!`));
    expect(continueButton().disabled).toBe(false);
    await act(async () => continueButton().click());
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    expect(joinReview).toHaveBeenCalledWith(studioLink, expect.any(String));
  });

  it('refuses anything that is not a Cadrel invitation, including an old Google Drive link', async () => {
    await open('https://blaashford-ux.github.io/cadrel/join/#v=1&p=a&c=b&r=cccc');
    expect(continueButton().disabled).toBe(true);
    expect(host.querySelector('.modal-error')?.textContent).toMatch(/doesn’t look like a Cadrel invitation/);
    expect(joinReview).not.toHaveBeenCalled();
  });

  it('says why when the Studio refuses', async () => {
    joinReview.mockRejectedValueOnce(new Error('This invitation is for the role “author”, which Cadrel Reader can’t use.'));
    await open(studioLink);
    await act(async () => continueButton().click());
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    expect(host.querySelector('.modal-error')?.textContent).toMatch(/can’t use/);
    expect(onJoined).not.toHaveBeenCalled();
  });
});
