import { mkdtempSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { fsPortSuite } from '../src/shared/fsPortSuite';
import { nodeFs } from './nodeFs';

const made: string[] = [];
afterAll(async () => {
  for (const d of made) await fs.rm(d, { recursive: true, force: true });
});

fsPortSuite('node', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mdedit-fsport-'));
  made.push(root);
  return { fs: nodeFs, root, join: (...p) => path.join(...p) };
});
