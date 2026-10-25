import type { DraftRecord } from '../api';
import type { FsPort } from '../fsPort';
import { joinPath } from '../paths';
import { sha1Hex } from '../sha1';
import { makeFiles } from './files';

/** Autosaved unsaved edits, one JSON file per source file, for recovery after a crash. */
export class DraftStore {
  private readonly writeFileAtomic: ReturnType<typeof makeFiles>['writeFileAtomic'];

  constructor(private readonly dir: string, private readonly fs: FsPort) {
    this.writeFileAtomic = makeFiles(fs).writeFileAtomic;
  }

  private fileFor(source: string): string {
    return joinPath(this.dir, sha1Hex(source) + '.json');
  }

  async save(draft: DraftRecord): Promise<void> {
    await this.fs.mkdir(this.dir, { recursive: true });
    await this.writeFileAtomic(this.fileFor(draft.file), JSON.stringify(draft));
  }

  async clear(source: string): Promise<void> {
    await this.fs.rm(this.fileFor(source), { force: true });
  }

  async list(): Promise<DraftRecord[]> {
    let names: string[];
    try {
      names = (await this.fs.readdir(this.dir)).map((e) => e.name);
    } catch {
      return [];
    }
    const out: DraftRecord[] = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      try {
        const d = JSON.parse(await this.fs.readText(joinPath(this.dir, n))) as Partial<DraftRecord>;
        if (
          typeof d.file === 'string' &&
          typeof d.markdown === 'string' &&
          typeof d.title === 'string' &&
          typeof d.chapter === 'number' &&
          typeof d.updatedAt === 'number'
        ) {
          out.push(d as DraftRecord);
        }
      } catch {
        // unreadable draft: ignore
      }
    }
    return out.sort((a, b) => a.updatedAt - b.updatedAt);
  }
}
