/**
 * Write's Check out / Check in, done by the vault. Write works with absolute paths; the vault with paths inside the Projects folder. A file in a
 * project is read-only until it is checked out, and a check-in is what makes a version. Electron-free: tested in test/fileLocks.test.ts.
 */
import path from 'node:path';
import type { LocalVault } from '@cadrel/store';
import type { FileControl } from '@cadrel/write/electron/module';
import type { FileLock } from '@cadrel/write/src/shared/api';
import { isNotesFile, neverTracked } from './projectSync';

export function createFileControl(o: {
  vault(): LocalVault | null;
  /** The Projects folder. */
  dir(): string;
  /** Who is who, for "checked out by Ann". */
  names(): Promise<Map<string, string>>;
  me(): string;
  machine(): string;
  /** Whether the person may take a lock from someone (`vault.force`). */
  mayForce(): Promise<boolean>;
}): FileControl {
  const relOf = (abs: string): string | null => {
    const r = path.relative(o.dir(), abs);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
    const rel = r.split(path.sep).join('/');
    return rel.includes('/') && !isNotesFile(rel) && !neverTracked(rel) ? rel : null; // only a file inside a project's folder
  };

  const state = async (abs: string): Promise<FileLock> => {
    const rel = relOf(abs);
    const v = o.vault();
    if (!rel || !v) return { kind: 'unmanaged' };
    const e = await v.status(rel).catch(() => null);
    if (!e || e.status === 'untracked') return { kind: 'unmanaged' };
    switch (e.status) {
      case 'checked-out-by-me':
      case 'missing':
        return { kind: 'mine', version: e.localVersion ?? e.version ?? 0, since: e.lock?.since ?? '', changed: e.modified };
      case 'checked-out-by-other': {
        const l = e.lock!;
        const mine = l.personId === o.me();
        const by = mine ? `you, on ${l.machine === o.machine() ? 'this computer' : l.machine}` : (await o.names()).get(l.personId) ?? 'someone';
        return { kind: 'other', version: e.version ?? 0, by, since: l.since, canRelease: await o.mayForce().catch(() => false) };
      }
      case 'modified-unprotected':
        return { kind: 'unprotected', version: e.localVersion };
      default:
        return { kind: 'free', version: e.version ?? 0 };
    }
  };

  const need = (abs: string): { rel: string; v: LocalVault } => {
    const rel = relOf(abs);
    const v = o.vault();
    if (!rel || !v) throw new Error('This file is not kept in the Studio’s vault, so it has no check-out.');
    return { rel, v };
  };

  return {
    state,
    async checkOut(abs, opts) {
      const { rel, v } = need(abs);
      await v.checkOut(rel, opts);
      return state(abs);
    },
    async checkIn(abs, comment) {
      const { rel, v } = need(abs);
      await v.checkIn(rel, comment ?? '');
      return state(abs);
    },
    async release(abs, reason) {
      const { rel, v } = need(abs);
      await v.forceRelease(rel, reason);
      return state(abs);
    },
    async betaRead(abs) {
      const rel = relOf(abs);
      const v = o.vault();
      if (!rel || !v) return null;
      const e = await v.status(rel).catch(() => null);
      if (!e || e.status === 'untracked') return null;
      const r = await v.betaRead(rel);
      return { level: r.level, chapters: r.chapters };
    },
    async setBetaRead(abs, level, chapters) {
      const { rel, v } = need(abs);
      const r = await v.setBetaRead(rel, level, chapters);
      return { level: r.level, chapters: r.chapters };
    },
    async undoCheckOut(abs) {
      const { rel, v } = need(abs);
      await v.undoCheckOut(rel);
      return state(abs);
    }
  };
}
