// Not type-checked with the app (see harness.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprint, generateKeyPair, invitationLink } from '@cadrel/kernel';
import { StudioClient } from '@cadrel/studio-client';
import { MemoryFs } from '@cadrel/write/src/shared/memoryFs';
import type { CoreApi } from '@cadrel/write/src/shared/api';
import { studio, URL_ } from './harness';
import { StudioRegistry } from '../src/studio/registry';
import { createStudioApi } from '../src/studio/studioApi';
import { studioGuard } from '../src/studio/guard';
import { conflictName, safeName, uniqueName } from '../src/studio/names';

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

describe('the Studios this phone has joined', () => {
  it('remembers them, and which is open, across restarts', async () => {
    const fs = new MemoryFs();
    const key = await generateKeyPair();
    const a = new StudioRegistry(fs, '/b/studios.json');
    await a.load();
    expect(a.active()).toBeNull();
    const id = a.installId;
    await a.add({ id: 's1', name: 'One', url: 'https://one', fingerprint: 'AAAA-AAAA-AAAA-AAAA', role: 'author', me: 'Ann', key, joinedAt: 'x' });
    await a.add({ id: 's2', name: 'Two', url: 'https://two', fingerprint: 'BBBB-BBBB-BBBB-BBBB', role: 'guest', me: 'Ann', key, joinedAt: 'x' });
    expect(a.active()?.id).toBe('s2');
    await a.setActive('s1');
    await expect(a.setActive('nope')).rejects.toThrow(/not joined/);

    const b = new StudioRegistry(fs, '/b/studios.json');
    await b.load();
    expect(b.installId).toBe(id);
    expect(b.list().map((s) => s.id)).toEqual(['s1', 's2']);
    expect(b.active()?.id).toBe('s1');
    await b.remove('s1');
    expect(b.active()?.id).toBe('s2');
    await b.remove('s2');
    expect(b.active()).toBeNull();
  });

  it('survives a damaged file by starting empty', async () => {
    const fs = new MemoryFs();
    fs.seed('/b/studios.json', '{not json');
    const r = new StudioRegistry(fs, '/b/studios.json');
    await r.load();
    expect(r.list()).toEqual([]);
  });
});

describe('joining, switching and leaving', () => {
  const setup = async () => {
    const s = await studio();
    const fs = new MemoryFs();
    const registry = new StudioRegistry(fs, '/b/studios.json');
    await registry.load();
    const reloads = vi.fn();
    const fetchFn = (s.owner as unknown as { o: { fetchFn: typeof fetch } }).o.fetchFn;
    const api = createStudioApi({ registry, fs, fetchFn, reload: reloads, folderOf: (id) => `/b/Studios/${id}` });
    const link = async (role = 'author') => {
      const r = await s.owner.request<{ code: string }>('POST', '/v1/invites', { role, label: 'Ann' });
      return invitationLink({ url: URL_, code: r.code, fingerprint: await fingerprint(s.ownerKey.publicKey), studioName: 'Test Studio' });
    };
    return { s, fs, registry, reloads, api, link };
  };

  it('joins from the invitation link, opens that Studio, and the Studio knows the phone by its key', async () => {
    const { api, registry, reloads, link, s } = await setup();
    const joined = await api.join(await link(), 'Ann');
    expect(joined).toMatchObject({ name: 'Test Studio', me: 'Ann', active: true });
    expect(reloads).toHaveBeenCalledTimes(1);
    expect((await api.list()).map((x) => x.id)).toEqual(['st1']);
    const me = await new StudioClient({ url: URL_, key: registry.active()!.key, fetchFn: (s.owner as never as { o: { fetchFn: typeof fetch } }).o.fetchFn }).me();
    expect(me).toMatchObject({ kind: 'member', name: 'Ann' });
  });

  it('refuses a link that is not an invitation, and one whose owner is not the one named, saying why and sending nothing', async () => {
    const { api, link, reloads } = await setup();
    await expect(api.join('https://example.com', 'Ann')).rejects.toThrow(/not a Cadrel invitation/);
    const wrong = (await link()).replace(/f=[^&]+/, 'f=0000-0000-0000-0000');
    await expect(api.join(wrong, 'Ann')).rejects.toThrow(/does not belong to the owner/);
    expect(reloads).not.toHaveBeenCalled();
  });

  it('switches between Studios and leaves one, removing its files from the phone', async () => {
    const { api, registry, fs, reloads, link } = await setup();
    await api.join(await link(), 'Ann');
    await registry.add({ ...registry.active()!, id: 'other', name: 'Other', joinedAt: 'y' });
    expect(registry.active()?.id).toBe('other');
    await api.switchTo('st1');
    expect(registry.active()?.id).toBe('st1');
    fs.seed('/b/Studios/st1/Projects/Book/a.md', 'x');
    await api.leave('st1');
    expect(registry.list().map((x) => x.id)).toEqual(['other']);
    expect(await fs.stat('/b/Studios/st1')).toBeNull();
    expect(reloads).toHaveBeenCalledTimes(3);
  });
});

describe('what the editor may do', () => {
  const calls: string[] = [];
  const base = new Proxy({} as CoreApi, { get: (_t, name: string) => async () => (calls.push(name), name === 'writeFile' ? { mtimeMs: 1, size: 1 } : '/x') });
  const sync = { assertWritable: vi.fn(), syncSoon: vi.fn() };
  const api = studioGuard(base, sync);

  it('writes and makes files, after asking the Studio’s rules first, and starts a sync', async () => {
    await api.writeFile('/r/Book/a.md', 'x');
    await api.createFile('/r/Book', 'b');
    expect(sync.assertWritable).toHaveBeenCalledWith('/r/Book/a.md');
    expect(sync.assertWritable).toHaveBeenCalledWith('/r/Book');
    expect(sync.syncSoon).toHaveBeenCalledTimes(2);
  });

  it('does not write when the rules say no', async () => {
    sync.assertWritable.mockImplementationOnce(() => {
      throw new Error('You can read this project');
    });
    calls.length = 0;
    await expect(api.writeFile('/r/Book/a.md', 'x')).rejects.toThrow(/can read/);
    expect(calls).toEqual([]);
  });

  it('cannot make, rename, move or delete projects or files, in words', async () => {
    calls.length = 0;
    await expect(api.createProject('X', 'novel')).rejects.toThrow(/Cadrel on the desktop/);
    await expect(api.renameProject('/p', 'Y')).rejects.toThrow(/managed in Cadrel/);
    await expect(api.deleteProject('/p')).rejects.toThrow(/managed in Cadrel/);
    await expect(api.renameNode('/p/a.md', 'b')).rejects.toThrow(/history/);
    await expect(api.trashNode('/p/a.md')).rejects.toThrow(/history/);
    expect(calls).toEqual([]);
  });
});

describe('names', () => {
  it('makes names safe, unique and recognisable', () => {
    expect(safeName('Book 1: The "Start"?')).toBe('Book 1- The -Start--');
    expect(safeName('  ..  ')).toBe('Project');
    expect(uniqueName('Book', ['book', 'Book 2'])).toBe('Book 3');
    expect(conflictName('Draft.md', 'Pixel 8', new Date('2026-11-06T10:00:00Z'))).toBe('Draft (conflict Pixel 8 2026-11-06).md');
    expect(conflictName('Notes', 'Pixel 8', new Date('2026-11-06T10:00:00Z'))).toBe('Notes (conflict Pixel 8 2026-11-06)');
  });
});
