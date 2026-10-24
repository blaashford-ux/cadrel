import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsStore, sanitizeSettings } from '../src/main/settings';

describe('sanitizeSettings', () => {
  it('defaults to Home', () => {
    expect(sanitizeSettings(undefined)).toEqual({ page: 'home' });
    expect(sanitizeSettings('nonsense')).toEqual({ page: 'home' });
    expect(sanitizeSettings({ page: 'elsewhere' })).toEqual({ page: 'home' });
  });
  it('keeps a valid page and window', () => {
    expect(sanitizeSettings({ page: 'write', window: { x: 10.4, y: 20, width: 1000.2, height: 700, maximized: true } })).toEqual({
      page: 'write',
      window: { x: 10, y: 20, width: 1000, height: 700, maximized: true }
    });
  });
  it('drops an absurd window instead of using it', () => {
    expect(sanitizeSettings({ window: { width: 5, height: 5 } }).window).toBeUndefined();
    expect(sanitizeSettings({ window: { width: 'big', height: 700 } }).window).toBeUndefined();
    expect(sanitizeSettings({ window: { width: Infinity, height: 700 } }).window).toBeUndefined();
  });
  it('keeps size when the position is missing or bad', () => {
    expect(sanitizeSettings({ window: { width: 900, height: 600, x: 'left' } }).window).toEqual({ width: 900, height: 600 });
  });
});

describe('SettingsStore', () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('persists changes and reloads them', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'cadrel-settings-'));
    const file = path.join(dir, 'sub', 'shell.json');
    const a = new SettingsStore(file);
    await a.load();
    a.update((s) => {
      s.page = 'market';
    });
    await a.flush();
    const b = new SettingsStore(file);
    await b.load();
    expect(b.get().page).toBe('market');
  });

  it('starts from defaults when the file is damaged', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'cadrel-settings-'));
    const file = path.join(dir, 'shell.json');
    writeFileSync(file, '{ not json');
    const s = new SettingsStore(file);
    await s.load();
    expect(s.get()).toEqual({ page: 'home' });
    s.update((x) => {
      x.page = 'dashboard';
    });
    await s.flush();
    expect(JSON.parse(readFileSync(file, 'utf8')).page).toBe('dashboard');
  });
});
