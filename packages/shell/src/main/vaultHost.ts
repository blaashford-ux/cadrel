/**
 * The vault as the Files page sees it: the local vault for the active Studio, with people's names, what the person may do, and the lock
 * removals that were kept aside. Electron-free; tested in test/vaultHost.test.ts.
 */
import { promises as fsp } from 'node:fs';
import type { DataCard, FileRef, FileVersion } from '@cadrel/kernel';
import type { LocalVault } from '@cadrel/store';
import type { VaultState } from '../shared/api';
import type { PeopleHost } from './people';

export class VaultHostError extends Error {}

/** The changes the page may ask for, by name. A list, so inherited names such as `constructor` are not reachable. */
export const VAULT_CALL_NAMES = ['add', 'checkOut', 'checkIn', 'undoCheckOut', 'discardLocalChanges', 'getLatest', 'forceRelease', 'saveVersionAs', 'addReference', 'setReferenceVersion', 'removeReference', 'setCard'] as const;

export class VaultHost {
  constructor(private readonly people: PeopleHost, private readonly where: { dir: string; blobsDir: string; machine: string }) {}

  private vault(): LocalVault {
    return this.people.vault(this.where) ?? (() => { throw new VaultHostError('The files of this Studio are kept by its owner.'); })();
  }

  async state(): Promise<VaultState> {
    const v = this.people.vault(this.where);
    if (!v) return { available: false, reason: 'The files of this Studio are kept by its owner.' };
    await fsp.mkdir(this.where.dir, { recursive: true });
    const kept = await v.keepOrphansAside().catch(() => []); // a lock removed from under this person: their copy is put aside before anything else (needs the server)
    const entries = await v.list(); // when the Studio's server cannot be reached this is what was last known, and `offline` says so
    const away = () => this.people.offline;
    // the rest also comes from the server: when it is away they are empty, not an error
    const [people, force, orphans] = await Promise.all([this.people.peopleList().catch(() => []), this.people.may('vault.force').catch(() => false), v.orphans()]);
    return { available: true, dir: this.where.dir, machine: this.where.machine, me: this.people.me, people, may: { force }, entries, kept, orphans, ...(away() ? { offline: true } : {}) };
  }

  async call(name: string, args: unknown[]): Promise<unknown> {
    if (!(VAULT_CALL_NAMES as readonly string[]).includes(name)) throw new VaultHostError('That is not something the Files page can do.');
    const v = this.vault();
    await fsp.mkdir(this.where.dir, { recursive: true });
    return (v as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name]!(...args);
  }

  history(path: string): Promise<FileVersion[]> {
    return this.vault().history(path);
  }

  /** One file's versions, what it uses, where it is used and its data card. */
  async detail(path: string): Promise<{ versions: FileVersion[]; uses: FileRef[]; usedBy: FileRef[]; card: DataCard }> {
    const v = this.vault();
    const [versions, uses, usedBy, card] = await Promise.all([v.history(path), v.references(path), v.whereUsed(path), v.card(path)]);
    return { versions, uses, usedBy, card };
  }
}
