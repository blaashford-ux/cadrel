import { describe, expect, it } from 'vitest';
import { JOIN_PAGE } from '../src/shared/review/link';
import { pickInBrowser } from './pickerBrowser';

const page = `${JOIN_PAGE}#mode=pick&t=tok&p=aaa&c=bbb&ret=1`;
/** What the invitation page does in the browser: follow the `ret` link it was given, plus the answer. */
const answer = async (opened: string, suffix: string) => {
  const ret = new URLSearchParams(new URL(opened).hash.slice(1)).get('ret')!;
  return fetch(`${ret}${suffix}`);
};

describe('pickInBrowser', () => {
  it('opens the page with a loopback return address and resolves to the picked ids', async () => {
    let opened = '';
    const p = pickInBrowser(page, async (u) => void (opened = u));
    await new Promise((r) => setTimeout(r, 50));
    const ret = new URLSearchParams(new URL(opened).hash.slice(1)).get('ret')!;
    expect(ret).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/picked\?state=[\w-]+$/);
    expect(new URLSearchParams(new URL(opened).hash.slice(1)).get('t')).toBe('tok'); // the rest of the page's parameters are kept
    const res = await answer(opened, '&ids=abc123%2Cdef456');
    expect(res.status).toBe(200);
    expect(await p).toEqual(['abc123', 'def456']);
  });

  it('resolves to null when the picker is cancelled', async () => {
    let opened = '';
    const p = pickInBrowser(page, async (u) => void (opened = u));
    await new Promise((r) => setTimeout(r, 50));
    await answer(opened, '&cancelled=1');
    expect(await p).toBeNull();
  });

  it('ignores requests without the right state, and unsafe ids', async () => {
    let opened = '';
    const p = pickInBrowser(page, async (u) => void (opened = u));
    await new Promise((r) => setTimeout(r, 50));
    const ret = new URLSearchParams(new URL(opened).hash.slice(1)).get('ret')!;
    const wrong = await fetch(ret.replace(/state=[\w-]+/, 'state=nope') + '&ids=evil');
    expect(wrong.status).toBe(404);
    await answer(opened, '&ids=a%2F..%2Fb,ok_id1');
    expect(await p).toEqual(['ok_id1']);
  });

  it('refuses pages that are not the invitation page, and gives up after the timeout', async () => {
    await expect(pickInBrowser('https://evil.example/', async () => undefined)).rejects.toThrow(/outside/);
    expect(await pickInBrowser(page, async () => undefined, 50)).toBeNull();
  });

  it('fails when the browser cannot be opened', async () => {
    await expect(pickInBrowser(page, async () => Promise.reject(new Error('no browser')))).rejects.toThrow(/no browser/);
  });
});
