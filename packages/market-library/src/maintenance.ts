import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './schema.js';

export interface HealthRow {
  /** ISO week start (Monday), YYYY-MM-DD. */
  week: string;
  kind: 'book pages' | 'list pages' | 'search pages';
  captures: number;
  /** Captures with at least one parse issue. */
  withIssues: number;
  share: number;
  /** Fields that went missing, most common first. */
  fields: { field: string; captures: number }[];
}

const weekOf = (iso: string): string => {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
};

/**
 * How well the parsers are coping, by week of capture. A rise in missing fields usually means Amazon changed a page
 * layout; the raw pages are kept, so fixing the parser and running "Re-read all pages" repairs old captures.
 */
export function parserHealth(db: Db): HealthRow[] {
  const rows: HealthRow[] = [];
  const spec = [
    { kind: 'book pages' as const, table: 'snapshot', src: 'snapshot' },
    { kind: 'list pages' as const, table: 'list_capture', src: 'list_capture' },
    { kind: 'search pages' as const, table: 'search_capture', src: 'search_capture' },
  ];
  for (const s of spec) {
    const caps = db.prepare(`SELECT id, captured_at AS at FROM ${s.table}`).all() as unknown as { id: number; at: string }[];
    const issues = db.prepare('SELECT source_id AS id, field FROM parse_issue WHERE source_kind = ?').all(s.src) as unknown as { id: number; field: string }[];
    const weekById = new Map(caps.map((c) => [c.id, weekOf(c.at)]));
    const byWeek = new Map<string, { captures: number; bad: Set<number>; fields: Map<string, Set<number>> }>();
    for (const c of caps) {
      const w = weekOf(c.at);
      if (!byWeek.has(w)) byWeek.set(w, { captures: 0, bad: new Set(), fields: new Map() });
      byWeek.get(w)!.captures++;
    }
    for (const i of issues) {
      const w = weekById.get(i.id);
      if (!w) continue;
      const e = byWeek.get(w)!;
      e.bad.add(i.id);
      if (!e.fields.has(i.field)) e.fields.set(i.field, new Set());
      e.fields.get(i.field)!.add(i.id);
    }
    for (const [week, e] of byWeek) {
      rows.push({
        week, kind: s.kind, captures: e.captures, withIssues: e.bad.size, share: Math.round((e.bad.size / e.captures) * 1000) / 1000,
        fields: [...e.fields.entries()].map(([field, ids]) => ({ field, captures: ids.size })).sort((a, b) => b.captures - a.captures || a.field.localeCompare(b.field)),
      });
    }
  }
  return rows.sort((a, b) => b.week.localeCompare(a.week) || a.kind.localeCompare(b.kind));
}

export interface VerifyReport {
  ok: boolean;
  integrity: string;
  foreignKeyProblems: number;
  /** Capture folders on disk that the database does not know about (run "Rebuild index"). */
  notIndexed: string[];
  /** Database rows whose files are gone. */
  missingFiles: string[];
  /** Assets recorded in the database but missing on disk. */
  missingAssets: string[];
  counts: { books: number; snapshots: number; listCaptures: number; assets: number };
  sizeBytes: number;
}

function walk(dir: string, fn: (file: string, size: number) => void) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, fn);
    else if (e.isFile()) fn(p, fs.statSync(p).size);
  }
}

export function dirSize(dir: string, skip: (rel: string) => boolean = () => false): number {
  let n = 0;
  const base = dir;
  const go = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (skip(path.relative(base, p))) continue;
      if (e.isDirectory()) go(p);
      else if (e.isFile()) n += fs.statSync(p).size;
    }
  };
  if (fs.existsSync(dir)) go(dir);
  return n;
}

/** Check that the database is sound and agrees with the files on disk. Reads only. */
export function verifyLibrary(db: Db, root: string): VerifyReport {
  const integrity = db.scalar<string>('PRAGMA integrity_check') ?? 'unknown';
  const fk = (db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;
  const indexed = new Set<string>();
  const missingFiles: string[] = [];
  for (const t of ['snapshot', 'list_capture', 'search_capture']) {
    for (const r of db.prepare(`SELECT dir FROM ${t}`).all() as unknown as { dir: string }[]) {
      indexed.add(r.dir);
      if (!fs.existsSync(path.join(root, r.dir, 'page.html.gz'))) missingFiles.push(r.dir);
    }
  }
  const notIndexed: string[] = [];
  for (const top of ['books', 'lists', 'searches']) {
    const base = path.join(root, top);
    if (!fs.existsSync(base)) continue;
    const go = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const p = path.join(d, e.name);
        if (fs.existsSync(path.join(p, 'capture.json'))) {
          const rel = path.relative(root, p).split(path.sep).join('/');
          if (!indexed.has(rel)) notIndexed.push(rel);
        } else go(p);
      }
    };
    go(base);
  }
  const missingAssets = (db.prepare('SELECT path FROM asset').all() as unknown as { path: string }[]).filter((a) => !fs.existsSync(path.join(root, a.path))).map((a) => a.path);
  const n = (sql: string) => db.scalar<number>(sql) ?? 0;
  return {
    ok: integrity === 'ok' && fk === 0 && !notIndexed.length && !missingFiles.length && !missingAssets.length,
    integrity, foreignKeyProblems: fk, notIndexed, missingFiles, missingAssets,
    counts: { books: n('SELECT count(*) FROM book'), snapshots: n('SELECT count(*) FROM snapshot'), listCaptures: n('SELECT count(*) FROM list_capture'), assets: n('SELECT count(*) FROM asset') },
    sizeBytes: dirSize(root),
  };
}

export interface CopyProgress {
  files: number;
  totalFiles: number;
  bytes: number;
  totalBytes: number;
}

const DB_FILES = /^scout\.db(-wal|-shm)?$/;

/**
 * Copy a library to a new folder: every file, then a consistent copy of the database (VACUUM INTO, safe while the app
 * is running). The destination must be empty or new and may not sit inside the source. Verified by file count and size.
 */
export async function copyLibrary(
  db: Db,
  src: string,
  dst: string,
  opts: { includeModels?: boolean; onProgress?: (p: CopyProgress) => void } = {},
): Promise<{ files: number; bytes: number }> {
  const s = path.resolve(src), d = path.resolve(dst);
  if (d === s || d.startsWith(s + path.sep)) throw new Error('the destination cannot be inside the library itself');
  if (s.startsWith(d + path.sep)) throw new Error('the destination cannot contain the library');
  if (fs.existsSync(d) && fs.readdirSync(d).length) throw new Error('the destination folder is not empty');
  fs.mkdirSync(d, { recursive: true });

  const skip = (rel: string) => DB_FILES.test(rel) || (!opts.includeModels && (rel === 'models' || rel.startsWith('models' + path.sep)));
  const files: { rel: string; size: number }[] = [];
  const collect = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(s, p);
      if (skip(rel)) continue;
      if (e.isDirectory()) collect(p);
      else if (e.isFile()) files.push({ rel, size: fs.statSync(p).size });
    }
  };
  collect(s);
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  let bytes = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    fs.mkdirSync(path.dirname(path.join(d, f.rel)), { recursive: true });
    fs.copyFileSync(path.join(s, f.rel), path.join(d, f.rel));
    bytes += f.size;
    if (i % 25 === 0 || i === files.length - 1) opts.onProgress?.({ files: i + 1, totalFiles: files.length, bytes, totalBytes });
    if (i % 200 === 199) await new Promise((r) => setImmediate(r)); // let the app breathe on big libraries
  }
  db.prepare('VACUUM INTO ?').run(path.join(d, 'scout.db'));

  // verify: same files, same sizes, and the copied database passes its own integrity check
  let copied = 0, copiedBytes = 0;
  walk(d, (file, size) => {
    if (DB_FILES.test(path.basename(file)) && path.dirname(file) === d) return;
    copied++;
    copiedBytes += size;
  });
  if (copied !== files.length || copiedBytes !== totalBytes) throw new Error(`copy check failed: expected ${files.length} files / ${totalBytes} bytes, found ${copied} / ${copiedBytes}`);
  return { files: files.length, bytes: totalBytes };
}
