import { describe, expect, it, vi } from 'vitest';
import { pickAll, shortIds } from './pickFiles';

const need = ['pkg123456', 'cmt654321'];

describe('pickAll', () => {
  it('is done after one round when both files are picked', async () => {
    const pick = vi.fn(async () => ['cmt654321', 'pkg123456']);
    expect(await pickAll(need, pick)).toEqual({ done: true });
    expect(pick).toHaveBeenCalledTimes(1);
    expect(pick).toHaveBeenCalledWith(need);
  });

  it('asks again for just the missing file when only one was picked', async () => {
    const pick = vi.fn(async (missing: string[]) => (missing.length === 2 ? ['pkg123456'] : ['cmt654321']));
    expect(await pickAll(need, pick)).toEqual({ done: true });
    expect(pick.mock.calls.map((c) => c[0])).toEqual([need, ['cmt654321']]);
  });

  it('stops quietly when the picker is cancelled', async () => {
    const pick = vi.fn(async (missing: string[]) => (missing.length === 2 ? ['pkg123456'] : null));
    expect(await pickAll(need, pick)).toEqual({ done: false, cancelled: true });
  });

  it('gives up with what came back when the picker keeps returning other files', async () => {
    const pick = vi.fn(async () => ['zzzzzzzzz']);
    const r = await pickAll(need, pick, 3);
    expect(pick).toHaveBeenCalledTimes(3);
    expect(r).toEqual({ done: false, cancelled: false, missing: need, got: [['zzzzzzzzz'], ['zzzzzzzzz'], ['zzzzzzzzz']] });
  });

  it('ignores files that were not asked for', async () => {
    const pick = vi.fn(async (missing: string[]) => (missing.length === 2 ? ['other0000', 'pkg123456'] : ['cmt654321']));
    expect(await pickAll(need, pick)).toEqual({ done: true });
  });
});

describe('shortIds', () => {
  it('shortens ids for the error message', () => {
    expect(shortIds(['abcdefghijkl', 'mnopqrstuvwx'])).toBe('abcdef…, mnopqr…');
    expect(shortIds([])).toBe('nothing');
  });
});
