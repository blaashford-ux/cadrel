import { mkdtemp, readdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { UserStore } from '../src/userStore';

let dir: string, src: string, store: UserStore;
beforeEach(async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'cadrel-user-'));
  dir = path.join(base, 'user');
  src = path.join(base, 'src');
  await import('node:fs/promises').then((f) => f.mkdir(src));
  store = new UserStore(dir);
});
const file = async (name: string, content: string | Buffer) => {
  const p = path.join(src, name);
  await writeFile(p, content);
  return p;
};

describe('UserStore', () => {
  it('reading creates nothing; a profile persists across instances', async () => {
    expect((await store.read()).displayName).toBe('');
    await expect(stat(dir)).rejects.toThrow();
    await store.update({ displayName: 'Blake', penNames: ['Ashe Wilder'] });
    const again = await new UserStore(dir).read();
    expect(again).toMatchObject({ displayName: 'Blake', penNames: ['Ashe Wilder'] });
    expect(again.id).toMatch(/^u_/);
  });

  it('keeps the same user id across changes', async () => {
    const a = await store.update({ displayName: 'A' });
    const b = await store.update({ bio: 'hi' });
    expect(b.id).toBe(a.id);
  });

  it('copies a file in under its own id, leaving the original; records size and hash', async () => {
    const p = await file('Contract.pdf', 'hello contract');
    const a = await store.attach(p, 'with Acme');
    expect(a).toMatchObject({ name: 'Contract.pdf', size: 14, mime: 'application/pdf', note: 'with Acme' });
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(p, 'utf8')).toBe('hello contract');
    const stored = await store.pathOf(a.id);
    expect(stored && (await readFile(stored, 'utf8'))).toBe('hello contract');
    expect(path.basename(stored!)).toBe(a.id);
    expect((await store.read()).attachments).toHaveLength(1);
  });

  it('two files with the same name do not collide', async () => {
    const p1 = await file('same.txt', 'one');
    const a = await store.attach(p1);
    await writeFile(p1, 'two');
    const b = await store.attach(p1);
    expect(a.id).not.toBe(b.id);
    expect(await readFile((await store.pathOf(a.id))!, 'utf8')).toBe('one');
    expect(await readFile((await store.pathOf(b.id))!, 'utf8')).toBe('two');
  });

  it('refuses a folder or a missing file, and leaves nothing behind', async () => {
    await expect(store.attach(src)).rejects.toThrow(/not a file/);
    await expect(store.attach(path.join(src, 'nope.txt'))).rejects.toThrow(/not a file/);
    expect((await store.read()).attachments).toEqual([]);
    const left = await readdir(path.join(dir, 'attachments')).catch(() => []);
    expect(left.filter((n) => n.startsWith('.incoming'))).toEqual([]);
  });

  it('removing deletes the copy; the photo is cleared with it; an unknown id has no path', async () => {
    const a = await store.attach(await file('me.png', Buffer.from([1, 2, 3])));
    await store.setAvatar(a.id);
    expect((await store.read()).avatarId).toBe(a.id);
    const stored = (await store.pathOf(a.id))!;
    await store.removeAttachment(a.id);
    await expect(stat(stored)).rejects.toThrow();
    expect((await store.read()).avatarId).toBeNull();
    expect(await store.pathOf(a.id)).toBeNull();
    await expect(store.removeAttachment('nope')).rejects.toThrow(/no such/);
  });

  it('a photo must be a picture', async () => {
    const a = await store.attach(await file('doc.pdf', 'x'));
    await expect(store.setAvatar(a.id)).rejects.toThrow(/picture/);
  });

  it('verify finds a missing or altered copy', async () => {
    const a = await store.attach(await file('a.txt', 'aaa'));
    const b = await store.attach(await file('b.txt', 'bbb'));
    const c = await store.attach(await file('c.txt', 'ccc'));
    expect(await store.verify()).toEqual([]);
    await rm((await store.pathOf(a.id))!);
    await writeFile((await store.pathOf(b.id))!, 'tampered');
    const bad = await store.verify();
    expect(bad.map((x) => [x.name, x.problem]).sort()).toEqual([['a.txt', 'missing'], ['b.txt', 'changed']]);
    expect(bad.some((x) => x.id === c.id)).toBe(false);
  });

  it('simultaneous attachments all land', async () => {
    const paths = await Promise.all(Array.from({ length: 8 }, (_, i) => file(`f${i}.txt`, `content ${i}`)));
    await Promise.all(paths.map((p) => store.attach(p)));
    expect((await store.read()).attachments).toHaveLength(8);
    expect((await readdir(path.join(dir, 'attachments'))).filter((n) => !n.startsWith('.'))).toHaveLength(8);
  });
});
