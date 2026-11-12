// Not type-checked with the app (see harness.ts). The phone's sync is run against the real Studio server code, as a member would.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enc, hashOf, studio } from './harness';

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

const ROOT = '/Studios/st1/Projects';

describe('bringing a Studio’s project files to the phone', () => {
  it('makes a folder Write opens as a project for each project with text files, and leaves images on the Studio', async () => {
    const s = await studio();
    await s.desk.add('Book 1/Manuscript/Draft.md', '# Chapter 1\n\nIt began.\n', 'pB1');
    await s.desk.add('Book 1/Characters/Mara.md', '# Mara\n', 'pB1');
    await s.desk.add('Book 1/cover.png', 'not really a png', 'pB1');
    await s.desk.add('Book 2/Draft.md', '# Two\n', 'pB2');
    const p = await s.phone('author');
    const status = await p.sync.syncNow();
    expect(status.state).toBe('idle');
    expect(status.summary).toMatchObject({ downloaded: 3, uploaded: 0, errors: [] });
    expect(status.summary!.skipped[0]!.reason).toMatch(/not text/);
    expect(await p.fs.readText(`${ROOT}/Book 1/Manuscript/Draft.md`)).toBe('# Chapter 1\n\nIt began.\n');
    expect(await p.fs.readText(`${ROOT}/Book 1/Characters/Mara.md`)).toBe('# Mara\n');
    expect(await p.fs.stat(`${ROOT}/Book 1/cover.png`)).toBeNull();
    const meta = JSON.parse(await p.fs.readText(`${ROOT}/Book 1/.cadrel/project.json`));
    expect(meta).toMatchObject({ version: 1, name: 'Book 1' });
    expect((await p.fs.readdir(ROOT)).map((e) => e.name).sort()).toEqual(['Book 1', 'Book 2']);
  });

  it('shows only the projects the person may see, and a second pass with nothing new changes nothing', async () => {
    const s = await studio();
    await s.desk.add('Book 1/A.md', 'a', 'pB1');
    await s.desk.add('Book 2/B.md', 'b', 'pB2');
    const guest = await s.phone('guest', { name: 'Gus', extra: { projectId: 'pB1' } });
    const first = await guest.sync.syncNow();
    expect(first.summary).toMatchObject({ downloaded: 1 });
    expect((await guest.fs.readdir(ROOT)).map((e) => e.name)).toEqual(['Book 1']);
    const second = await guest.sync.syncNow();
    expect(second.summary).toMatchObject({ downloaded: 0, uploaded: 0, conflicts: [], errors: [] });
  });

  it('brings a newer version the desktop saved', async () => {
    const s = await studio();
    await s.desk.add('Book 1/Draft.md', 'v1', 'pB1');
    const p = await s.phone();
    await p.sync.syncNow();
    await s.desk.save('Book 1/Draft.md', 'v2 from the desk');
    const st = await p.sync.syncNow();
    expect(st.summary).toMatchObject({ downloaded: 1 });
    expect(await p.fs.readText(`${ROOT}/Book 1/Draft.md`)).toBe('v2 from the desk');
  });
});

const FILE = `${ROOT}/Book 1/Draft.md`;
const item = (id: string, body: string, updatedAt: string) => ({ id, kind: 'comment', file: 'Draft.md', anchor: { quote: 'q', prefix: '', suffix: '', start: 0 }, body, status: 'open', author: 'Me', createdAt: updatedAt, updatedAt, replies: [] });
const notesText = (...items: ReturnType<typeof item>[]) => JSON.stringify({ version: 1, reviewer: { id: 'owner', name: 'Me' }, project: 'Book 1', items }, null, 2) + '\n';
const NOTES = 'Book 1/.cadrel/review/owner.json';

describe('writing on the phone: check a file out, edit it, check it in', () => {
  it('is read-only until checked out; a check-in makes exactly one version and gives the lock back', async () => {
    const s = await studio();
    await s.desk.add('Book 1/Draft.md', 'v1', 'pB1');
    const p = await s.phone('author', { device: 'Pixel 8' });
    await p.sync.syncNow();
    expect(() => p.sync.assertWritable(FILE)).toThrow(/checked in/);
    expect(await p.sync.fileLock.state(FILE)).toMatchObject({ kind: 'free', version: 1 });
    expect(await p.sync.fileLock.checkOut(FILE)).toMatchObject({ kind: 'mine', version: 1, changed: false });
    expect(() => p.sync.assertWritable(FILE)).not.toThrow();
    expect((await s.desk.list())[0]!.lock).not.toBeNull(); // the Studio's lock is this phone's
    for (const text of ['written on the train', 'and a little more']) {
      await p.fs.writeText(FILE, text);
      const st = await p.sync.syncNow();
      expect(st.summary).toMatchObject({ uploaded: 0, conflicts: [], errors: [], unprotected: [], checkedOut: [{ name: 'Book 1/Draft.md', changed: true }] });
    }
    // nothing local was versioned: the Studio still has version 1, and the file is still held
    expect(await s.desk.text('Book 1/Draft.md')).toBe('v1');
    expect((await s.desk.list())[0]).toMatchObject({ currentVersion: 1 });
    // checking it in is the version
    expect(await p.sync.fileLock.checkIn(FILE, 'On the train')).toMatchObject({ kind: 'free', version: 2 });
    expect(await s.desk.text('Book 1/Draft.md')).toBe('and a little more');
    expect((await s.desk.list())[0]).toMatchObject({ currentVersion: 2, lock: null });
    expect(() => p.sync.assertWritable(FILE)).toThrow(/checked in/);
    expect((await p.sync.syncNow()).summary).toMatchObject({ uploaded: 0, downloaded: 0, checkedOut: [], unprotected: [] });
  });

  it('checking in a file nobody changed gives the lock back and makes no version; undoing a check-out puts the Studio’s version back', async () => {
    const s = await studio();
    await s.desk.add('Book 1/Draft.md', 'v1', 'pB1');
    const p = await s.phone();
    await p.sync.syncNow();
    await p.sync.fileLock.checkOut(FILE);
    expect(await p.sync.fileLock.checkIn(FILE)).toMatchObject({ kind: 'free', version: 1 });
    expect((await s.desk.list())[0]).toMatchObject({ currentVersion: 1, lock: null });
    await p.sync.fileLock.checkOut(FILE);
    await p.fs.writeText(FILE, 'a change I do not want');
    expect(await p.sync.fileLock.undoCheckOut(FILE)).toMatchObject({ kind: 'free', version: 1 });
    expect(await p.fs.readText(FILE)).toBe('v1');
    expect((await s.desk.list())[0]!.lock).toBeNull();
  });

  it('keeps a checked-out file editable with no connection, and checks it in when the connection is back', async () => {
    const s = await studio();
    await s.desk.add('Book 1/Draft.md', 'v1', 'pB1');
    const p = await s.phone();
    await p.sync.syncNow();
    await p.sync.fileLock.checkOut(FILE);
    s.setOffline(true);
    await p.fs.writeText(FILE, 'written offline');
    expect(() => p.sync.assertWritable(FILE)).not.toThrow(); // still checked out: writing needs no connection
    const off = await p.sync.syncNow();
    expect(off.state).toBe('error');
    expect(off.message).toMatch(/No connection/);
    expect(await p.fs.readText(FILE)).toBe('written offline');
    await expect(p.sync.fileLock.checkIn(FILE)).rejects.toThrow(/No connection/); // check-in needs one; nothing is lost
    expect(await p.sync.fileLock.state(FILE)).toMatchObject({ kind: 'mine', changed: true });
    s.setOffline(false);
    expect(await p.sync.fileLock.checkIn(FILE, 'Offline work')).toMatchObject({ kind: 'free', version: 2 });
    expect(await s.desk.text('Book 1/Draft.md')).toBe('written offline');
  });

  it('can read a file the desktop has checked out, cannot change it, and gets the new version when it is checked in', async () => {
    const s = await studio();
    await s.desk.add('Book 1/Draft.md', 'v1', 'pB1');
    const p = await s.phone();
    await p.sync.syncNow();
    await s.desk.hold('Book 1/Draft.md');
    await p.sync.syncNow();
    expect(await p.sync.fileLock.state(FILE)).toMatchObject({ kind: 'other' });
    expect(() => p.sync.assertWritable(FILE)).toThrow(/has this file checked out/);
    await expect(p.sync.fileLock.checkOut(FILE)).rejects.toThrow(/checked out/);
    expect(await p.fs.readText(FILE)).toBe('v1');
    // the desktop finishes: a new version, which comes in
    const f = (await s.desk.list())[0]!;
    const text = 'v2 from the desk';
    await s.owner.putBlob(await hashOf(text), enc.encode(text));
    await s.owner.vault('checkIn', { fileId: f.id, machine: 'desk', hash: await hashOf(text), size: text.length, comment: 'Desk edit' });
    await p.sync.syncNow();
    expect(await p.fs.readText(FILE)).toBe('v2 from the desk');
    expect(await p.sync.fileLock.state(FILE)).toMatchObject({ kind: 'free', version: 2 });
  });

  it('adds a new file the person made, under the project, and it stays checked out to them', async () => {
    const s = await studio();
    await s.desk.add('Book 1/Draft.md', 'v1', 'pB1');
    const p = await s.phone();
    await p.sync.syncNow();
    await p.fs.mkdir(`${ROOT}/Book 1/Notes`, { recursive: true });
    await p.fs.writeText(`${ROOT}/Book 1/Notes/Ideas.md`, '# Ideas\n');
    const st = await p.sync.syncNow();
    expect(st.summary).toMatchObject({ uploaded: 1, errors: [] });
    expect(await s.desk.text('Book 1/Notes/Ideas.md')).toBe('# Ideas\n');
    const listed = (await s.owner.vault<{ path: string; projectId: string | null; lock: unknown }[]>('list')).find((f) => f.path === 'Book 1/Notes/Ideas.md');
    expect(listed?.projectId).toBe('pB1');
    expect(listed?.lock).not.toBeNull(); // held by the phone that made it
    const ideas = `${ROOT}/Book 1/Notes/Ideas.md`;
    expect(() => p.sync.assertWritable(ideas)).not.toThrow();
    await p.fs.writeText(ideas, '# Ideas\n\nmore');
    expect(await p.sync.fileLock.checkIn(ideas, 'Ideas')).toMatchObject({ kind: 'free', version: 2 });
    expect((await s.desk.list()).filter((f) => f.path.endsWith('Ideas.md'))).toHaveLength(1);
  });

  it('leaves a file changed without a check-out as it is, and lets the person check it out keeping the changes', async () => {
    const s = await studio();
    await s.desk.add('Book 1/Draft.md', 'v1', 'pB1');
    const p = await s.phone();
    await p.sync.syncNow();
    await p.fs.writeText(FILE, 'changed around the read-only'); // something that is not the editor
    const st = await p.sync.syncNow();
    expect(st.summary).toMatchObject({ unprotected: [{ name: 'Book 1/Draft.md' }], uploaded: 0 });
    expect(await p.fs.readText(FILE)).toBe('changed around the read-only');
    await s.desk.save('Book 1/Draft.md', 'v2 from the desk'); // a newer version meanwhile
    expect((await p.sync.syncNow()).summary).toMatchObject({ unprotected: [{ name: 'Book 1/Draft.md' }], downloaded: 0 });
    expect(await p.fs.readText(FILE)).toBe('changed around the read-only');
    await expect(p.sync.fileLock.checkOut(FILE, { keepChanges: true })).rejects.toThrow(/newer version/);
    expect((await s.desk.list())[0]!.lock).toBeNull(); // the lock was not kept
  });
});

describe('a project’s notes travel with it', () => {
  it('come to the phone, and merge with notes made here and on the computer, so every note ends up on both', async () => {
    const s = await studio();
    await s.desk.add('Book 1/Draft.md', 'v1', 'pB1');
    await s.desk.add(NOTES, notesText(item('n1', 'from the desk', '2026-01-01T00:00:00Z')), 'pB1');
    const p = await s.phone();
    await p.sync.syncNow();
    const local = `${ROOT}/${NOTES}`;
    expect(JSON.parse(await p.fs.readText(local)).items.map((i: { id: string }) => i.id)).toEqual(['n1']);
    expect(() => p.sync.assertWritable(local)).not.toThrow(); // notes are never checked out
    // a note made on the phone, while the desktop saves another
    await p.fs.writeText(local, notesText(item('n1', 'from the desk', '2026-01-01T00:00:00Z'), item('n2', 'from the phone', '2026-01-02T00:00:00Z')));
    await s.desk.save(NOTES, notesText(item('n1', 'from the desk', '2026-01-01T00:00:00Z'), item('n3', 'added at the desk', '2026-01-03T00:00:00Z')));
    const st = await p.sync.syncNow();
    expect(st.summary).toMatchObject({ conflicts: [], errors: [] });
    const ids = (t: string) => JSON.parse(t).items.map((i: { id: string }) => i.id);
    expect(ids(await p.fs.readText(local))).toEqual(['n1', 'n2', 'n3']);
    expect(ids(await s.desk.text(NOTES))).toEqual(['n1', 'n2', 'n3']);
  });

  it('a notes file made on the phone is added to the Studio, with no check-out', async () => {
    const s = await studio();
    await s.desk.add('Book 1/Draft.md', 'v1', 'pB1');
    const p = await s.phone();
    await p.sync.syncNow();
    await p.fs.mkdir(`${ROOT}/Book 1/.cadrel/review`, { recursive: true });
    await p.fs.writeText(`${ROOT}/${NOTES}`, notesText(item('n1', 'first note', '2026-01-01T00:00:00Z')));
    const st = await p.sync.syncNow();
    expect(st.summary).toMatchObject({ uploaded: 1, errors: [] });
    const listed = (await s.owner.vault<{ path: string; lock: unknown }[]>('list')).find((f) => f.path === NOTES);
    expect(listed).toBeDefined();
    expect(listed?.lock).toBeNull();
    expect(JSON.parse(await s.desk.text(NOTES)).items).toHaveLength(1);
  });
});

describe('what the person’s role allows', () => {
  it('lets a role that cannot write read the project, refuses a change before it is made, and puts an edit that got through aside', async () => {
    const s = await studio();
    await s.desk.add('Book 1/Draft.md', 'original', 'pB1');
    const g = await s.phone('guest', { name: 'Gus', extra: { projectId: 'pB1' } });
    await g.sync.syncNow();
    expect(await g.fs.readText(`${ROOT}/Book 1/Draft.md`)).toBe('original');
    expect(() => g.sync.assertWritable(`${ROOT}/Book 1/Draft.md`)).toThrow(/can read this project/);
    await g.fs.writeText(`${ROOT}/Book 1/Draft.md`, 'sneaky');
    const st = await g.sync.syncNow();
    expect(st.summary!.errors[0]!.message).toMatch(/kept aside/);
    expect(await g.fs.readText(`${ROOT}/Book 1/Draft.md`)).toBe('original');
    const kept = await g.fs.readdir(`${ROOT}/Book 1/.cadrel/unsent`);
    expect(kept).toHaveLength(1);
    expect(await s.desk.text('Book 1/Draft.md')).toBe('original');
  });
});

describe('when the Studio stops accepting the phone', () => {
  it('says so in words, once, and stops trying', async () => {
    const s = await studio();
    await s.desk.add('Book 1/Draft.md', 'v1', 'pB1');
    const p = await s.phone();
    await p.sync.syncNow();
    const members = await s.owner.request<{ members: { id: string; name: string }[] }>('GET', '/v1/members');
    await s.owner.request('DELETE', `/v1/members/${members.members.find((m) => m.name === 'Ann Author')!.id}`);
    const st = await p.sync.syncNow();
    expect(st.state).toBe('error');
    expect(st.message).toMatch(/no longer accepts this phone/);
    expect(p.revoked()).toMatch(/no longer accepts/);
    const calls = vi.fn();
    p.sync.onSyncStatus(calls);
    await p.sync.syncNow();
    expect(calls).not.toHaveBeenCalled();
  });
});

describe('keeping up while the app is open', () => {
  it('asks the Studio only whether anything changed, and makes a full pass only when something has', async () => {
    const s = await studio();
    await s.desk.add('Book 1/Draft.md', 'v1', 'pB1');
    const p = await s.phone();
    await p.sync.syncNow();
    let lists = 0;
    const vault = p.client.vault.bind(p.client);
    (p.client as { vault: unknown }).vault = (m: string, a?: unknown) => (m === 'list' && lists++, vault(m, a));
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    p.sync.startPolling(20);
    await wait(150);
    expect(lists).toBe(0); // nothing changed on the Studio: no pass, however many looks
    await s.desk.save('Book 1/Draft.md', 'v2 from the desk');
    await wait(250);
    p.sync.stopPolling();
    expect(await p.fs.readText(`${ROOT}/Book 1/Draft.md`)).toBe('v2 from the desk');
    expect(lists).toBeGreaterThanOrEqual(1);
    expect(lists).toBeLessThanOrEqual(3);
  });
});
