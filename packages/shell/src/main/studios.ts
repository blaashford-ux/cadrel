/**
 * The Studios this Cadrel knows about, kept on this computer: the one-person Studio that is always here, Studios the person created
 * (they own them) and, later, Studios they were invited to. Electron-free, tested in test/studios.test.ts.
 *
 * What this does not do yet: build a Studio in Cloudflare, issue invitations or back one up. `provision` checks the details and records the
 * account; the token is used once and never written down. Switching Studios changes which Studio the pages show; until Studios have their own
 * data folders, a Studio that is not the local one shows an explanation rather than another Studio's data.
 */
import { promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { ROLE_KEYS } from '@cadrel/kernel';
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

const localStudio = (): StudioEntry => ({ id: LOCAL_ID, name: 'My Studio', role: 'owner', status: 'local', url: null, accountId: null, createdAt: new Date(0).toISOString(), note: null });

/** Reads whatever is on disk defensively: a damaged file must never stop the app, and the local Studio is always there. */
export function sanitizeStudios(raw: unknown): Data {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(r.studios) ? r.studios : [];
  const studios: StudioEntry[] = [localStudio()];
  for (const x of list) {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' && /^[\w-]{1,40}$/.test(o.id) ? o.id : null;
    if (!id || studios.some((s) => s.id === id)) {
      if (id === LOCAL_ID && typeof o.name === 'string' && o.name.trim()) studios[0]!.name = o.name.trim().slice(0, 60);
      continue;
    }
    studios.push({
      id,
      name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 60) : 'Studio',
      role: o.role === 'member' ? 'member' : 'owner',
      status: STATUSES.includes(o.status as StudioStatus) && o.status !== 'local' ? (o.status as StudioStatus) : 'not-provisioned',
      url: typeof o.url === 'string' ? o.url : null,
      accountId: typeof o.accountId === 'string' && /^[0-9a-f]{32}$/i.test(o.accountId) ? o.accountId.toLowerCase() : null,
      createdAt: typeof o.createdAt === 'string' ? o.createdAt : new Date().toISOString(),
      note: typeof o.note === 'string' ? o.note : null
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
    if (this.data.studios.some((s) => s.id !== exceptId && s.name.toLowerCase() === n.toLowerCase())) return fail(`There is already a Studio called “${n}”.`);
    return n;
  }

  create(name: string): StudiosView {
    const n = this.checkName(name);
    const id = `s_${randomBytes(5).toString('hex')}`;
    this.data.studios.push({ id, name: n, role: 'owner', status: 'not-provisioned', url: null, accountId: null, createdAt: new Date().toISOString(), note: null });
    return this.save();
  }

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

  /**
   * Checks the Cloudflare details and records the account. Building the Studio in Cloudflare is not connected yet, so the Studio stays
   * "not provisioned" with a note saying so. The token is read here and dropped: it is never stored, logged or returned.
   */
  provision(id: string, details: { accountId: string; apiToken: string }): StudiosView {
    const s = this.owned(id);
    if (s.status === 'local') fail('The Studio on this computer has no server to provision.');
    const accountId = String(details?.accountId ?? '').trim().toLowerCase();
    const token = String(details?.apiToken ?? '').trim();
    if (!/^[0-9a-f]{32}$/.test(accountId)) fail('The Cloudflare account ID is 32 letters and numbers (find it on the Cloudflare dashboard, on the right of any domain’s overview or under Workers & Pages).');
    if (token.length < 20 || /\s/.test(token)) fail('That does not look like a Cloudflare API token. Paste the whole token, with no spaces.');
    s.accountId = accountId;
    s.note = 'Details checked. Building the Studio in Cloudflare is not connected in this build yet, so it has not been created.';
    return this.save();
  }
}
