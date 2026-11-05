import { loadAccess } from '@cadrel/kernel';
import type { AccessSnapshot } from '@cadrel/service';
import type { Db } from '@cadrel/kernel';
import { readVersions, type Versions } from './d1';

/**
 * Who holds what, kept by the running Worker and reloaded only when `access_version` says it changed. Loading it reads every role, capability,
 * assignment, person and team (hundreds of rows, several times a check), which is where most of the database's reads were going.
 * Versions are read once per request (two rows) and shared by everything that request does.
 */
const kept = new WeakMap<object, { version: string; snapshot: AccessSnapshot }>();

export function requestVersions(d1: D1Database): () => Promise<Versions> {
  let p: Promise<Versions> | undefined;
  return () => (p ??= readVersions(d1));
}

export function cachedAccess(d1: D1Database, db: Db, studioId: string, versions: () => Promise<Versions>): () => Promise<AccessSnapshot> {
  let mine: Promise<AccessSnapshot> | undefined;
  return () =>
    (mine ??= (async () => {
      // the version is read before the records, so a change that lands in between is simply picked up by the next request
      const { access } = await versions();
      const held = kept.get(d1);
      if (held && held.version === access) return held.snapshot;
      const snapshot = await loadAccess(db, { studioId });
      kept.set(d1, { version: access, snapshot });
      return snapshot;
    })());
}
