/**
 * What the vault needs from wherever the Studio's records are kept, as one interface. On a computer with the records file it is the kernel's
 * functions on that file (`DbVaultStore`); for a Studio whose records are on its server it is a call to the server, which runs the same
 * functions behind its permission checks (the service's `VaultAs`). Either way the person is fixed when the store is made, so a caller
 * cannot act as someone else. Contents are not here: they are kept apart, by hash (see `BlobStore` in the store package).
 */
import { acknowledgeOrphans, addVaultFile, checkIn, checkOut, fileVersions, forceRelease, listVaultFiles, pendingOrphans, undoCheckOut, type CheckInResult, type CheckOutResult, type Db, type FileVersion, type ForceResult, type VaultFileRow } from './vault';
import { addReference, getCard, referencesOf, removeReference, setCard, setReferenceVersion, whereUsed, type DataCard, type FileRef } from './fileLinks';
import { newRecordId } from './ids';

export type Orphan = { fileId: string; machine: string; baseVersion: number; removedBy: string; removedAt: string; reason: string };

/** A file as the vault lists it: the row, and the project its data card names (that decides who may see it). */
export interface VaultListing extends VaultFileRow {
  projectId: string | null;
}

export type AddFileResult = { ok: true; id: string; version: number } | { ok: false; reason: 'exists' | 'locked' | 'not-holder' };

export interface VaultStore {
  list(): Promise<VaultListing[]>;
  versions(fileId: string): Promise<FileVersion[]>;
  /** Puts a new file in the vault as version 1 (its contents are already stored under `hash`), left checked in. */
  addFile(a: { path: string; hash: string; size: number; comment: string; machine: string; projectId?: string | null }): Promise<AddFileResult>;
  checkOut(a: { fileId: string; machine: string }): Promise<CheckOutResult>;
  checkIn(a: { fileId: string; machine: string; hash: string; size: number; comment: string }): Promise<CheckInResult>;
  undoCheckOut(a: { fileId: string; machine: string }): Promise<boolean>;
  forceRelease(a: { fileId: string; reason: string }): Promise<ForceResult>;
  /** Lock removals this person's machines have not yet kept their copy aside for. */
  orphans(): Promise<Orphan[]>;
  acknowledgeOrphans(a: { fileId: string; machine: string }): Promise<void>;
  references(fileId: string): Promise<FileRef[]>;
  whereUsed(fileId: string): Promise<FileRef[]>;
  addReference(a: { fileId: string; refersToId: string; version?: number | null; note?: string }): Promise<void>;
  setReferenceVersion(a: { fileId: string; refersToId: string; version: number | null }): Promise<void>;
  removeReference(a: { fileId: string; refersToId: string }): Promise<void>;
  card(fileId: string): Promise<DataCard>;
  setCard(a: { fileId: string; fields: Record<string, string>; projectId?: string | null }): Promise<DataCard>;
}

/** The names a caller (the server's dispatcher, a remote client) may use on a `VaultStore`. A list, so inherited names are not reachable. */
export const VAULT_STORE_METHODS = ['list', 'versions', 'addFile', 'checkOut', 'checkIn', 'undoCheckOut', 'forceRelease', 'orphans', 'acknowledgeOrphans', 'references', 'whereUsed', 'addReference', 'setReferenceVersion', 'removeReference', 'card', 'setCard'] as const;

/** The vault on a records file, with no permission checks of its own: the caller (the local vault, or the server's `VaultAs`) makes them. */
export class DbVaultStore implements VaultStore {
  constructor(private readonly o: { db: Db; studioId: string; personId: string; now?: () => Date }) {}
  private now(): string {
    return (this.o.now?.() ?? new Date()).toISOString();
  }

  async list(): Promise<VaultListing[]> {
    const files = await listVaultFiles(this.o.db, this.o.studioId);
    const cards = await this.o.db.all<{ fileId: string; projectId: string | null }>('SELECT file_id AS fileId, project_id AS projectId FROM file_card');
    const project = new Map(cards.map((c) => [c.fileId, c.projectId]));
    return files.map((f) => ({ ...f, projectId: project.get(f.id) ?? null }));
  }
  versions(fileId: string): Promise<FileVersion[]> {
    return fileVersions(this.o.db, fileId);
  }
  async addFile(a: { path: string; hash: string; size: number; comment: string; machine: string; projectId?: string | null }): Promise<AddFileResult> {
    const added = await addVaultFile(this.o.db, { studioId: this.o.studioId, path: a.path, personId: this.o.personId, now: this.now(), id: newRecordId() });
    if (!added.ok) return { ok: false, reason: 'exists' };
    const got = await checkOut(this.o.db, { fileId: added.id, personId: this.o.personId, machine: a.machine, now: this.now() });
    if (!got.ok) return { ok: false, reason: 'locked' };
    const done = await checkIn(this.o.db, { fileId: added.id, personId: this.o.personId, machine: a.machine, hash: a.hash, size: a.size, comment: a.comment, now: this.now() });
    if (!done.ok) return { ok: false, reason: 'not-holder' };
    if (a.projectId) await setCard(this.o.db, { fileId: added.id, fields: {}, projectId: a.projectId, actor: this.o.personId, now: this.now() });
    return { ok: true, id: added.id, version: done.version };
  }
  checkOut(a: { fileId: string; machine: string }): Promise<CheckOutResult> {
    return checkOut(this.o.db, { ...a, personId: this.o.personId, now: this.now() });
  }
  checkIn(a: { fileId: string; machine: string; hash: string; size: number; comment: string }): Promise<CheckInResult> {
    return checkIn(this.o.db, { ...a, personId: this.o.personId, now: this.now() });
  }
  undoCheckOut(a: { fileId: string; machine: string }): Promise<boolean> {
    return undoCheckOut(this.o.db, { ...a, personId: this.o.personId, now: this.now() });
  }
  forceRelease(a: { fileId: string; reason: string }): Promise<ForceResult> {
    return forceRelease(this.o.db, { fileId: a.fileId, adminId: this.o.personId, reason: a.reason, now: this.now() });
  }
  orphans(): Promise<Orphan[]> {
    return pendingOrphans(this.o.db, this.o.personId);
  }
  acknowledgeOrphans(a: { fileId: string; machine: string }): Promise<void> {
    return acknowledgeOrphans(this.o.db, { ...a, personId: this.o.personId, now: this.now() });
  }
  references(fileId: string): Promise<FileRef[]> {
    return referencesOf(this.o.db, fileId);
  }
  whereUsed(fileId: string): Promise<FileRef[]> {
    return whereUsed(this.o.db, fileId);
  }
  addReference(a: { fileId: string; refersToId: string; version?: number | null; note?: string }): Promise<void> {
    return addReference(this.o.db, { ...a, actor: this.o.personId, now: this.now() });
  }
  setReferenceVersion(a: { fileId: string; refersToId: string; version: number | null }): Promise<void> {
    return setReferenceVersion(this.o.db, { ...a, actor: this.o.personId, now: this.now() });
  }
  removeReference(a: { fileId: string; refersToId: string }): Promise<void> {
    return removeReference(this.o.db, { ...a, actor: this.o.personId, now: this.now() });
  }
  card(fileId: string): Promise<DataCard> {
    return getCard(this.o.db, fileId);
  }
  setCard(a: { fileId: string; fields: Record<string, string>; projectId?: string | null }): Promise<DataCard> {
    return setCard(this.o.db, { ...a, actor: this.o.personId, now: this.now() });
  }
}
