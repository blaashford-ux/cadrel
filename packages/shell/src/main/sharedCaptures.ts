/**
 * Sharing Market's captures through a Studio's file store. What this computer has that the Studio lacks is sent; what the Studio has that this
 * computer lacks is fetched, packed the way Market's own data packs are, and read in by Market's normal import (which parses and indexes each
 * page and keeps what is already there). Electron-free; tested against the real Worker code in test/remote.test.ts.
 */
import crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import type { StudioClient } from './studioClient';

const SEG = '[A-Za-z0-9._-]+';
const STAMP = '\\d{8}T\\d{6}Z';
/** The same shapes the Studio's server accepts (and Market's data packs). */
const CAPTURE_PATH = new RegExp(
  `^(?:books/[A-Z0-9]{10}/snapshots/${STAMP}/(?:capture\\.json|page\\.html\\.gz)|books/[A-Z0-9]{10}/covers/[0-9a-f]{16}\\.[a-z0-9]{2,5}|lists/${SEG}/${SEG}/${SEG}/${STAMP}/(?:capture\\.json|page\\.html\\.gz)|searches/${SEG}/${SEG}/${STAMP}/(?:capture\\.json|page\\.html\\.gz))$`
);

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  const entries = await fsp.readdir(path.join(root, dir), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(root, rel, out);
    else if (e.isFile() && CAPTURE_PATH.test(rel)) out.push(rel);
  }
}

export interface SharedResult {
  sent: number;
  fetched: number;
  /** What Market's import did with the fetched pages. */
  imported: { added: number; alreadyHad: number; skipped: number } | null;
}

export async function syncCaptures(o: {
  client: StudioClient;
  /** The Market library's folder. */
  root: string;
  /** Market's import of a data pack file. */
  importPack: (file: string) => Promise<{ added: number; alreadyHad: number; skipped: number }>;
  step?: (text: string) => void;
}): Promise<SharedResult> {
  const say = o.step ?? (() => undefined);
  const mine: string[] = [];
  for (const top of ['books', 'lists', 'searches']) await walk(o.root, top, mine);
  const theirs = new Set<string>();
  for (let cursor: string | undefined; ; ) {
    const page = await o.client.captures(cursor);
    for (const f of page.files) theirs.add(f.path);
    if (!page.next) break;
    cursor = page.next;
  }
  const have = new Set(mine);

  const toSend = mine.filter((p) => !theirs.has(p));
  let sent = 0;
  for (const rel of toSend) {
    say(`Sending captures (${sent + 1} of ${toSend.length})`);
    await o.client.putCapture(rel, new Uint8Array(await fsp.readFile(path.join(o.root, ...rel.split('/')))));
    sent++;
  }

  const toGet = [...theirs].filter((p) => CAPTURE_PATH.test(p) && !have.has(p));
  const files: Record<string, Uint8Array> = {};
  let fetched = 0;
  for (const rel of toGet) {
    say(`Fetching captures (${fetched + 1} of ${toGet.length})`);
    const bytes = await o.client.getCapture(rel);
    if (bytes) {
      files[rel] = bytes;
      fetched++;
    }
  }
  if (!fetched) return { sent, fetched: 0, imported: null };

  const counts = { books: 0, lists: 0, searches: 0, covers: 0, files: fetched };
  const manifest = { format: 'cadrel-market-data-pack', version: 2, id: crypto.randomUUID(), createdAt: new Date().toISOString(), scope: 'all', categories: [], counts };
  const pack = path.join(os.tmpdir(), `cadrel-shared-${crypto.randomBytes(6).toString('hex')}.zip`);
  await fsp.writeFile(pack, zipSync({ 'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)), ...files }));
  try {
    say('Reading the fetched captures');
    return { sent, fetched, imported: await o.importPack(pack) };
  } finally {
    await fsp.rm(pack, { force: true });
  }
}
