import path from 'node:path';

/** UTC stamp used as a directory name, e.g. 20261018T120000Z. */
export function stampOf(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export function dbPath(root: string): string {
  return path.join(root, 'scout.db');
}

export function snapshotDir(root: string, asin: string, stamp: string): string {
  return path.join(root, 'books', asin, 'snapshots', stamp);
}

export function coversDir(root: string, asin: string): string {
  return path.join(root, 'books', asin, 'covers');
}

export function listDir(
  root: string,
  c: { marketplace: string; store: string; nodeId: string; listKind: string; page: number },
  stamp: string,
): string {
  return path.join(root, 'lists', c.marketplace, `${c.store}-${c.nodeId}`, `${c.listKind}-p${c.page}`, stamp);
}

export function categoryKey(marketplace: string, store: string, nodeId: string): string {
  return `${marketplace}:${store}:${nodeId}`;
}

export function isAsin(s: string): boolean {
  return /^[A-Z0-9]{10}$/.test(s);
}

export function searchDir(root: string, c: { marketplace: string; query: string }, stamp: string): string {
  const slug = c.query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'query';
  return path.join(root, 'searches', c.marketplace, slug, stamp);
}
