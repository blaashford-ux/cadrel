// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileLock } from '../shared/api';
import { FileLockBar } from './FileLockBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
const onCheckOut = vi.fn();
const onCheckIn = vi.fn();
const onUndo = vi.fn();
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  for (const f of [onCheckOut, onCheckIn, onUndo]) f.mockClear();
});
afterEach(() => host.remove());

const show = async (lock: FileLock, extra: { busy?: boolean; error?: string | null } = {}) => {
  const root = createRoot(host);
  await act(async () => root.render(createElement(FileLockBar, { lock, name: 'Chapter 1.md', busy: extra.busy ?? false, error: extra.error ?? null, onCheckOut, onCheckIn, onUndo })));
  return root;
};
const button = (label: RegExp) => [...host.querySelectorAll('button')].find((b) => label.test(b.textContent ?? ''));

describe('the check-out bar above an open file', () => {
  it('shows nothing for a file that is not kept in a vault', async () => {
    await show({ kind: 'unmanaged' });
    expect(host.textContent).toBe('');
  });

  it('says a checked-in file is read-only and offers Check out', async () => {
    await show({ kind: 'free', version: 3 });
    expect(host.textContent).toMatch(/Checked in · version 3 · read-only/);
    await act(async () => button(/Check out to edit/)!.click());
    expect(onCheckOut).toHaveBeenCalledWith(false);
  });

  it('says who has it when someone else does, with nothing to press', async () => {
    await show({ kind: 'other', version: 2, by: 'Ann Author', since: '2026-11-01T10:00:00Z' });
    expect(host.textContent).toMatch(/Checked out by Ann Author/);
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });

  it('offers Check out keeping the changes for a file changed without a check-out', async () => {
    await show({ kind: 'unprotected', version: 1 });
    await act(async () => button(/keeping my changes/)!.click());
    expect(onCheckOut).toHaveBeenCalledWith(true);
  });

  it('asks what changed, then checks in with the words; or gives the check-out up', async () => {
    await show({ kind: 'mine', version: 1, since: '2026-11-01T10:00:00Z', changed: false });
    await act(async () => button(/Check in…/)!.click());
    const input = host.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Tightened the opening');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(onCheckIn).toHaveBeenCalledWith('Tightened the opening');
    await act(async () => button(/Undo check-out/)!.click());
    expect(onUndo).toHaveBeenCalled(); // nothing was changed, so no question first
  });

  it('shows the host’s words when a check-out is refused', async () => {
    await show({ kind: 'free', version: 1 }, { error: 'Someone has just checked this file out.' });
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/Someone has just checked/);
  });
});
