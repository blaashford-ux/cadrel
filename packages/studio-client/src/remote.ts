/**
 * A Studio's service and vault as calls to somewhere else: the Studio's server (through the app's signed client), or the app's own local door
 * (see `DoorClient`), which is how the assistant's separate process reaches a server Studio without ever holding the device key.
 * No Electron and no Node: `fetch` is passed in.
 */
import { VAULT_STORE_METHODS, type CheckInResult, type CheckOutResult, type DataCard, type FileRef, type FileVersion, type ForceResult, type Orphan, type VaultListing, type VaultStore, type AddFileResult, type BetaRead } from '@cadrel/kernel';
import { decodeError, decodeValue, encodeValue, type StudioService, type WireError } from '@cadrel/service';

/** The service's namespaces and methods a remote caller may use. The server and the door both check a call against these. */
export const SERVICE_NAMESPACES = ['catalogue', 'people', 'business', 'work', 'workflows', 'briefs', 'passes', 'queries', 'assistant'] as const;
export const SERVICE_METHODS = ['can', 'canOn', 'canAt', 'explain', 'visibleProjects'] as const;
/** What the assistant may ask the vault: reading only. */
export const DOOR_VAULT_METHODS = ['list', 'versions', 'references', 'whereUsed', 'card'] as const;


/** The Studio's service, with each call sent to the server. `as(person)` ignores the person: the server uses the one the key belongs to. */
export function remoteService(client: { rpc<T>(path: string[], args: unknown[]): Promise<T> }): StudioService {
  const namespace = (name: string) =>
    new Proxy({}, { get: (_t, method) => (typeof method === 'string' && method !== 'then' ? (...args: unknown[]) => client.rpc([name, method], args) : undefined) });
  const as = new Proxy({}, {
    get: (_t, name) => {
      if (typeof name !== 'string' || name === 'then') return undefined;
      if ((SERVICE_NAMESPACES as readonly string[]).includes(name)) return namespace(name);
      if ((SERVICE_METHODS as readonly string[]).includes(name)) return (...args: unknown[]) => client.rpc([name], args);
      return undefined;
    }
  });
  return { as: () => as } as unknown as StudioService;
}

/** The vault's operations as calls to the server. */
export class RemoteVaultStore implements VaultStore {
  constructor(private readonly client: { vault<T>(method: string, arg?: unknown): Promise<T> }) {}
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
  betaRead = (fileId: string) => this.call<BetaRead>('betaRead', fileId);
  setBetaRead = (a: Parameters<VaultStore['setBetaRead']>[0]) => this.call<BetaRead>('setBetaRead', a);
}

/**
 * The app's local door, seen from the assistant's process: the same three calls as the Studio's client (`rpc`, `vault`, `getBlob`), sent to the
 * app over loopback with a token the app gave this process when it started it. The app signs and forwards them; the key stays in the app.
 */
export class DoorClient {
  constructor(private readonly o: { url: string; token: string; fetchFn: typeof fetch }) {}
  private async send(path: string, init: { method: string; body?: string }): Promise<Response> {
    try {
      return await this.o.fetchFn(`${this.o.url}${path}`, { ...init, headers: { 'x-cadrel-door': this.o.token, 'content-type': 'application/json' } });
    } catch {
      throw new Error('Cadrel is not running, so the Studio cannot be reached. Open Cadrel and try again.');
    }
  }
  private async call<T>(path: string, payload: unknown): Promise<T> {
    const res = await this.send(path, { method: 'POST', body: encodeValue(payload) });
    const text = await res.text();
    let data: { result?: T } & Partial<WireError>;
    try {
      data = decodeValue(text) as typeof data;
    } catch {
      throw new Error(`Cadrel answered with status ${res.status}.`);
    }
    if (!res.ok) throw data.kind ? decodeError(data as WireError) : new Error((data as { error?: string }).error ?? `Cadrel answered with status ${res.status}.`);
    return data.result as T;
  }
  rpc<T>(path: string[], args: unknown[]): Promise<T> {
    return this.call<T>('/call', { path, args });
  }
  vault<T>(method: string, arg?: unknown): Promise<T> {
    return this.call<T>('/vault', { method, args: [arg] });
  }
  async getBlob(hash: string): Promise<Uint8Array | null> {
    const res = await this.send(`/blob/${encodeURIComponent(hash)}`, { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Cadrel answered with status ${res.status}.`);
    return new Uint8Array(await res.arrayBuffer());
  }
}
