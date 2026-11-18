import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { removeBlock, sanitizeBlocks, upsertBlock, type TextBlock } from '../src/shared/textBlocks';

/** The saved text blocks, in one file in Write's data folder (so, in Cadrel, one per Studio). Changes are serialized and written whole. */
export class TextBlockStore {
  private blocks: TextBlock[] | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string, private readonly now: () => Date = () => new Date()) {}

  private async load(): Promise<TextBlock[]> {
    if (this.blocks) return this.blocks;
    try {
      this.blocks = sanitizeBlocks(JSON.parse(await fsp.readFile(this.file, 'utf8')));
    } catch {
      this.blocks = [];
    }
    return this.blocks;
  }
  private async persist(blocks: TextBlock[]): Promise<void> {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ version: 1, blocks }, null, 2));
    await fsp.rename(tmp, this.file);
    this.blocks = blocks;
  }
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.catch(() => undefined);
    return run;
  }

  list(): Promise<TextBlock[]> {
    return this.serial(() => this.load());
  }
  save(input: { kind: unknown; name: unknown; text: unknown }): Promise<TextBlock> {
    return this.serial(async () => {
      const r = upsertBlock(await this.load(), input, this.now().toISOString(), () => randomUUID());
      await this.persist(r.blocks);
      return r.saved;
    });
  }
  remove(id: string): Promise<void> {
    return this.serial(async () => this.persist(removeBlock(await this.load(), String(id))));
  }
}
