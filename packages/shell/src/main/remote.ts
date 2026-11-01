/**
 * A Studio whose records are on its server, seen from this computer. The service the app uses everywhere (`StudioService`) is here a set of
 * calls to the server, which answers them as the person this computer's key belongs to and checks every one; the vault is the same
 * operations with the files' contents kept in the Studio's file store and a copy here. Nothing in the rest of the app needs to know.
 * Electron-free; tested against the real Worker code in test/remote.test.ts.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { VAULT_STORE_METHODS, type CheckInResult, type CheckOutResult, type DataCard, type FileRef, type FileVersion, type ForceResult, type Orphan, type VaultListing, type VaultStore, type AddFileResult } from '@cadrel/kernel';
import type { StudioService } from '@cadrel/service';
import { sha256, VaultError, type BlobStore } from '@cadrel/store';
import { StudioApiError, StudioOfflineError, type StudioClient } from './studioClient';

const NAMESPACES = ['catalogue', 'people', 'business', 'work', 'workflows'];
const METHODS = ['can', 'canOn', 'canAt', 'explain', 'visibleProjects'];

/** The Studio's service, with each call sent to the server. `as(person)` ignores the person: the server uses the one the key belongs to. */
export function remoteService(client: Pick<StudioClient, 'rpc'>): StudioService {
  const namespace = (name: string) =>
    new Proxy({}, { get: (_t, method) => (typeof method === 'string' && method !== 'then' ? (...args: unknown[]) => client.rpc([name, method], args) : undefined) });
  const as = new Proxy({}, {
    get: (_t, name) => {
      if (typeof name !== 'string' || name === 'then') return undefined;
      if (NAMESPACES.includes(name)) return namespace(name);
      if (METHODS.includes(name)) return (...args: unknown[]) => client.rpc([name], args);
      return undefined;
    }
  });
  return { as: () => as } as unknown as StudioService;
}

/** The vault's operations as calls to the server. */
export class RemoteVaultStore implements VaultStore {
  constructor(private readonly client: Pick<StudioClient, 'vault'>) {}
  private call<T>(method: (typeof VAULT_STORE_METHODS)[number], arg?: unknown): Promise<T> {
    return this.client.vault<T>(method, arg);
  }
  list = () => this.call<VaultListing[]>('list');
  versions = (fileId: string) => this.call<FileVersion[]>('versions', fileId);
  addFile = (a: Parameters<VaultStore['addFile']>[0]) => this.call<AddFileResult>('addFile', a);
  checkOut = (a: { fileId: string; machine: string }) => this.call<CheckOutResult>('checkOut', a);
  checkIn = (a: Parameters<VaultStore['checkIn']>[0]) => this.call<CheckInResult>('checkIn', a);
  undoCheckOut = (a: { fileId: string; machine: string }) => this.call<boolean>('undoCheckOut', a);
  forceRelease = (a: { fileId: string; reason: string }) => this.call<ForceResult>('forceRelease', a);
  orphans = () => this.call<Orphan[]>('orphans');
  acknowledgeOrphans = (a: { fileId: string; machine: string }) => this.call<void>('acknowledgeOrphans', a);
  references = (fileId: string) => this.call<FileRef[]>('references', fileId);
  whereUsed = (fileId: string) => this.call<FileRef[]>('whereUsed', fileId);
  addReference = (a: Parameters<VaultStore['addReference']>[0]) => this.call<void>('addReference', a);
  setReferenceVersion = (a: Parameters<VaultStore['setReferenceVersion']>[0]) => this.call<void>('setReferenceVersion', a);
  removeReference = (a: { fileId: string; refersToId: string }) => this.call<void>('removeReference', a);
  card = (fileId: string) => this.call<DataCard>('card', fileId);
  setCard = (a: Parameters<VaultStore['setCard']>[0]) => this.call<DataCard>('setCard', a);
}

/**
 * Keeps the last list the server gave, and gives it back, marked, when the server cannot be reached, so the Files page still shows what is
 * on this computer and what was known. Anything that changes the vault needs the server and says so. `orphans` and `versions` are empty or
 * come from what was cached while it is away.
 */
export class OfflineAwareStore implements VaultStore {
  private lastList: VaultListing[] | null = null;
  private away = false;
  constructor(private readonly inner: VaultStore, private readonly cacheFile: string) {}

  /** The last request found the server unreachable. */
  get offline(): boolean {
    return this.away;
  }
  private async seen<T>(job: () => Promise<T>): Promise<T> {
    try {
      const r = await job();
      this.away = false;
      return r;
    } catch (e) {
      if (e instanceof StudioOfflineError) this.away = true;
      throw e;
    }
  }
  private async need<T>(job: () => Promise<T>): Promise<T> {
    try {
      return await this.seen(job);
    } catch (e) {
      if (e instanceof StudioOfflineError) throw new VaultError('invalid', 'The Studio cannot be reached, so this cannot be done now. Files you have checked out can still be edited here; check them in when you are back online.');
      throw e;
    }
  }

  async list(): Promise<VaultListing[]> {
    try {
      const r = await this.seen(() => this.inner.list());
      this.lastList = r;
      await fsp.mkdir(path.dirname(this.cacheFile), { recursive: true });
      await fsp.writeFile(this.cacheFile, JSON.stringify(r)).catch(() => undefined);
      return r;
    } catch (e) {
      if (!(e instanceof StudioOfflineError)) throw e;
      if (!this.lastList) this.lastList = await fsp.readFile(this.cacheFile, 'utf8').then((t) => JSON.parse(t) as VaultListing[], () => []);
      return this.lastList;
    }
  }
  versions = (fileId: string) => this.need(() => this.inner.versions(fileId));
  addFile = (a: Parameters<VaultStore['addFile']>[0]) => this.need(() => this.inner.addFile(a));
  checkOut = (a: { fileId: string; machine: string }) => this.need(() => this.inner.checkOut(a));
  checkIn = (a: Parameters<VaultStore['checkIn']>[0]) => this.need(() => this.inner.checkIn(a));
  undoCheckOut = (a: { fileId: string; machine: string }) => this.need(() => this.inner.undoCheckOut(a));
  forceRelease = (a: { fileId: string; reason: string }) => this.need(() => this.inner.forceRelease(a));
  orphans = async () => (await this.seen(() => this.inner.orphans()).catch((e) => (e instanceof StudioOfflineError ? [] : Promise.reject(e)))) as Orphan[];
  acknowledgeOrphans = (a: { fileId: string; machine: string }) => this.need(() => this.inner.acknowledgeOrphans(a));
  references = (fileId: string) => this.need(() => this.inner.references(fileId));
  whereUsed = (fileId: string) => this.need(() => this.inner.whereUsed(fileId));
  addReference = (a: Parameters<VaultStore['addReference']>[0]) => this.need(() => this.inner.addReference(a));
  setReferenceVersion = (a: Parameters<VaultStore['setReferenceVersion']>[0]) => this.need(() => this.inner.setReferenceVersion(a));
  removeReference = (a: { fileId: string; refersToId: string }) => this.need(() => this.inner.removeReference(a));
  card = (fileId: string) => this.need(() => this.inner.card(fileId));
  setCard = (a: Parameters<VaultStore['setCard']>[0]) => this.need(() => this.inner.setCard(a));
}

/** Contents kept in the Studio's file store, and a copy on this computer so a version is fetched once. */
export class RemoteBlobs implements BlobStore {
  constructor(private readonly client: Pick<StudioClient, 'putBlob' | 'getBlob'>, private readonly local: BlobStore) {}
  async put(bytes: Uint8Array): Promise<string> {
    const hash = await this.local.put(bytes);
    try {
      await this.client.putBlob(hash, bytes);
    } catch (e) {
      if (e instanceof StudioOfflineError) throw new VaultError('invalid', 'The Studio cannot be reached, so this cannot be done now.');
      throw e;
    }
    return hash;
  }
  async get(hash: string): Promise<Uint8Array | null> {
    const mine = await this.local.get(hash);
    if (mine) return mine;
    const theirs = await this.client.getBlob(hash).catch((e) => (e instanceof StudioOfflineError ? null : Promise.reject(e)));
    if (!theirs || sha256(theirs) !== hash) return null; // a damaged or missing blob is as good as missing
    await this.local.put(theirs);
    return theirs;
  }
  async has(hash: string): Promise<boolean> {
    return (await this.get(hash)) !== null;
  }
}

export { StudioApiError };
