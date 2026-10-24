import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DraftRecord } from '../src/shared/api';
import { writeFileAtomic } from './files';

/** Autosaved unsaved edits, one JSON file per source file, for recovery after a crash. */
export class DraftStore {
  constructor(private readonly dir: string) {}

  private fileFor(source: string): string {
    return path.join(this.dir, createHash('sha1').update(source).digest('hex') + '.json');
  }

  async save(draft: DraftRecord): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await writeFileAtomic(this.fileFor(draft.file), JSON.stringify(draft));
  }

  async clear(source: string): Promise<void> {
    await fs.rm(this.fileFor(source), { force: true });
  }

  async list(): Promise<DraftRecord[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const out: DraftRecord[] = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      try {
        const d = JSON.parse(await fs.readFile(path.join(this.dir, n), 'utf8')) as Partial<DraftRecord>;
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
