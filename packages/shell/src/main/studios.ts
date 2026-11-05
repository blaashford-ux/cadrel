/**
 * The Studios this Cadrel knows about, kept on this computer: the one-person Studio that is always here, Studios the person created
 * (they own them) and Studios they joined by invitation. Electron-free, tested in test/studios.test.ts.
 *
 * This is the record only. Building a Studio in Cloudflare is `cloudflare.ts` and talking to a built one is `studioClient.ts`; they call
 * back here to say how it went. Which Studio is active decides which folders Cadrel opens at the next start: each Studio has its own data
 * folder and its own working folders, and nothing is shared between them.
 */
import { promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { ROLE_KEYS } from '@cadrel/kernel';
import { projectNameError } from '@cadrel/write/src/shared/projects';
import type { StudioEntry, StudioStatus, StudiosView } from '../shared/api';

export const LOCAL_ID = 'local';
export class StudioRegistryError extends Error {}
const fail = (m: string): never => {
  throw new StudioRegistryError(m);
};

interface Data {
  managerEnabled: boolean;
  activeId: string;
  studios: StudioEntry[];
}

const STATUSES: StudioStatus[] = ['local', 'not-provisioned', 'provisioning', 'ready', 'error'];

const localStudio = (): StudioEntry => ({
  id: LOCAL_ID, name: 'My Studio', role: 'owner', status: 'local', url: null, accountId: null, createdAt: new Date(0).toISOString(), note: null,
  folderName: 'My Studio', memberRole: null, fingerprint: null, tokenKept: false, resources: null, server: null, recordsOnServer: false
});

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

function sanitizeResources(raw: unknown): StudioEntry['resources'] {
  const o = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
  if (!o || !str(o.worker) || !str(o.d1Name) || !str(o.bucket)) return null;
  return { worker: o.worker as string, d1Id: str(o.d1Id), d1Name: o.d1Name as string, bucket: o.bucket as string };
}

/** Reads whatever is on disk defensively: a damaged file must never stop the app, and the local Studio is always there. */
export function sanitizeStudios(raw: unknown): Data {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(r.studios) ? r.studios : [];
  const studios: StudioEntry[] = [localStudio()];
  for (const x of list) {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(o.id) ? o.id : null;
    if (id === LOCAL_ID && typeof o.name === 'string' && o.name.trim()) studios[0]!.name = o.name.trim().slice(0, 60);
    if (!id || studios.some((s) => s.id === id)) continue;
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 60) : 'Studio';
    const taken = studios.map((s) => s.folderName.toLowerCase());
    let folderName = typeof o.folderName === 'string' && !projectNameError(o.folderName) ? o.folderName.trim() : name;
    if (projectNameError(folderName) || taken.includes(folderName.toLowerCase())) folderName = `${id}`;
    const server = (o.server && typeof o.server === 'object' ? o.server : null) as Record<string, unknown> | null;
    studios.push({
      id,
      name,
      role: o.role === 'member' ? 'member' : 'owner',
      status: STATUSES.includes(o.status as StudioStatus) && o.status !== 'local' ? (o.status as StudioStatus) : 'not-provisioned',
      url: str(o.url),
      accountId: typeof o.accountId === 'string' && /^[0-9a-f]{32}$/i.test(o.accountId) ? o.accountId.toLowerCase() : null,
      createdAt: str(o.createdAt) ?? new Date().toISOString(),
      note: str(o.note),
      folderName,
      memberRole: typeof o.memberRole === 'string' && (ROLE_KEYS as readonly string[]).includes(o.memberRole) ? o.memberRole : null,
      fingerprint: typeof o.fingerprint === 'string' && /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(o.fingerprint) ? o.fingerprint : null,
      tokenKept: o.tokenKept === true,
      resources: sanitizeResources(o.resources),
      server: server && int(server.api) !== null && int(server.schema) !== null ? { api: server.api as number, schema: server.schema as number } : null,
      // a Studio the person joined has its records on its server and nowhere else
      recordsOnServer: o.role === 'member' || o.recordsOnServer === true
    });
  }
  const activeId = typeof r.activeId === 'string' && studios.some((s) => s.id === r.activeId) ? r.activeId : LOCAL_ID;
  return { managerEnabled: r.managerEnabled === true, activeId, studios };
}

export class StudioRegistry {
  private data: Data = sanitizeStudios({});
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      this.data = sanitizeStudios(JSON.parse(await fsp.readFile(this.file, 'utf8')));
    } catch {
      this.data = sanitizeStudios({});
    }
  }

  view(): StudiosView {
    const active = this.entry(this.data.activeId);
    return {
      managerEnabled: this.data.managerEnabled,
      activeId: this.data.activeId,
      studios: this.data.studios.map((s) => ({ ...s })),
      connected: active.status === 'local' || active.status === 'ready'
    };
  }

  active(): StudioEntry {
    return { ...this.entry(this.data.activeId) };
  }

  get(id: string): StudioEntry {
    return { ...this.entry(id) };
  }

  private entry(id: string): StudioEntry {
    return this.data.studios.find((s) => s.id === id) ?? fail('There is no such Studio.');
  }

  private owned(id: string): StudioEntry {
    const s = this.entry(id);
    return s.role === 'owner' ? s : fail('You can only manage Studios you own.');
  }

  private save(): StudiosView {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.pending = this.pending.then(async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, snapshot);
      await fsp.rename(tmp, this.file);
    }).catch(() => undefined);
    return this.view();
  }

  flush(): Promise<void> {
    return this.pending;
  }

  setActive(id: string): StudiosView {
    this.entry(id);
    this.data.activeId = id;
    return this.save();
  }

  enableManager(on: boolean): StudiosView {
    this.data.managerEnabled = on === true;
    return this.save();
  }

  private checkName(name: unknown, exceptId?: string): string {
    const n = typeof name === 'string' ? name.trim() : '';
    if (!n) return fail('Give the Studio a name.');
    if (n.length > 60) return fail('A Studio name can be at most 60 characters.');
    const bad = projectNameError(n); // it becomes a folder name: the characters Windows will not allow are refused here
    if (bad) return fail(bad);
    if (this.data.studios.some((s) => s.id !== exceptId && (s.name.toLowerCase() === n.toLowerCase() || s.folderName.toLowerCase() === n.toLowerCase()))) return fail(`There is already a Studio called “${n}”.`);
    return n;
  }

  private add(e: Pick<StudioEntry, 'name' | 'role'> & Partial<StudioEntry>): StudioEntry {
    const id = `s${randomBytes(5).toString('hex')}`; // letters and digits only: it becomes part of a Worker's name
    const entry: StudioEntry = { ...localStudio(), id, status: 'not-provisioned', createdAt: new Date().toISOString(), folderName: e.name, ...e };
    this.data.studios.push(entry);
    return entry;
  }

  /** A Studio the person owns, not built yet. Its folder name is its name now and stays that if it is renamed later. */
  create(name: string): StudiosView {
    this.add({ name: this.checkName(name), role: 'owner' });
    return this.save();
  }

  /** Would joining a Studio under this name and address work? Asked before anything is sent, so a name clash cannot leave a half-joined Studio. */
  checkNewMember(name: string, url: string): string {
    if (this.data.studios.some((s) => s.url === url)) fail('You are already in that Studio.');
    return this.checkName(name);
  }

  /** A Studio the person was invited to and has joined. */
  addMember(o: { name: string; url: string; fingerprint: string; memberRole: string; studioId: string }): StudiosView {
    this.add({ name: this.checkNewMember(o.name, o.url), role: 'member', status: 'ready', recordsOnServer: true, url: o.url, fingerprint: o.fingerprint, memberRole: o.memberRole, note: null });
    return this.save();
  }

  /** The name only: a Studio's folder keeps the name it was made with, so nothing on disk has to move. */
  rename(id: string, name: string): StudiosView {
    const s = this.owned(id);
    s.name = this.checkName(name, id);
    return this.save();
  }

  remove(id: string): StudiosView {
    if (id === LOCAL_ID) fail('The Studio on this computer cannot be removed.');
    this.entry(id);
    this.data.studios = this.data.studios.filter((s) => s.id !== id);
    if (this.data.activeId === id) this.data.activeId = LOCAL_ID;
    return this.save();
  }

  /** What the build tells us as it goes. */
  update(id: string, patch: Partial<Pick<StudioEntry, 'status' | 'url' | 'accountId' | 'note' | 'fingerprint' | 'tokenKept' | 'resources' | 'server' | 'recordsOnServer'>>): StudiosView {
    const s = this.owned(id);
    Object.assign(s, patch);
    return this.save();
  }

  /** Syntax of the Cloudflare details, before anything is sent anywhere. */
  static checkCredentials(details: { accountId: string; apiToken: string }): { accountId: string; apiToken: string } {
    const accountId = String(details?.accountId ?? '').trim().toLowerCase();
    const apiToken = String(details?.apiToken ?? '').trim();
    if (!/^[0-9a-f]{32}$/.test(accountId)) fail('The Cloudflare account ID is 32 letters and numbers (find it on the Cloudflare dashboard, on the right of any domain’s overview or under Workers & Pages).');
    if (apiToken.length < 20 || /\s/.test(apiToken)) fail('That does not look like a Cloudflare API token. Paste the whole token, with no spaces.');
    return { accountId, apiToken };
  }
}
