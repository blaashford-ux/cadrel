import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures');

/** Loads a fixture by path under /fixtures; .gz files are decompressed. */
export function fixture(rel: string): string {
  const buf = readFileSync(join(root, rel));
  return (rel.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf-8');
}

export const DETAIL_ASINS = [
  'B0G7R6X55V', 'B0HLR7NQC7', 'B0HC7ZDQQ8', 'B0H7QRHNJR', 'B0HDJJ2XKY', // Cozy top 5
  'B0C1R52V2J', 'B0HKTD6M9Z', 'B0GZNJHYRW', 'B0GSCPBJLJ', 'B0GPRVQ8QJ', // Humorous top 5
];
export const detailFixture = (asin: string) => fixture(`amazon-com/detail-kindle-${asin}.html.gz`);
