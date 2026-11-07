/**
 * The Studios this phone has joined, and which one is open. Kept in the app's own storage (private to the app on Android): each entry holds the
 * key pair this phone made when it joined, which is what the Studio recognises it by. There are no passwords. Losing the phone's storage loses
 * the key; the owner then removes that member and invites the person again.
 */
import type { KeyPair } from '@cadrel/kernel';
import type { FsPort } from '@cadrel/write/src/shared/fsPort';

export interface JoinedStudio {
  id: string;
  name: string;
  url: string;
  /** The owner's key, as the invitation named it. */
  fingerprint: string;
  role: string;
  /** What the person told the Studio to call them. */
  me: string;
  key: KeyPair;
  joinedAt: string;
}

interface Persisted {
  /** Names this phone to the vault's locks; made once. */
  installId: string;
  active: string | null;
  studios: JoinedStudio[];
}

const newInstallId = (): string => {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

export class StudioRegistry {
  private data: Persisted = { installId: newInstallId(), active: null, studios: [] };

  constructor(private readonly fs: FsPort, private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await this.fs.readText(this.file)) as Partial<Persisted>;
      const studios = (Array.isArray(raw.studios) ? raw.studios : []).filter((s): s is JoinedStudio => !!s && typeof s.id === 'string' && typeof s.url === 'string' && !!s.key && typeof s.key.privateKey === 'string');
      this.data = { installId: typeof raw.installId === 'string' && raw.installId ? raw.installId : this.data.installId, active: studios.some((s) => s.id === raw.active) ? (raw.active as string) : studios[0]?.id ?? null, studios };
    } catch {
      /* first run */
    }
  }

  private async save(): Promise<void> {
    const dir = this.file.slice(0, this.file.lastIndexOf('/'));
    if (dir) await this.fs.mkdir(dir, { recursive: true });
    await this.fs.writeText(this.file, JSON.stringify(this.data));
  }

  get installId(): string {
    return this.data.installId;
  }
  list(): JoinedStudio[] {
    return this.data.studios;
  }
  active(): JoinedStudio | null {
    return this.data.studios.find((s) => s.id === this.data.active) ?? null;
  }

  /** Adds a Studio (a second joining of the same one replaces its key) and opens it. */
  async add(s: JoinedStudio): Promise<void> {
    this.data.studios = [...this.data.studios.filter((x) => x.id !== s.id), s];
    this.data.active = s.id;
    await this.save();
  }
  async setActive(id: string): Promise<void> {
    if (!this.data.studios.some((s) => s.id === id)) throw new Error('This phone has not joined that Studio.');
    this.data.active = id;
    await this.save();
  }
  async remove(id: string): Promise<void> {
    this.data.studios = this.data.studios.filter((s) => s.id !== id);
    if (this.data.active === id) this.data.active = this.data.studios[0]?.id ?? null;
    await this.save();
  }
}
