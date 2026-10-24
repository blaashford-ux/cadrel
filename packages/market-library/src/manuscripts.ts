import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { contentMetrics, type Chapter, type ContentMetrics } from '@cadrel/market-core';
import type { Db } from './schema.js';
import { chunkText, estimateTokens, hashText } from './text.js';
import { removeVec } from './chunks.js';

export type TextSource = 'upload' | 'sample';

export interface ManuscriptInput {
  source: TextSource;
  /** "pdf", "epub", "docx", "txt", "md" for uploads; "ocr" for sample screenshots. */
  kind: string;
  /** Original file name, or the sample session. */
  label: string;
  text: string;
  chapters: Chapter[];
  pages?: number | null;
  warnings?: string[];
  /** OCR mean confidence (0-100). */
  quality?: number | null;
  /** For samples: the capture reached the end-of-sample screen. Uploads are always complete. */
  complete?: boolean;
  /** The original file, kept as dropped. */
  original?: { name: string; data: Buffer };
  createdAt?: string;
}

export interface ManuscriptRow {
  asin: string;
  source: TextSource;
  kind: string;
  label: string | null;
  chars: number;
  words: number;
  pages: number | null;
  chapters: number;
  quality: number | null;
  complete: boolean;
  warnings: string[];
  createdAt: string;
}

export const MANUSCRIPT_KIND: Record<TextSource, string> = { upload: 'manuscript', sample: 'sample_text' };
const CHUNK_CHARS = 1200;

export const extractedDir = (root: string, asin: string) => path.join(root, 'books', asin, 'extracted');
const safeName = (n: string) => n.replace(/[^\w.\- ()]+/g, '_').slice(0, 120) || 'file';

function validateAsin(asin: string) {
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error('bad ASIN');
}

/** Write the text, metadata and (for uploads) the original file under the book's folder. */
export function writeManuscriptFiles(root: string, asin: string, m: ManuscriptInput, metrics: ContentMetrics): void {
  const dir = extractedDir(root, asin);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${m.source}.txt`), m.text);
  fs.writeFileSync(
    path.join(dir, `${m.source}.json`),
    JSON.stringify({ source: m.source, kind: m.kind, label: m.label, pages: m.pages ?? null, chapters: m.chapters, warnings: m.warnings ?? [], quality: m.quality ?? null, complete: m.complete ?? true, createdAt: m.createdAt, metrics }, null, 2),
  );
  if (m.original) {
    const od = path.join(root, 'books', asin, 'manuscript');
    fs.mkdirSync(od, { recursive: true });
    fs.writeFileSync(path.join(od, safeName(m.original.name)), m.original.data);
  }
}

/** Insert or replace the row and chunks for a book's text, from files already on disk. */
export function indexManuscript(db: Db, root: string, asin: string, source: TextSource): boolean {
  const dir = extractedDir(root, asin);
  const jf = path.join(dir, `${source}.json`);
  const tf = path.join(dir, `${source}.txt`);
  if (!fs.existsSync(jf) || !fs.existsSync(tf)) return false;
  const meta = JSON.parse(fs.readFileSync(jf, 'utf8')) as {
    kind: string; label: string | null; pages: number | null; chapters: Chapter[]; warnings: string[]; quality: number | null; complete: boolean; createdAt: string; metrics: ContentMetrics;
  };
  const text = fs.readFileSync(tf, 'utf8');
  db.transaction(() => {
    db.prepare(
      `INSERT INTO manuscript (asin, source, kind, label, chars, words, pages, chapters, quality, complete, warnings, metrics, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(asin, source) DO UPDATE SET kind=excluded.kind, label=excluded.label, chars=excluded.chars, words=excluded.words, pages=excluded.pages,
         chapters=excluded.chapters, quality=excluded.quality, complete=excluded.complete, warnings=excluded.warnings, metrics=excluded.metrics, created_at=excluded.created_at`,
    ).run(asin, source, meta.kind, meta.label, text.length, meta.metrics.words, meta.pages, meta.chapters.length, meta.quality, meta.complete ? 1 : 0, JSON.stringify(meta.warnings ?? []), JSON.stringify(meta.metrics), meta.createdAt);
    chunkManuscript(db, asin, source, text, meta.chapters);
  })();
  return true;
}

/** Chunk by chapter so no chunk straddles a chapter break; unchanged chunks keep their ids (and embeddings). */
export function chunkManuscript(db: Db, asin: string, source: TextSource, text: string, chapters: Chapter[]): void {
  const kind = MANUSCRIPT_KIND[source];
  const spans: { title: string | null; text: string }[] = chapters.length
    ? [
        ...(chapters[0]!.start > 0 ? [{ title: null, text: text.slice(0, chapters[0]!.start) }] : []),
        ...chapters.map((c) => ({ title: c.title, text: text.slice(c.start, c.end) })),
      ]
    : [{ title: null, text }];
  const want: { ordinal: number; text: string; hash: string; meta: string }[] = [];
  let ordinal = 0;
  spans.forEach((s, ci) => {
    for (const piece of chunkText(s.text, CHUNK_CHARS)) want.push({ ordinal: ordinal++, text: piece, hash: hashText(piece), meta: JSON.stringify({ chapter: s.title, chapterIndex: ci }) });
  });
  const have = db.prepare('SELECT id, ordinal, text_hash FROM chunk WHERE asin = ? AND kind = ?').all(asin, kind) as unknown as { id: number; ordinal: number; text_hash: string }[];
  const key = (o: number, h: string) => `${o}|${h}`;
  const keep = new Set(want.map((w) => key(w.ordinal, w.hash)));
  const present = new Set<string>();
  for (const h of have) {
    const k = key(h.ordinal, h.text_hash);
    if (keep.has(k) && !present.has(k)) present.add(k);
    else {
      db.prepare('DELETE FROM chunk WHERE id = ?').run(h.id);
      removeVec(db, h.id);
    }
  }
  const ins = db.prepare('INSERT INTO chunk (asin, snapshot_id, kind, ordinal, text, text_hash, token_count, meta) VALUES (?,?,?,?,?,?,?,?)');
  for (const w of want) if (!present.has(key(w.ordinal, w.hash))) ins.run(asin, 0, kind, w.ordinal, w.text, w.hash, estimateTokens(w.text), w.meta);
}

/** Save a manuscript: write files, compute metrics, index. */
export function saveManuscript(db: Db, root: string, asin: string, m: ManuscriptInput): ManuscriptRow {
  validateAsin(asin);
  if (!db.scalar('SELECT 1 FROM book WHERE asin = ?', asin)) throw new Error(`capture the book's page first: no book with ASIN ${asin} in the library`);
  const text = m.text; // stored exactly as given: chapter offsets refer to it
  if (text.trim().length < 20) throw new Error('no readable text was found in that file');
  const createdAt = m.createdAt ?? new Date().toISOString();
  const basis = m.source === 'upload' ? 'manuscript' : 'sample';
  const metrics = contentMetrics(text, { chapters: m.chapters, basis });
  writeManuscriptFiles(root, asin, { ...m, text, createdAt }, metrics);
  indexManuscript(db, root, asin, m.source);
  return getManuscripts(db, asin).find((r) => r.source === m.source)!;
}

export function removeManuscript(db: Db, root: string, asin: string, source: TextSource): boolean {
  const dir = extractedDir(root, asin);
  for (const ext of ['txt', 'json']) fs.rmSync(path.join(dir, `${source}.${ext}`), { force: true });
  db.prepare('DELETE FROM chunk WHERE asin = ? AND kind = ?').run(asin, MANUSCRIPT_KIND[source]);
  return Number(db.prepare('DELETE FROM manuscript WHERE asin = ? AND source = ?').run(asin, source).changes) > 0;
}

export function getManuscripts(db: Db, asin: string): ManuscriptRow[] {
  return (
    db.prepare('SELECT asin, source, kind, label, chars, words, pages, chapters, quality, complete, warnings, created_at AS createdAt FROM manuscript WHERE asin = ? ORDER BY source').all(asin) as unknown as (Omit<ManuscriptRow, 'complete' | 'warnings'> & { complete: number; warnings: string | null })[]
  ).map((r) => ({ ...r, complete: !!r.complete, warnings: JSON.parse(r.warnings ?? '[]') as string[] }));
}

/** The text to analyse: the uploaded manuscript if there is one, otherwise the sample. */
export function bestText(db: Db, asin: string): TextSource | null {
  const s = getManuscripts(db, asin).map((r) => r.source);
  return s.includes('upload') ? 'upload' : s.includes('sample') ? 'sample' : null;
}

export function readManuscriptText(root: string, asin: string, source: TextSource): string | null {
  try {
    return fs.readFileSync(path.join(extractedDir(root, asin), `${source}.txt`), 'utf8');
  } catch {
    return null;
  }
}

export function contentMetricsOf(db: Db, asin: string, source?: TextSource): { source: TextSource; metrics: ContentMetrics } | null {
  const src = source ?? bestText(db, asin);
  if (!src) return null;
  const j = db.scalar<string>('SELECT metrics FROM manuscript WHERE asin = ? AND source = ?', asin, src);
  return j ? { source: src, metrics: JSON.parse(j) as ContentMetrics } : null;
}

/** An excerpt with its chapter, for citing. */
export function excerpt(root: string, db: Db, asin: string, opts: { source?: TextSource; chapter?: number; offset?: number; chars?: number } = {}) {
  const source = opts.source ?? bestText(db, asin);
  if (!source) return null;
  const text = readManuscriptText(root, asin, source);
  if (text == null) return null;
  const meta = JSON.parse(fs.readFileSync(path.join(extractedDir(root, asin), `${source}.json`), 'utf8')) as { chapters: Chapter[] };
  const chars = Math.min(Math.max(opts.chars ?? 3000, 200), 12000);
  let base = 0, end = text.length, chapterTitle: string | null = null;
  if (opts.chapter != null) {
    const c = meta.chapters[opts.chapter];
    if (!c) return { error: `chapter ${opts.chapter} not found (0 to ${meta.chapters.length - 1})` as const };
    base = c.start; end = c.end; chapterTitle = c.title;
  }
  const from = Math.min(end, base + Math.max(0, opts.offset ?? 0));
  const to = Math.min(end, from + chars);
  return { source, chapter: chapterTitle, from, to, total: text.length, chapters: meta.chapters.map((c, i) => ({ index: i, title: c.title })), text: text.slice(from, to), more: to < end };
}

/** Rebuild the manuscript rows and chunks from the extracted folders of every book. */
export function reindexManuscripts(db: Db, root: string): number {
  db.exec('DELETE FROM manuscript');
  const books = path.join(root, 'books');
  let n = 0;
  if (!fs.existsSync(books)) return 0;
  for (const asin of fs.readdirSync(books)) {
    if (!/^[A-Z0-9]{10}$/.test(asin) || !db.scalar('SELECT 1 FROM book WHERE asin = ?', asin)) continue;
    for (const source of ['upload', 'sample'] as const) if (indexManuscript(db, root, asin, source)) n++;
  }
  return n;
}

export const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
