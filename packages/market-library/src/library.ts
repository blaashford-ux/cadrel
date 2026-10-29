import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import {
  parseDetailPage,
  parseListPage,
  parseSearchPage,
  scrub,
  detectPersonalLiterals,
  type DetailCapture,
  type ListCapture,
  type SearchCapture,
  type ParseIssue,
} from '@cadrel/market-core';
import { openDb, type Db } from './schema.js';
import { rechunkBook, saveTextBlocks } from './chunks.js';
import { resetVectors } from './embeddings.js';
import { addAnnotation, exportUserData, importUserData, removeAnnotation, renameTag } from './userdata.js';
import { setQueueState } from './queries.js';
import { renameCategory } from './category.js';
import { reindexCommunity } from './community.js';
import { excludeFromCategory, excludedAsins, insertListEntry, refreshDerived, removeBook, purgeBook, restoreToCategory, type RemovedBook } from './removal.js';
import { reindexSales } from './sales/import.js';
import type { AuthorScope } from './sales/scope.js';
import { reindexManuscripts, removeManuscript, saveManuscript, type ManuscriptInput, type ManuscriptRow, type TextSource } from './manuscripts.js';
import { categoryKey, coversDir, dbPath, isAsin, listDir, searchDir, snapshotDir, stampOf } from './layout.js';

export type PageKind = 'detail' | 'list' | 'search';

export interface CaptureInput {
  kind: PageKind;
  url: string;
  html: string;
  /** ISO time the page was captured; defaults to now. */
  capturedAt?: string;
}

export interface CaptureMeta {
  kind: PageKind;
  url: string;
  capturedAt: string;
}

export interface IngestResult {
  kind: PageKind;
  dir: string;
  /** ASIN for detail pages. */
  asin?: string;
  /** Category key for list pages. */
  categoryKey?: string;
  /** The search words for search pages. */
  query?: string;
  issues: ParseIssue[];
  /** true when this exact capture already existed and was replaced. */
  replaced: boolean;
}

export function detectKind(url: string): PageKind | null {
  if (/\/(?:zgbs|gp\/bestsellers|gp\/new-releases|gp\/movers-and-shakers)\b/.test(url)) return 'list';
  if (/\/(?:dp|gp\/product)\/[A-Z0-9]{10}/.test(url)) return 'detail';
  if (/^https?:\/\/(?:www\.)?amazon\.com\/s\/?\?(?:[^#]*&)?k=[^&]/.test(url)) return 'search';
  return null;
}

export interface RebuildCounts { detail: number; list: number; search: number }

/** Parse a stored or incoming page with the parser for its kind. */
function parsePage(meta: CaptureMeta, html: string): DetailCapture | ListCapture | SearchCapture {
  return meta.kind === 'detail' ? parseDetailPage(html) : meta.kind === 'search' ? parseSearchPage(html, meta.url) : parseListPage(html);
}

const gz = (s: string | Buffer) => zlib.gzipSync(s, { level: 9 });

export class Library {
  readonly db: Db;

  private constructor(readonly root: string, scope: AuthorScope = null) {
    fs.mkdirSync(root, { recursive: true });
    this.db = openDb(dbPath(root));
    importUserData(this.db, root);
    // a lost database: the community files are still there
    if (!this.db.scalar('SELECT 1 FROM sales_day') && fs.existsSync(path.join(root, 'sales'))) reindexSales(this.db, root, scope);
    if (!this.db.scalar('SELECT 1 FROM community_source') && !this.db.scalar('SELECT 1 FROM community_item') && fs.existsSync(path.join(root, 'community'))) reindexCommunity(this.db, root);
  }

  /** `scope` limits what is rebuilt from the saved reports if the database was lost: the pen names of the Studio this library is for (see sales/scope.ts). */
  static open(root: string, scope: AuthorScope = null): Library {
    return new Library(root, scope);
  }

  /** Mutations of user-authored data go through here so the on-disk mirror stays current. */
  annotate(asin: string, kind: 'tag' | 'note', value: string): boolean {
    const added = addAnnotation(this.db, { asin, kind, value });
    exportUserData(this.db, this.root);
    return added;
  }

  /** Rename a tag on every book (merging into an existing tag of that name; an empty name removes it). Returns how many books had it. */
  renameTag(from: string, to: string): number {
    const n = renameTag(this.db, from, to);
    exportUserData(this.db, this.root);
    return n;
  }

  unannotate(asin: string, kind: 'tag' | 'note', value: string): boolean {
    const removed = removeAnnotation(this.db, { asin, kind, value });
    exportUserData(this.db, this.root);
    return removed;
  }

  /** Attach the text of a book (an upload or OCR'd sample). Replaces the previous one from the same source. */
  attachText(asin: string, m: ManuscriptInput): ManuscriptRow {
    return saveManuscript(this.db, this.root, asin, m);
  }

  detachText(asin: string, source: TextSource): boolean {
    return removeManuscript(this.db, this.root, asin, source);
  }

  setQueue(asin: string, state: 'pending' | 'opened' | 'skipped'): void {
    setQueueState(this.db, asin, state);
    exportUserData(this.db, this.root);
  }

  /** Take a book out of a category's lists (wrong genre) and keep it out; the analyses, search and MCP stop seeing it there. */
  excludeFromCategory(asin: string, categoryKey: string): { entries: number } {
    const r = excludeFromCategory(this.db, asin, categoryKey);
    exportUserData(this.db, this.root);
    return r;
  }

  restoreToCategory(asin: string, categoryKey: string): { entries: number } {
    const r = restoreToCategory(this.db, this.root, asin, categoryKey);
    exportUserData(this.db, this.root);
    return r;
  }

  /** Give a category your own name (null to go back to Amazon's); it survives re-captures and rebuilds. */
  renameCategory(categoryKey: string, name: string | null): { name: string | null; previous: string | null } {
    const r = renameCategory(this.db, categoryKey, name);
    exportUserData(this.db, this.root);
    return r;
  }

  /** Delete a mistakenly captured book (database, index and files), then clear what was derived from it. */
  removeBook(asin: string, o: { alsoExclude?: boolean } = {}): RemovedBook {
    const r = removeBook(this.db, this.root, asin, o);
    refreshDerived(this.db);
    exportUserData(this.db, this.root);
    return r;
  }

  /** Remove every trace of a book added by mistake (see purgeBook). */
  purge(asin: string): { asin: string; rows: number } {
    const r = purgeBook(this.db, this.root, asin);
    refreshDerived(this.db);
    return r;
  }

  /** Clear derived data whose source is gone (cover measurements, search-index entries). The analyses themselves are computed on demand. */
  refreshDerived(): { coverMetrics: number; chunks: number } {
    return refreshDerived(this.db);
  }

  close(): void {
    this.db.close();
  }

  /** Scrub, store the raw page, parse, and index. Raw files are written before parsing so a parser bug never loses a capture. */
  ingest(input: CaptureInput): IngestResult {
    const capturedAt = input.capturedAt ?? new Date().toISOString();
    const stamp = stampOf(new Date(capturedAt));
    const html = scrub(input.html, detectPersonalLiterals(input.html));
    const meta: CaptureMeta = { kind: input.kind, url: input.url, capturedAt };

    // Parse first only to learn where the files belong; nothing is indexed until they are on disk.
    const parsed = parsePage(meta, html);
    let dir: string;
    if (input.kind === 'detail') {
      const asin = (parsed as DetailCapture).asin;
      if (!asin || !isAsin(asin)) throw new Error('detail page has no recognisable ASIN');
      dir = snapshotDir(this.root, asin, stamp);
    } else if (input.kind === 'search') {
      const sc = parsed as SearchCapture;
      if (!sc.query) throw new Error('search page has no search words');
      dir = searchDir(this.root, sc, stamp);
    } else {
      const lc = parsed as ListCapture;
      if (!lc.nodeId) throw new Error('list page has no category node id');
      dir = listDir(this.root, lc, stamp);
    }
    const replaced = fs.existsSync(path.join(dir, 'page.html.gz'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'page.html.gz'), gz(html));
    fs.writeFileSync(path.join(dir, 'capture.json'), JSON.stringify(meta, null, 2));
    fs.writeFileSync(path.join(dir, 'parsed.json'), JSON.stringify(parsed, null, 2));

    const rel = path.relative(this.root, dir).split(path.sep).join('/');
    const result = this.db.transaction(() => this.index(meta, parsed, rel, replaced))();
    return result;
  }

  /** Store a cover (or other image) next to the book. Content-addressed, so repeats are free. */
  saveAsset(asin: string, kind: 'cover' | 'other', bytes: Buffer, ext: string, capturedAt = new Date().toISOString()): string {
    if (!isAsin(asin)) throw new Error('bad ASIN');
    if (!/^[a-z0-9]{2,5}$/.test(ext)) throw new Error('bad extension');
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const dir = coversDir(this.root, asin);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sha.slice(0, 16)}.${ext}`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
    this.db
      .prepare('INSERT OR IGNORE INTO asset (sha256, asin, kind, path, bytes, captured_at) VALUES (?,?,?,?,?,?)')
      .run(sha, asin, kind, path.relative(this.root, file).split(path.sep).join('/'), bytes.length, capturedAt);
    return sha;
  }

  /** True while the index is being rebuilt; captures wait (the ingest server answers 503). */
  rebuilding = false;

  /** Throw away the database and rebuild it from the files, re-parsing every stored page with the current parsers. */
  rebuild(): RebuildCounts {
    const g = this.rebuildSteps();
    let r = g.next();
    while (!r.done) r = g.next();
    return r.value;
  }

  /** Same, but yields to the event loop between pages so the app stays responsive on large libraries. */
  async rebuildAsync(onProgress?: (done: number, total: number) => void): Promise<RebuildCounts> {
    const g = this.rebuildSteps();
    let r = g.next();
    while (!r.done) {
      onProgress?.(r.value.done, r.value.total);
      if (r.value.done % 10 === 0) await new Promise((res) => setImmediate(res));
      r = g.next();
    }
    return r.value;
  }

  private *rebuildSteps(): Generator<{ done: number; total: number }, RebuildCounts> {
    const counts: RebuildCounts = { detail: 0, list: 0, search: 0 };
    this.rebuilding = true;
    resetVectors(this.db);
    this.db.begin();
    try {
      for (const t of ['chunk', 'manuscript', 'text_block', 'parse_issue', 'list_entry', 'list_capture', 'search_entry', 'search_capture', 'rank_entry', 'format_offer', 'snapshot', 'category', 'book']) {
        this.db.exec(`DELETE FROM ${t}`);
      }
      const dirs = findCaptureDirs(this.root);
      let done = 0;
      for (const dir of dirs) {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, 'capture.json'), 'utf8')) as CaptureMeta;
        const html = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'page.html.gz'))).toString('utf8');
        const parsed = parsePage(meta, html);
        fs.writeFileSync(path.join(dir, 'parsed.json'), JSON.stringify(parsed, null, 2));
        this.index(meta, parsed, path.relative(this.root, dir).split(path.sep).join('/'), false);
        counts[meta.kind]++;
        yield { done: ++done, total: dirs.length };
      }
      reindexManuscripts(this.db, this.root);
      reindexCommunity(this.db, this.root);
      this.db.commit();
    } catch (e) {
      this.db.rollback();
      throw e;
    } finally {
      this.rebuilding = false;
    }
    return counts;
  }

  private index(meta: CaptureMeta, parsed: DetailCapture | ListCapture | SearchCapture, relDir: string, replaced: boolean): IngestResult {
    return meta.kind === 'detail'
      ? this.indexDetail(meta, parsed as DetailCapture, relDir, replaced)
      : meta.kind === 'search'
        ? this.indexSearch(meta, parsed as SearchCapture, relDir, replaced)
        : this.indexList(meta, parsed as ListCapture, relDir, replaced);
  }

  private indexDetail(meta: CaptureMeta, d: DetailCapture, relDir: string, replaced: boolean): IngestResult {
    const db = this.db;
    const asin = d.asin!;
    db.prepare(
      `INSERT INTO book (asin, marketplace, title, first_seen, last_seen) VALUES (?,?,?,?,?)
       ON CONFLICT(asin) DO UPDATE SET
         title = CASE WHEN excluded.last_seen >= book.last_seen THEN COALESCE(excluded.title, book.title) ELSE book.title END,
         first_seen = MIN(book.first_seen, excluded.first_seen),
         last_seen = MAX(book.last_seen, excluded.last_seen)`,
    ).run(asin, d.marketplace ?? 'amazon.com', d.title, meta.capturedAt, meta.capturedAt);

    // Re-capturing the same instant replaces the old rows (cascade clears children).
    db.prepare('DELETE FROM snapshot WHERE asin = ? AND captured_at = ?').run(asin, meta.capturedAt);
    const info = db
      .prepare(
        `INSERT INTO snapshot (asin, captured_at, dir, url, title, authors, series_name, series_position, series_total,
           rating_value, rating_count, histogram, kindle_price, pages, publication_date, publisher, language, isbn13,
           file_size_mb, description, has_read_sample)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        asin, meta.capturedAt, relDir, meta.url, d.title, JSON.stringify(d.authors),
        d.series?.name ?? null, d.series?.position ?? null, d.series?.total ?? null,
        d.ratingValue, d.ratingCount, d.histogram ? JSON.stringify(d.histogram) : null,
        d.kindlePrice, d.pages, d.publicationDate, d.publisher, d.language, d.isbn13,
        d.fileSizeMb, d.description, d.hasReadSample ? 1 : 0,
      );
    const sid = Number(info.lastInsertRowid);

    const fo = db.prepare('INSERT INTO format_offer (snapshot_id, code, label, price, note) VALUES (?,?,?,?,?)');
    for (const f of d.formats) fo.run(sid, f.code, f.label, f.price, f.note);

    const mp = d.marketplace ?? 'amazon.com';
    const cat = db.prepare(
      `INSERT INTO category (key, marketplace, store, node_id, name, path) VALUES (?,?,?,?,?,NULL)
       ON CONFLICT(key) DO UPDATE SET name = COALESCE(category.name, excluded.name)`, // a list page's own name wins
    );
    const re = db.prepare('INSERT INTO rank_entry (snapshot_id, category_key, store, scope, name, rank) VALUES (?,?,?,?,?,?)');
    for (const r of d.ranks) {
      const key = r.nodeId ? categoryKey(mp, r.store, r.nodeId) : null;
      if (key && r.nodeId) cat.run(key, mp, r.store, r.nodeId, r.name);
      re.run(sid, key, r.store, r.scope, r.name, r.rank);
    }
    saveTextBlocks(db, sid, d);
    rechunkBook(db, asin);
    this.saveIssues('snapshot', sid, d.issues);
    return { kind: 'detail', dir: relDir, asin, issues: d.issues, replaced };
  }

  private indexList(meta: CaptureMeta, l: ListCapture, relDir: string, replaced: boolean): IngestResult {
    const db = this.db;
    const key = categoryKey(l.marketplace, l.store, l.nodeId);
    db.prepare(
      `INSERT INTO category (key, marketplace, store, node_id, name, path) VALUES (?,?,?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET name = excluded.name, path = excluded.path`,
    ).run(key, l.marketplace, l.store, l.nodeId, l.categoryName, JSON.stringify(l.categoryPath));

    db.prepare('DELETE FROM list_capture WHERE category_key = ? AND list_kind = ? AND page = ? AND captured_at = ?').run(
      key, l.listKind, l.page, meta.capturedAt,
    );
    const info = db
      .prepare(
        `INSERT INTO list_capture (category_key, list_kind, page, captured_at, dir, url, listed_count, rendered_count)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(key, l.listKind, l.page, meta.capturedAt, relDir, meta.url, l.listedCount, l.renderedCount);
    const id = Number(info.lastInsertRowid);
    // books the user took out of this category stay out of every re-capture and rebuild
    const out = excludedAsins(db, key);
    for (const e of l.entries) if (!out.has(e.asin)) insertListEntry(db, id, e);
    this.saveIssues('list_capture', id, l.issues);
    return { kind: 'list', dir: relDir, categoryKey: key, issues: l.issues, replaced };
  }

  private indexSearch(meta: CaptureMeta, sc: SearchCapture, relDir: string, replaced: boolean): IngestResult {
    const db = this.db;
    db.prepare('DELETE FROM search_capture WHERE query = ? AND marketplace = ? AND captured_at = ?').run(sc.query, sc.marketplace, meta.capturedAt);
    const info = db
      .prepare('INSERT INTO search_capture (query, marketplace, captured_at, dir, url, result_count, result_count_min, listed_count) VALUES (?,?,?,?,?,?,?,?)')
      .run(sc.query, sc.marketplace, meta.capturedAt, relDir, meta.url, sc.resultCount, sc.resultCountIsMinimum ? 1 : 0, sc.entries.length);
    const id = Number(info.lastInsertRowid);
    const ins = db.prepare('INSERT INTO search_entry (search_capture_id, position, asin, sponsored, title, author, rating_value, rating_count, price, format) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const e of sc.entries) ins.run(id, e.position, e.asin, e.sponsored ? 1 : 0, e.titleRaw, e.authorRaw, e.ratingValue, e.ratingCount, e.price, e.format);
    this.saveIssues('search_capture', id, sc.issues);
    return { kind: 'search', dir: relDir, query: sc.query, issues: sc.issues, replaced };
  }

  private saveIssues(kind: string, id: number, issues: ParseIssue[]): void {
    const st = this.db.prepare('INSERT INTO parse_issue (source_kind, source_id, field, severity, detail) VALUES (?,?,?,?,?)');
    for (const i of issues) st.run(kind, id, i.field, i.severity, i.detail);
  }
}

function findCaptureDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name);
      if (fs.existsSync(path.join(p, 'capture.json'))) out.push(p);
      else walk(p);
    }
  };
  for (const top of ['books', 'lists', 'searches']) {
    const p = path.join(root, top);
    if (fs.existsSync(p)) walk(p);
  }
  return out.sort();
}
