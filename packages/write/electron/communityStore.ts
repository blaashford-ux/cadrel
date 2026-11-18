import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkCommunities, sanitizeCommunities, type CommunityLink } from '../src/shared/community';

/** The Studio's community links, in one file in Write's data folder (so, in Cadrel, one per Studio). Saves are serialized and written whole. */
export class CommunityStore {
  private links: CommunityLink[] | null = null;
  /** When the file was last read or written here, so a change made by another process (the assistant) is noticed. */
  private stamp = -1;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.catch(() => undefined);
    return run;
  }
  private async load(): Promise<CommunityLink[]> {
    const at = await fsp.stat(this.file).then((s) => s.mtimeMs, () => 0);
    if (this.links && at === this.stamp) return this.links;
    try {
      this.links = sanitizeCommunities(JSON.parse(await fsp.readFile(this.file, 'utf8')));
    } catch {
      this.links = [];
    }
    this.stamp = at;
    return this.links;
  }

  list(): Promise<CommunityLink[]> {
    return this.serial(() => this.load());
  }
  /** Replaces the list (it is the whole of what the Studio keeps), after checking every entry. */
  save(input: unknown): Promise<CommunityLink[]> {
    return this.serial(async () => {
      const next = checkCommunities(input, () => randomUUID());
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify({ version: 1, links: next }, null, 2));
      await fsp.rename(tmp, this.file);
      this.links = next;
      this.stamp = await fsp.stat(this.file).then((s) => s.mtimeMs, () => 0);
      return next;
    });
  }
}
