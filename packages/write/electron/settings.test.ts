import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existingFolder, sanitizeSettings, SettingsStore } from './settings';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mdedit-'));
  file = path.join(dir, 'settings.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('sanitizeSettings', () => {
  it('drops anything malformed but keeps what is valid', () => {
    expect(sanitizeSettings(null)).toEqual({});
    expect(sanitizeSettings({ lastFolder: 3, theme: 'purple', window: { width: 'x' }, prefs: { sidebarWidth: 'wide' } })).toEqual({});
    expect(
      sanitizeSettings({
        lastFolder: '/a',
        theme: 'dark',
        window: { x: 1, y: 2, width: 800, height: 600, maximized: true },
        prefs: { sidebarWidth: 321 },
        sessions: {
          '/a': { tabs: [{ file: '/a/x.md', chapter: 2.9, mode: 'source' }, { file: 5 }], active: '/a/x.md', expanded: ['/a/d', 7] },
          '/b': 'junk'
        }
      })
    ).toEqual({
      lastFolder: '/a',
      theme: 'dark',
      window: { x: 1, y: 2, width: 800, height: 600, maximized: true },
      prefs: { sidebarWidth: 321 },
      sessions: { '/a': { tabs: [{ file: '/a/x.md', chapter: 2, mode: 'source' }], active: '/a/x.md', expanded: ['/a/d'] } }
    });
  });
});

describe('SettingsStore', () => {
  it('starts empty when the file is missing or corrupt', async () => {
    const s = new SettingsStore(file);
    await s.load();
    expect(s.get()).toEqual({});
    await writeFile(file, '{oops');
    await s.load();
    expect(s.get()).toEqual({});
  });

  it('persists many rapid updates without losing any', async () => {
    const s = new SettingsStore(file);
    await s.load();
    s.update((d) => (d.lastFolder = '/x'));
    s.update((d) => (d.theme = 'light'));
    s.update((d) => (d.prefs = { sidebarWidth: 250 }));
    await s.flush();
    const reread = new SettingsStore(file);
    await reread.load();
    expect(reread.get()).toEqual({ lastFolder: '/x', theme: 'light', prefs: { sidebarWidth: 250 } });
    expect(JSON.parse(await readFile(file, 'utf8')).lastFolder).toBe('/x');
  });

  it('keeps sessions per folder and caps how many are remembered', async () => {
    const s = new SettingsStore(file);
    await s.load();
    for (let i = 0; i < 25; i++) s.setSession(`/f${i}`, { tabs: [], active: null, expanded: [] });
    s.setSession('/f24', { tabs: [], active: null, expanded: ['/f24/a'] });
    await s.flush();
    const keys = Object.keys(s.get().sessions!);
    expect(keys).toHaveLength(20);
    expect(keys).not.toContain('/f0');
    expect(s.get().sessions!['/f24'].expanded).toEqual(['/f24/a']);
  });
});

describe('existingFolder', () => {
  it('accepts a real directory only', async () => {
    expect(await existingFolder(dir)).toBe(dir);
    expect(await existingFolder(path.join(dir, 'gone'))).toBeNull();
    await writeFile(file, '{}');
    expect(await existingFolder(file)).toBeNull();
    expect(await existingFolder(undefined)).toBeNull();
  });
});

describe('appDefaults in settings', () => {
  it('are sanitised on load and survive a save/load round trip', async () => {
    const s = new SettingsStore(file);
    expect(s.appDefaults().chapterLevel).toBe(1);
    s.update((x) => {
      x.appDefaults = sanitizeSettings({ appDefaults: { chapterLevel: 3, book: { author: 'A' } } }).appDefaults;
    });
    await s.flush();
    const again = new SettingsStore(file);
    await again.load();
    expect(again.appDefaults()).toMatchObject({ chapterLevel: 3, book: { author: 'A' } });
  });

  it('garbage falls back to defaults', () => {
    expect(sanitizeSettings({ appDefaults: 'nope' }).appDefaults).toBeUndefined();
    expect(sanitizeSettings({ appDefaults: { chapterLevel: -4 } }).appDefaults!.chapterLevel).toBe(1);
  });
});

describe('old key names in saved defaults', () => {
  it('are renamed on disk after the first load', async () => {
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(file, JSON.stringify({ appDefaults: { chapterLevel: 2, book: { copyright: { aiDisclosure: true, aiText: 'Peril.' } } } }));
    const s = new SettingsStore(file);
    await s.load();
    await s.flush();
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    expect(onDisk.appDefaults.book.copyright).toMatchObject({ contentWarning: true, contentWarningText: 'Peril.' });
    expect(JSON.stringify(onDisk)).not.toMatch(/aiDisclosure|aiText/);
  });
});
