import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryFs } from '../memoryFs';
import { md5Hex } from '../md5';
import { FakeDrive } from './fakeDrive';
import { emptySyncState, sanitizeSyncState, syncOnce, type SyncReport, type SyncState } from './engine';

const ROOT = '/MDEdit';

/** One phone or PC: its own file system and its own memory of the last sync, sharing one Drive. */
class Device {
  fs = new MemoryFs();
  state: SyncState = emptySyncState();
  trashed: string[] = [];
  constructor(readonly name: string, readonly drive: FakeDrive) {}

  async init() {
    await this.fs.mkdir(ROOT, { recursive: true });
    return this;
  }
  put(path: string, text: string) {
    this.fs.seed(`${ROOT}/${path}`, text);
  }
  async mkdir(path: string) {
    await this.fs.mkdir(`${ROOT}/${path}`, { recursive: true });
  }
  async read(path: string): Promise<string | null> {
    return this.fs.readText(`${ROOT}/${path}`).catch(() => null);
  }
  async has(path: string) {
    return (await this.fs.stat(`${ROOT}/${path}`)) !== null;
  }
  async rm(path: string) {
    await this.fs.rm(`${ROOT}/${path}`, { recursive: true });
  }
  async rename(from: string, to: string) {
    await this.fs.rename(`${ROOT}/${from}`, `${ROOT}/${to}`);
  }
  async files(dir = ''): Promise<string[]> {
    const out: string[] = [];
    const walk = async (d: string, rel: string) => {
      for (const e of await this.fs.readdir(d)) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory) await walk(`${d}/${e.name}`, r);
        else out.push(r);
      }
    };
    await walk(dir ? `${ROOT}/${dir}` : ROOT, dir);
    return out.sort();
  }
  sync(opts: { allowDeletes?: boolean; now?: Date } = {}): Promise<SyncReport> {
    return syncOnce({
      fs: this.fs, root: ROOT, drive: this.drive, device: this.name, now: () => opts.now ?? new Date('2026-10-05T12:00:00'),
      allowDeletes: opts.allowDeletes,
      store: { load: async () => sanitizeSyncState(JSON.parse(JSON.stringify(this.state))), save: async (s) => void (this.state = JSON.parse(JSON.stringify(s))) },
      trashLocal: async (p) => {
        this.trashed.push(p);
        await this.fs.rm(p);
      },
    });
  }
}

let drive: FakeDrive;
let a: Device;
let b: Device;
beforeEach(async () => {
  drive = new FakeDrive();
  a = await new Device('Laptop', drive).init();
  b = await new Device('Pixel', drive).init();
});

const CH = 'Novel/Manuscript/Ch 1.md';

describe('first syncs', () => {
  it('uploads a new project and a second device downloads it', async () => {
    a.put(CH, '# One\nhello');
    a.put('Novel/.mdedit/project.json', '{"name":"Novel"}');
    const r1 = await a.sync();
    expect(r1.uploaded.sort()).toEqual([CH, 'Novel/.mdedit/project.json'].sort());
    expect(drive.read(CH)).toBe('# One\nhello');

    const r2 = await b.sync();
    expect(r2.downloaded).toContain(CH);
    expect(await b.read(CH)).toBe('# One\nhello');
    expect(await b.read('Novel/.mdedit/project.json')).toBe('{"name":"Novel"}');
  });

  it('is quiet when nothing changed', async () => {
    a.put(CH, 'x');
    await a.sync();
    const again = await a.sync();
    expect(again).toMatchObject({ uploaded: [], downloaded: [], deletedLocal: [], deletedRemote: [], conflicts: [], errors: [] });
    const callsBefore = drive.calls.length;
    await a.sync();
    expect(drive.calls.slice(callsBefore).every((c) => c === 'list')).toBe(true); // only the listing, no transfers
  });

  it('treats identical files on both devices as already in sync', async () => {
    a.put(CH, 'same');
    b.put(CH, 'same');
    await a.sync();
    const r = await b.sync();
    expect(r.conflicts).toEqual([]);
    expect(r.downloaded).toEqual([]);
    expect(await b.read(CH)).toBe('same');
  });

  it('mirrors empty folders both ways', async () => {
    await a.mkdir('Novel/Characters');
    await a.mkdir('Novel/Research');
    await a.sync();
    await b.sync();
    expect(await b.has('Novel/Characters')).toBe(true);
    expect(await b.has('Novel/Research')).toBe(true);
  });
});

describe('edits travel', () => {
  beforeEach(async () => {
    a.put(CH, 'v1');
    await a.sync();
    await b.sync();
  });

  it('an edit on one device reaches the other', async () => {
    a.put(CH, 'v2 from laptop');
    await a.sync();
    const r = await b.sync();
    expect(r.downloaded).toEqual([CH]);
    expect(await b.read(CH)).toBe('v2 from laptop');
  });

  it('keeps both versions when both devices edit the same chapter, and both converge', async () => {
    a.put(CH, 'laptop edit');
    b.put(CH, 'phone edit');
    await a.sync(); // laptop gets there first
    const r = await b.sync();
    expect(r.conflicts).toHaveLength(1);
    const copy = r.conflicts[0];
    expect(copy).toMatch(/Ch 1 \(conflict - Pixel - 2026-10-05\)\.md$/);
    expect(await b.read(CH)).toBe('laptop edit'); // Drive's version keeps the name
    expect(await b.read(copy)).toBe('phone edit'); // nothing lost
    await a.sync();
    expect(await a.read(copy)).toBe('phone edit');
    expect(await a.read(CH)).toBe('laptop edit');
    expect(drive.read(copy)).toBe('phone edit');
    // and it settles: no further changes
    expect(await a.sync()).toMatchObject({ conflicts: [], uploaded: [], downloaded: [] });
    expect(await b.sync()).toMatchObject({ conflicts: [], uploaded: [], downloaded: [] });
  });

  it('does not overwrite a local file that changed while the sync was running', async () => {
    a.put(CH, 'remote edit');
    await a.sync();
    // The phone edits the file between the scan and the download.
    const realStat = b.fs.stat.bind(b.fs);
    let checks = 0;
    b.fs.stat = async (p: string) => {
      if (p.endsWith('Ch 1.md') && ++checks === 1) b.put(CH, 'typed just now'); // after the scan, before the overwrite
      return realStat(p);
    };
    const r = await b.sync();
    expect(await b.read(CH)).toBe('typed just now');
    expect(r.downloaded).toEqual([]);
    expect(r.skipped.some((s) => s.path === CH)).toBe(true);
  });
});

describe('deletes and renames', () => {
  beforeEach(async () => {
    a.put(CH, 'v1');
    a.put('Novel/Manuscript/Ch 2.md', 'two');
    await a.sync();
    await b.sync();
  });

  it('a delete on one device removes the file on the other (to the app trash)', async () => {
    await a.rm('Novel/Manuscript/Ch 2.md');
    const r = await a.sync();
    expect(r.deletedRemote).toEqual(['Novel/Manuscript/Ch 2.md']);
    const r2 = await b.sync();
    expect(r2.deletedLocal).toEqual(['Novel/Manuscript/Ch 2.md']);
    expect(await b.has('Novel/Manuscript/Ch 2.md')).toBe(false);
    expect(b.trashed).toHaveLength(1);
  });

  it('an edit beats a delete: the deleted file comes back with the edit', async () => {
    await a.rm(CH);
    b.put(CH, 'edited on the phone');
    await a.sync();
    await b.sync();
    expect(await b.read(CH)).toBe('edited on the phone');
    await a.sync();
    expect(await a.read(CH)).toBe('edited on the phone');
  });

  it('a rename keeps the same Drive file', async () => {
    const idBefore = a.state.files[CH].id;
    await a.rename(CH, 'Novel/Manuscript/Opening.md');
    const r = await a.sync();
    expect(r.renamed).toBe(1);
    expect(a.state.files['Novel/Manuscript/Opening.md'].id).toBe(idBefore);
    await b.sync();
    expect(await b.has(CH)).toBe(false);
    expect(await b.read('Novel/Manuscript/Opening.md')).toBe('v1');
  });

  it('refuses to delete a large share of the files without confirmation', async () => {
    for (let i = 0; i < 5; i++) a.put(`Novel/n${i}.md`, `note ${i}`);
    await a.sync();
    await b.sync();
    await a.rm('Novel'); // the whole project, say, an unmounted SD card or a mistake
    const r = await a.sync();
    expect(r.pendingDeletes.length).toBeGreaterThanOrEqual(5);
    expect(r.deletedRemote).toEqual([]);
    expect(drive.read(CH)).toBe('v1'); // Drive untouched
    expect((await b.sync()).downloaded).toEqual([]);
    // once the user confirms
    const ok = await a.sync({ allowDeletes: true });
    expect(ok.deletedRemote.length).toBeGreaterThanOrEqual(5);
    expect(drive.read(CH)).toBeUndefined();
  });
});

describe('folders', () => {
  it('deleting a whole project on one device removes it, folders included, on the other', async () => {
    a.put('Novel/Manuscript/Ch 1.md', 'a');
    a.put('Novel/Manuscript/Ch 2.md', 'b');
    a.put('Novel/Notes/n.md', 'c');
    a.put('Other/x.md', 'x');
    a.put('Other/y.md', 'y');
    await a.sync();
    await b.sync();
    await a.rm('Novel');
    await a.sync({ allowDeletes: true });
    await b.sync({ allowDeletes: true });
    expect(await b.has('Novel')).toBe(false);
    expect(await b.files()).toEqual(['Other/x.md', 'Other/y.md']);
    await a.sync();
    expect(await a.has('Novel')).toBe(false); // no skeleton comes back
  });

  it('never removes a folder that still holds files that do not sync (images)', async () => {
    a.put('Novel/Research/map.png', 'not really a png');
    a.put('Novel/Research/note.md', 'n');
    await a.sync();
    await a.rm('Novel/Research/note.md');
    await a.sync();
    expect(await a.has('Novel/Research/map.png')).toBe(true);
  });
});

describe('file types', () => {
  it('merges progress history from both devices', async () => {
    const prog = 'Novel/.mdedit/progress.json';
    const day = (start: number, end: number) => JSON.stringify({ version: 1, days: { '2026-10-04': { start, end } } });
    a.put(prog, day(0, 100));
    await a.sync();
    await b.sync();
    a.put(prog, JSON.stringify({ version: 1, days: { '2026-10-04': { start: 0, end: 100 }, '2026-10-05': { start: 100, end: 200 } } }));
    b.put(prog, JSON.stringify({ version: 1, days: { '2026-10-04': { start: 0, end: 100 }, '2026-10-06': { start: 100, end: 160 } } }));
    await a.sync();
    const r = await b.sync();
    expect(r.merged).toEqual([prog]);
    await a.sync();
    for (const d of [a, b]) {
      const merged = JSON.parse((await d.read(prog))!);
      expect(Object.keys(merged.days).sort()).toEqual(['2026-10-04', '2026-10-05', '2026-10-06']);
    }
    expect(r.conflicts).toEqual([]); // never a conflict copy of a history file
  });

  it('merges edited-chapter marks from both devices, keeping an unmark', async () => {
    const f = 'Novel/.mdedit/edited.json';
    const marks = (files: Record<string, Record<string, { edited: boolean; at: number }>>) => JSON.stringify({ version: 1, files });
    a.put(f, marks({ 'Book.md': { One: { edited: true, at: 100 } } }));
    await a.sync();
    await b.sync();
    a.put(f, marks({ 'Book.md': { One: { edited: false, at: 300 }, Two: { edited: true, at: 250 } } }));
    b.put(f, marks({ 'Book.md': { One: { edited: true, at: 100 }, Three: { edited: true, at: 200 } } }));
    await a.sync();
    const r = await b.sync();
    expect(r.merged).toEqual([f]);
    await a.sync();
    for (const d of [a, b]) {
      expect(JSON.parse((await d.read(f))!).files['Book.md']).toEqual({ One: { edited: false, at: 300 }, Two: { edited: true, at: 250 }, Three: { edited: true, at: 200 } });
    }
    expect(r.conflicts).toEqual([]);
  });

  describe('review notes', () => {
    const f = 'Novel/.mdedit/review/owner.json';
    const note = (id: string, body: string, at: string) => ({
      id, kind: 'comment', file: 'Book.md', anchor: { quote: 'hello', prefix: '', suffix: '' }, body, author: 'Me', createdAt: at, updatedAt: at, replies: [],
    });
    const file = (...items: unknown[]) => JSON.stringify({ version: 1, reviewer: { id: 'owner', name: 'Me' }, project: 'Novel', items });
    const ids = async (d: Device) => JSON.parse((await d.read(f))!).items.map((i: { id: string }) => i.id).sort();

    it('carries notes made on one device to the other', async () => {
      a.put(f, file(note('n1', 'from the PC', '2026-10-05T10:00:00Z')));
      await a.sync();
      await b.sync();
      expect(await ids(b)).toEqual(['n1']);
    });

    it('keeps the notes made on both devices when each added one', async () => {
      a.put(f, file(note('n1', 'first', '2026-10-05T10:00:00Z')));
      await a.sync();
      await b.sync();
      a.put(f, file(note('n1', 'first', '2026-10-05T10:00:00Z'), note('n2', 'from the PC', '2026-10-05T11:00:00Z')));
      b.put(f, file(note('n1', 'first', '2026-10-05T10:00:00Z'), note('n3', 'from the phone', '2026-10-05T11:30:00Z')));
      await a.sync();
      const r = await b.sync();
      await a.sync();
      expect(r.conflicts).toEqual([]);
      expect(await ids(a)).toEqual(['n1', 'n2', 'n3']);
      expect(await ids(b)).toEqual(['n1', 'n2', 'n3']);
    });
  });

  it('last writer wins for project settings, with no conflict copy', async () => {
    const meta = 'Novel/.mdedit/project.json';
    a.put(meta, '{"status":"planning"}');
    await a.sync();
    await b.sync();
    a.put(meta, '{"status":"drafting"}');
    b.put(meta, '{"status":"revising"}');
    await a.sync();
    const r = await b.sync();
    expect(r.conflicts).toEqual([]);
    const final = [await a.read(meta), await b.read(meta)];
    await a.sync();
    expect(await a.read(meta)).toBe(await b.read(meta));
    expect(final.length).toBe(2);
  });

  it('never syncs temp files, drafts, backups or Exports', async () => {
    a.put('Novel/a.md.mdedit-123.tmp', 'x');
    a.put('Novel/.mdedit/drafts/d.json', 'x');
    a.put('Novel/.mdedit/project.json.bak', 'x');
    a.put('Novel/Exports/book.epub', 'x');
    a.put('Novel/Ch 1.md', 'real');
    const r = await a.sync();
    expect(r.uploaded).toEqual(['Novel/Ch 1.md']);
  });

  it('leaves binary-looking assets alone and says so', async () => {
    a.put('Novel/cover.png', 'bytes');
    const r = await a.sync();
    expect(r.uploaded).toEqual([]);
    expect(r.skipped.some((s) => s.path === 'Novel/cover.png')).toBe(true);
  });
});

describe('names that arrive from Drive', () => {
  it('renames invalid names to Windows-safe ones on Drive and downloads them under the new name', async () => {
    a.put('Novel/Ch 1.md', 'real');
    await a.sync();
    const rootId = a.state.rootId!;
    drive.seed('Novel/Act 1: The Fall?.md', 'from the Drive web UI', rootId);
    drive.seed('Novel/CON.md', 'reserved', rootId);
    const r = await b.sync();
    expect(r.renamed).toBe(2);
    expect(await b.files('Novel')).toEqual(['Novel/Act 1_ The Fall_.md', 'Novel/CON_.md', 'Novel/Ch 1.md'].sort());
    expect(drive.read('Novel/Act 1_ The Fall_.md')).toBe('from the Drive web UI');
    expect(drive.read('Novel/Act 1: The Fall?.md')).toBeUndefined();
  });

  it('numbers files that differ only by case', async () => {
    a.put('Novel/x.md', 'x');
    await a.sync();
    const rootId = a.state.rootId!;
    drive.seed('Novel/X.md', 'capital', rootId);
    const r = await a.sync();
    expect(r.errors).toEqual([]);
    const names = (await a.files('Novel')).map((n) => n.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(2);
  });
});

describe('robustness', () => {
  it('keeps going when one file fails, and reports it', async () => {
    a.put('Novel/good.md', 'g');
    a.put('Novel/bad.md', 'b');
    const real = drive.createFile.bind(drive);
    drive.createFile = async (name, parent, content) => {
      if (name === 'bad.md') throw new Error('Drive said no');
      return real(name, parent, content);
    };
    const r = await a.sync();
    expect(r.uploaded).toEqual(['Novel/good.md']);
    expect(r.errors).toEqual([{ path: 'Novel/bad.md', message: 'Drive said no' }]);
    drive.createFile = real;
    expect((await a.sync()).uploaded).toEqual(['Novel/bad.md']); // retried next pass
  });

  it('remembers what it learned even when the pass dies half way', async () => {
    a.put('Novel/one.md', '1');
    const real = drive.listAll.bind(drive);
    await a.sync();
    drive.listAll = async () => {
      throw new Error('offline');
    };
    await expect(a.sync()).rejects.toThrow('offline');
    drive.listAll = real;
    expect(a.state.files['Novel/one.md']).toBeDefined();
  });

  it('reuses the cached hash of unchanged files instead of re-reading them', async () => {
    a.put('Novel/big.md', 'x'.repeat(1000));
    await a.sync();
    let reads = 0;
    const real = a.fs.readText.bind(a.fs);
    a.fs.readText = async (p: string) => (reads++, real(p));
    await a.sync();
    expect(reads).toBe(0);
  });

  it('finds its Drive folder again if the remembered id is lost', async () => {
    a.put(CH, 'x');
    await a.sync();
    a.state.rootId = null;
    a.state.files = {};
    const r = await a.sync();
    expect(r.errors).toEqual([]);
    expect(drive.calls.filter((c) => c === 'createFolder:MDEdit')).toHaveLength(1); // no second MDEdit folder
    expect(md5Hex(drive.read(CH)!)).toBe(md5Hex('x'));
  });
});
