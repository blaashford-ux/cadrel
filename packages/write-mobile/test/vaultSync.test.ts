// Not type-checked with the app (see harness.ts). The phone's sync is run against the real Studio server code, as a member would.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { studio } from './harness';

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

describe('writing on the phone', () => {
  it('sends an edit as the next version and gives the lock back at once', async () => {
    const s = await studio();
    await s.desk.add('Book 1/Draft.md', 'v1', 'pB1');
    const p = await s.phone('author', { device: 'Pixel 8' });
    await p.sync.syncNow();
    await p.fs.writeText(`${ROOT}/Book 1/Draft.md`, 'v1 and more, written on the train');
    expect(await p.sync.unsentCount()).toBe(1);
    const st = await p.sync.syncNow();
    expect(st.summary).toMatchObject({ uploaded: 1, conflicts: [], errors: [] });
    expect(await s.desk.text('Book 1/Draft.md')).toBe('v1 and more, written on the train');
    const [f] = await s.desk.list();
    expect(f).toMatchObject({ currentVersion: 2, lock: null });
    expect(await p.sync.unsentCount()).toBe(0);
    // and nothing more happens on the next pass
    expect((await p.sync.syncNow()).summary).toMatchObject({ uploaded: 0, downloaded: 0 });
  });

  it('keeps edits made with no connection, and sends them when the connection is back', async () => {
    const s = await studio();
    await s.desk.add('Book 1/Draft.md', 'v1', 'pB1');
    const p = await s.phone();
    await p.sync.syncNow();
    s.setOffline(true);
    await p.fs.writeText(`${ROOT}/Book 1/Draft.md`, 'written offline');
    const off = await p.sync.syncNow();
    expect(off.state).toBe('error');
    expect(off.message).toMatch(/No connection/);
    expect(await p.fs.readText(`${ROOT}/Book 1/Draft.md`)).toBe('written offline');
    s.setOffline(false);
    const on = await p.sync.syncNow();
    expect(on.state).toBe('idle');
    expect(on.summary).toMatchObject({ uploaded: 1 });
    expect(await s.desk.text('Book 1/Draft.md')).toBe('written offline');
  });

  it('adds a new file the person made to the Studio, under the project', async () => {
    const s = await studio();
    await s.desk.add('Book 1/Draft.md', 'v1', 'pB1');
    const p = await s.phone();
    await p.sync.syncNow();
    await p.fs.mkdir(`${ROOT}/Book 1/Notes`, { recursive: true });
    await p.fs.writeText(`${ROOT}/Book 1/Notes/Ideas.md`, '# Ideas\n');
    const st = await p.sync.syncNow();
    expect(st.summary).toMatchObject({ uploaded: 1, errors: [] });
    expect(await s.desk.text('Book 1/Notes/Ideas.md')).toBe('# Ideas\n');
    const listed = (await s.owner.vault<{ path: string; projectId: string | null }[]>('list')).find((f) => f.path === 'Book 1/Notes/Ideas.md');
    expect(listed?.projectId).toBe('pB1');
    // and it is tracked now: editing it sends a new version instead of adding it again
    await p.fs.writeText(`${ROOT}/Book 1/Notes/Ideas.md`, '# Ideas\n\nmore');
    expect((await p.sync.syncNow()).summary).toMatchObject({ uploaded: 1 });
    expect((await s.desk.list()).filter((f) => f.path.endsWith('Ideas.md'))).toHaveLength(1);
  });
});

describe('when the same file changed in two places', () => {
  it('keeps both: the phone’s text as a conflict file (also sent to the Studio), and the Studio’s version in the original', async () => {
    const s = await studio();
    await s.desk.add('Book 1/Draft.md', 'v1', 'pB1');
    const p = await s.phone('author', { device: 'Pixel 8' });
    await p.sync.syncNow();
    s.setOffline(true);
    await p.fs.writeText(`${ROOT}/Book 1/Draft.md`, 'the phone’s version');
    await p.sync.syncNow(); // offline: nothing sent
    s.setOffline(false);
    await s.desk.save('Book 1/Draft.md', 'the desk’s version'); // meanwhile, a newer version
    const st = await p.sync.syncNow();
    expect(st.summary!.conflicts).toHaveLength(1);
    expect(st.summary!.errors).toEqual([]);
    expect(await p.fs.readText(`${ROOT}/Book 1/Draft.md`)).toBe('the desk’s version');
    const copy = st.summary!.conflicts[0]!;
    expect(copy).toContain('Draft (conflict Pixel 8 2026-11-06).md');
    expect(await p.fs.readText(copy)).toBe('the phone’s version');
    // the phone's text reached the Studio as its own file, so nothing depends on the phone alone
    expect(await s.desk.text('Book 1/Draft (conflict Pixel 8 2026-11-06).md')).toBe('the phone’s version');
    expect(await s.desk.text('Book 1/Draft.md')).toBe('the desk’s version');
    expect(st.message).toMatch(/Both versions were kept/);
  });

  it('does the same when someone has the file checked out, and says who when the person tries to write in it', async () => {
    const s = await studio();
    await s.desk.add('Book 1/Draft.md', 'v1', 'pB1');
    const p = await s.phone();
    await p.sync.syncNow();
    await p.fs.writeText(`${ROOT}/Book 1/Draft.md`, 'phone edit');
    await s.desk.hold('Book 1/Draft.md');
    const st = await p.sync.syncNow();
    expect(st.summary!.conflicts).toHaveLength(1);
    expect(await p.fs.readText(`${ROOT}/Book 1/Draft.md`)).toBe('v1');
    expect(await s.desk.text('Book 1/Draft (conflict Pixel 8 2026-11-06).md')).toBe('phone edit');
    // while it is held, the editor is told before anything is typed into it
    expect(() => p.sync.assertWritable(`${ROOT}/Book 1/Draft.md`)).toThrow(/has this file checked out/);
    expect(() => p.sync.assertWritable(`${ROOT}/Book 1/Other.md`)).not.toThrow();
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
