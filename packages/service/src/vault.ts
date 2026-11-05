/**
 * The vault as one person on the Studio's server: the kernel's vault operations (`DbVaultStore`) behind the permission check. Reading or
 * changing a file needs the capability for the kind of thing it is (a manuscript or an asset) where the file lives: on the project its data
 * card names, or at the studio when it names none. So a guest given one project sees that project's files and nothing else, an Author who
 * may write manuscripts cannot change an asset, and only `vault.force` takes a lock from someone. The person is fixed when this is made.
 */
import { DbVaultStore, cleanVaultPath, fileKind, type AddFileResult, type CheckInResult, type CheckOutResult, type DataCard, type Db, type FileRef, type FileVersion, type ForceResult, type Orphan, type VaultListing, type VaultStore } from '@cadrel/kernel';
import { PermissionDenied } from './errors';
import type { StudioAs } from './index';

export class VaultAs implements VaultStore {
  private readonly store: DbVaultStore;
  constructor(private readonly o: { db: Db; studioId: string; personId: string; as: StudioAs; now?: () => Date; /** Whether a version's contents are in the store: a record of a version that is not there would be worse than none. */ hasBlob?: (hash: string) => Promise<boolean> }) {
    this.store = new DbVaultStore(o);
  }

  private cap(path: string, level: 'read' | 'write'): string {
    return `${fileKind(path) === 'manuscript' ? 'manuscript' : 'asset'}.${level}`;
  }
  private async may(f: Pick<VaultListing, 'path' | 'projectId'>, level: 'read' | 'write'): Promise<boolean> {
    return this.o.as.canAt(this.cap(f.path, level), f.projectId);
  }
  private async need(f: Pick<VaultListing, 'path' | 'projectId'>, level: 'read' | 'write'): Promise<void> {
    if (!(await this.may(f, level))) throw new PermissionDenied(this.cap(f.path, level), 'no active role grants it here');
  }
  private async stored(hash: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('That is not a content hash.');
    if (this.o.hasBlob && !(await this.o.hasBlob(hash))) throw new Error('The file’s contents have not been uploaded yet.');
  }
  /** The file, if this person may read it: one they may not read is reported as absent, not as forbidden, so its existence is not given away. */
  private async file(fileId: string, level: 'read' | 'write' = 'read'): Promise<VaultListing> {
    const f = (await this.store.list()).find((x) => x.id === fileId);
    if (!f || !(await this.may(f, 'read'))) throw new Error('That file is not in the vault.');
    if (level === 'write') await this.need(f, 'write');
    return f;
  }

  async list(): Promise<VaultListing[]> {
    const out: VaultListing[] = [];
    for (const f of await this.store.list()) if (await this.may(f, 'read')) out.push(f);
    return out;
  }
  async versions(fileId: string): Promise<FileVersion[]> {
    await this.file(fileId);
    return this.store.versions(fileId);
  }
  async addFile(a: { path: string; hash: string; size: number; comment: string; machine: string; projectId?: string | null }): Promise<AddFileResult> {
    const c = cleanVaultPath(a.path);
    if (!c.ok) throw new Error(c.reason);
    await this.need({ path: c.path, projectId: a.projectId ?? null }, 'write');
    await this.stored(a.hash);
    return this.store.addFile({ ...a, path: c.path });
  }
  async checkOut(a: { fileId: string; machine: string }): Promise<CheckOutResult> {
    await this.file(a.fileId, 'write');
    return this.store.checkOut(a);
  }
  async checkIn(a: { fileId: string; machine: string; hash: string; size: number; comment: string }): Promise<CheckInResult> {
    await this.file(a.fileId, 'write');
    await this.stored(a.hash);
    return this.store.checkIn(a);
  }
  async undoCheckOut(a: { fileId: string; machine: string }): Promise<boolean> {
    await this.file(a.fileId, 'write');
    return this.store.undoCheckOut(a);
  }
  async forceRelease(a: { fileId: string; reason: string }): Promise<ForceResult> {
    const f = await this.file(a.fileId);
    if (!(await this.o.as.canAt('vault.force', f.projectId))) throw new PermissionDenied('vault.force', 'no active role grants it here');
    return this.store.forceRelease(a);
  }
  orphans(): Promise<Orphan[]> {
    return this.store.orphans();
  }
  acknowledgeOrphans(a: { fileId: string; machine: string }): Promise<void> {
    return this.store.acknowledgeOrphans(a);
  }
  /** The files this person may read, by id: a reference to any other is left out, so its path is not given away. */
  private async readable(): Promise<Set<string>> {
    return new Set((await this.list()).map((f) => f.id));
  }
  async references(fileId: string): Promise<FileRef[]> {
    await this.file(fileId);
    const ok = await this.readable();
    return (await this.store.references(fileId)).filter((r) => ok.has(r.fileId));
  }
  async whereUsed(fileId: string): Promise<FileRef[]> {
    await this.file(fileId);
    const ok = await this.readable();
    return (await this.store.whereUsed(fileId)).filter((r) => ok.has(r.fileId));
  }
  async addReference(a: { fileId: string; refersToId: string; version?: number | null; note?: string }): Promise<void> {
    await this.file(a.fileId, 'write');
    await this.file(a.refersToId);
    return this.store.addReference(a);
  }
  async setReferenceVersion(a: { fileId: string; refersToId: string; version: number | null }): Promise<void> {
    await this.file(a.fileId, 'write');
    await this.file(a.refersToId);
    return this.store.setReferenceVersion(a);
  }
  async removeReference(a: { fileId: string; refersToId: string }): Promise<void> {
    await this.file(a.fileId, 'write');
    await this.file(a.refersToId);
    return this.store.removeReference(a);
  }
  async card(fileId: string): Promise<DataCard> {
    await this.file(fileId);
    return this.store.card(fileId);
  }
  async setCard(a: { fileId: string; fields: Record<string, string>; projectId?: string | null }): Promise<DataCard> {
    const f = await this.file(a.fileId, 'write');
    // moving a file to another project needs the right to write there too
    if (a.projectId !== undefined && a.projectId !== f.projectId) await this.need({ path: f.path, projectId: a.projectId }, 'write');
    return this.store.setCard(a);
  }
}
