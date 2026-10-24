import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Zip, ZipDeflate, ZipPassThrough, unzipSync } from 'fflate';
import type { Library } from './library.js';
import { isAsin } from './layout.js';
import { applyCommunity, cleanSubreddit, writeSources } from './community.js';
import { categoryPhrase } from './keywords/ideas.js';
import { normalizeKeyword } from './keywords/suggest.js';

/**
 * A data pack is a zip of the raw captures (the pages BookScout saved, which are the source of truth) plus book covers, for all
 * categories or only chosen ones. Importing a pack re-reads each page with the current parsers, so a pack stays usable as the parsers
 * improve, and nothing in it is trusted for its paths or its parsed values.
 *
 * For chosen categories a pack sets a user up to analyse them: the category's lists and the books on them, covers, the Amazon searches
 * whose results are mostly those books, the linked subreddits and their stored text, the keyword research for those searches and for
 * seeds that contain the category's phrase, and the books taken out of the category by hand.
 *
 * Left out on purpose: book text and samples (often someone else's copyright), the queue, notes and tags, "My Books", sales
 * figures, API tokens and the settings. The search index's vectors are not shipped either: they are rebuilt on the importing computer.
 */
export const PACK_FORMAT = 'bookscout-data-pack';
export const PACK_VERSION = 2;

export interface PackManifest {
  format: typeof PACK_FORMAT;
  version: number;
  /** Identifies this pack. */
  id: string;
  createdAt: string;
  scope: 'all' | 'categories';
  categories: { key: string; name: string | null }[];
  counts: { books: number; lists: number; searches: number; covers: number; files: number };
  /** Version 2: the community and keyword data. Absent in a version 1 pack. */
  extra?: { subreddits: string[]; communityFiles: number; keywordSeeds: number; trends: number; exclusions: number };
}

interface KeywordsFile {
  /** Which category each phrase was researched for. */
  links: { keyword: string; category_key: string; linked_at: string }[];
  history: { seed: string; first_at: string; last_at: string; searches: number; phrases: number; sources: string }[];
  lookups: { source: string; seed: string; fetched_at: string; requests: number; stopped: string | null }[];
  signals: { source: string; seed: string; keyword: string; position: number; via: string }[];
  trends: { keyword: string; unit: string; geo: string | null; points: string; imported_at: string }[];
}
interface SourcesFile { sources: { categoryKey: string; subreddit: string; addedAt: string; lastSyncedAt: string | null }[] }
interface ExclusionsFile { exclusions: { categoryKey: string; asin: string; title: string | null; excludedAt: string }[] }

const META_KEYWORDS = 'meta/keywords.json';
const META_SOURCES = 'meta/community-sources.json';
const META_EXCLUSIONS = 'meta/exclusions.json';
const COMMUNITY_FILE = /^community\/([A-Za-z0-9_]{2,21})\/([A-Za-z0-9._-]+\.jsonl)$/;
const MAX_COMMUNITY_BYTES = 256 * 1024 * 1024;

export interface PackProgress { done: number; total: number }

export interface ExportOptions {
  /** Category keys to include; omitted or null means the whole library, searches included. */
  categoryKeys?: string[] | null;
  onProgress?: (p: PackProgress) => void;
}

const SEG = '[A-Za-z0-9._-]+';
const CAPTURE_DIR = new RegExp(`^(?:books/[A-Z0-9]{10}/snapshots|lists/${SEG}/${SEG}/${SEG}|searches/${SEG}/${SEG})/\\d{8}T\\d{6}Z$`);
const COVER_FILE = /^books\/([A-Z0-9]{10})\/covers\/[0-9a-f]{16}\.([a-z0-9]{2,5})$/;
const MAX_PAGE_BYTES = 64 * 1024 * 1024;
const MAX_COVER_BYTES = 32 * 1024 * 1024;

const tick = () => new Promise<void>((r) => setImmediate(r));

interface Selection {
  dirs: string[];
  covers: string[];
  counts: PackManifest['counts'];
  categories: PackManifest['categories'];
  /** Subreddit folders, the links from categories to subreddits, and the keyword seeds that belong to the selection (null: all). */
  subreddits: string[];
  sources: SourcesFile['sources'];
  seedCats: Map<string, Set<string>> | null;
  exclusions: ExclusionsFile['exclusions'];
}

/** Share of a search's results that must be books of the category for the search to count as that category's (and at least two). */
const SEARCH_SHARE = 0.2;

function select(lib: Library, keys: string[] | null): Selection {
  const db = lib.db;
  const dirs = new Set<string>();
  const covers = new Set<string>();
  const books = new Set<string>();
  const counts = { books: 0, lists: 0, searches: 0, covers: 0, files: 0 };
  let categories: PackManifest['categories'];
  let seedCats: Map<string, Set<string>> | null = null;
  let sources: SourcesFile['sources'];
  let exclusions: ExclusionsFile['exclusions'];
  const subsOf = (rows: { subreddit: string }[]) => [...new Set(rows.map((r) => r.subreddit))].sort();

  if (!keys) {
    for (const t of ['snapshot', 'list_capture', 'search_capture']) for (const r of db.prepare(`SELECT dir FROM ${t}`).all() as unknown as { dir: string }[]) dirs.add(r.dir);
    for (const r of db.prepare('SELECT asin FROM snapshot').all() as unknown as { asin: string }[]) books.add(r.asin);
    for (const r of db.prepare('SELECT path FROM asset').all() as unknown as { path: string }[]) covers.add(r.path);
    categories = db.prepare('SELECT key, name FROM category WHERE EXISTS (SELECT 1 FROM list_capture WHERE category_key = category.key) ORDER BY name').all() as unknown as PackManifest['categories'];
    sources = db.prepare('SELECT category_key AS categoryKey, subreddit, added_at AS addedAt, last_synced_at AS lastSyncedAt FROM community_source ORDER BY category_key, subreddit').all() as unknown as SourcesFile['sources'];
    exclusions = db.prepare('SELECT category_key AS categoryKey, asin, title, excluded_at AS excludedAt FROM category_exclusion ORDER BY category_key, asin').all() as unknown as ExclusionsFile['exclusions'];
  } else {
    const known = new Map((db.prepare('SELECT key, name FROM category').all() as unknown as { key: string; name: string | null }[]).map((c) => [c.key, c.name]));
    for (const k of keys) if (!known.has(k)) throw new Error(`unknown category ${k}`);
    categories = keys.map((key) => ({ key, name: known.get(key) ?? null }));
    const inKeys = `(${keys.map(() => '?').join(',')})`;
    sources = db.prepare(`SELECT category_key AS categoryKey, subreddit, added_at AS addedAt, last_synced_at AS lastSyncedAt FROM community_source WHERE category_key IN ${inKeys} ORDER BY category_key, subreddit`).all(...keys) as unknown as SourcesFile['sources'];
    exclusions = db.prepare(`SELECT category_key AS categoryKey, asin, title, excluded_at AS excludedAt FROM category_exclusion WHERE category_key IN ${inKeys} ORDER BY category_key, asin`).all(...keys) as unknown as ExclusionsFile['exclusions'];
    const lists = db.prepare('SELECT id, dir FROM list_capture WHERE category_key = ?');
    const listed = db.prepare('SELECT DISTINCT asin FROM list_entry WHERE list_capture_id = ?');
    const ranked = db.prepare('SELECT DISTINCT s.asin FROM rank_entry r JOIN snapshot s ON s.id = r.snapshot_id WHERE r.category_key = ?');
    const byCat = new Map<string, Set<string>>();
    for (const k of keys) {
      const mine = new Set<string>();
      for (const l of lists.all(k) as unknown as { id: number; dir: string }[]) {
        dirs.add(l.dir);
        for (const e of listed.all(l.id) as unknown as { asin: string }[]) mine.add(e.asin);
      }
      for (const r of ranked.all(k) as unknown as { asin: string }[]) mine.add(r.asin);
      byCat.set(k, mine);
      for (const a of mine) books.add(a);
    }
    const snaps = db.prepare('SELECT dir FROM snapshot WHERE asin = ?');
    const assets = db.prepare('SELECT path FROM asset WHERE asin = ?');
    for (const a of books) {
      for (const s of snaps.all(a) as unknown as { dir: string }[]) dirs.add(s.dir);
      for (const s of assets.all(a) as unknown as { path: string }[]) covers.add(s.path);
    }

    // Keyword research belongs to a category when it was filed under it (the Keywords tab's category), or, for research done before
    // that was recorded, when an Amazon search of the phrase shows mostly its books or the phrase contains the category's own phrase.
    seedCats = new Map();
    const claim = (seed: string, k: string) => seedCats!.set(seed, (seedCats!.get(seed) ?? new Set()).add(k));
    const linkedAnywhere = new Set((db.prepare('SELECT DISTINCT keyword FROM keyword_category').all() as unknown as { keyword: string }[]).map((r) => r.keyword));
    for (const l of db.prepare(`SELECT keyword, category_key AS k FROM keyword_category WHERE category_key IN ${inKeys}`).all(...keys) as unknown as { keyword: string; k: string }[]) claim(l.keyword, l.k);
    const searchEntries = db.prepare('SELECT asin FROM search_entry WHERE search_capture_id = ? AND sponsored = 0');
    for (const c of db.prepare('SELECT id, query, dir FROM search_capture').all() as unknown as { id: number; query: string; dir: string }[]) {
      const query = normalizeKeyword(c.query);
      if (seedCats.has(query)) dirs.add(c.dir); // a search of a phrase researched for these categories
      const asins = searchEntries.all(c.id) as unknown as { asin: string }[];
      if (!asins.length) continue;
      for (const [k, mine] of byCat) {
        const hit = asins.filter((e) => mine.has(e.asin)).length;
        if (hit < Math.max(2, Math.ceil(asins.length * SEARCH_SHARE))) continue;
        dirs.add(c.dir);
        if (!linkedAnywhere.has(query)) claim(query, k);
      }
    }
    const phrases = keys.map((k) => {
      const c = db.prepare('SELECT name, path FROM category WHERE key = ?').get(k) as { name: string | null; path: string | null };
      return { k, phrase: categoryPhrase(c.name, c.path ? (JSON.parse(c.path) as { name: string }[]) : []) };
    }).filter((p) => p.phrase.length >= 3);
    const allSeeds = new Set([
      ...(db.prepare('SELECT seed FROM keyword_history').all() as unknown as { seed: string }[]).map((r) => r.seed),
      ...(db.prepare('SELECT DISTINCT seed FROM keyword_lookup').all() as unknown as { seed: string }[]).map((r) => r.seed),
    ]);
    for (const sd of allSeeds) if (!linkedAnywhere.has(sd)) for (const p of phrases) if (sd.includes(p.phrase)) claim(sd, p.k);
  }
  for (const d of dirs) {
    if (d.startsWith('books/')) counts.books++;
    else if (d.startsWith('lists/')) counts.lists++;
    else if (d.startsWith('searches/')) counts.searches++;
  }
  counts.covers = covers.size;
  const subreddits = new Set(subsOf(sources));
  if (!keys) {
    // the whole library also carries text from subreddits no category is linked to
    try { for (const e of fs.readdirSync(path.join(lib.root, 'community'), { withFileTypes: true })) if (e.isDirectory()) subreddits.add(e.name); } catch { /* none */ }
  }
  return { dirs: [...dirs].sort(), covers: [...covers].sort(), counts, categories, subreddits: [...subreddits].sort(), sources, seedCats, exclusions };
}

function keywordsFor(lib: Library, keys: string[] | null, seedCats: Map<string, Set<string>> | null): KeywordsFile {
  const db = lib.db;
  const seeds = seedCats ? new Set(seedCats.keys()) : null;
  const pick = <T extends { seed: string }>(rows: T[]) => (seeds ? rows.filter((r) => seeds.has(r.seed)) : rows);
  const history = pick(db.prepare('SELECT seed, first_at, last_at, searches, phrases, sources FROM keyword_history ORDER BY seed').all() as unknown as KeywordsFile['history']);
  const lookups = pick(db.prepare('SELECT source, seed, fetched_at, requests, stopped FROM keyword_lookup ORDER BY seed, source').all() as unknown as KeywordsFile['lookups']);
  const signals = pick(db.prepare('SELECT source, seed, keyword, position, via FROM keyword_signal ORDER BY seed, source, position').all() as unknown as KeywordsFile['signals']);
  const trendRows = db.prepare('SELECT keyword, unit, geo, points, imported_at FROM keyword_trend ORDER BY keyword').all() as unknown as KeywordsFile['trends'];
  const wanted = seeds ? new Set([...seeds, ...signals.map((r) => r.keyword)]) : null;
  const trends = wanted ? trendRows.filter((t) => wanted.has(t.keyword)) : trendRows;
  const stored = db.prepare('SELECT keyword, category_key, linked_at FROM keyword_category ORDER BY keyword, category_key').all() as unknown as KeywordsFile['links'];
  const links = keys ? stored.filter((l) => keys.includes(l.category_key)) : stored;
  // research that was never filed under a category but belongs to one by its searches or wording arrives filed under it
  const have = new Set(links.map((l) => `${l.keyword}\n${l.category_key}`));
  const at = new Date().toISOString();
  for (const [kw, cats] of seedCats ?? []) for (const k of cats) if (!have.has(`${kw}\n${k}`)) links.push({ keyword: kw, category_key: k, linked_at: at });
  return { links, history, lookups, signals, trends };
}

/** Write a data pack to `dest` (a .zip file; it must not exist). Streams to disk, so a big library does not sit in memory. */
export async function exportPack(lib: Library, dest: string, opts: ExportOptions = {}): Promise<PackManifest> {
  const keys = opts.categoryKeys ?? null;
  if (keys && !keys.length) throw new Error('choose at least one category');
  if (fs.existsSync(dest)) throw new Error('that file already exists');
  const sel = select(lib, keys);
  const manifest: PackManifest = {
    format: PACK_FORMAT, version: PACK_VERSION, id: crypto.randomUUID(), createdAt: new Date().toISOString(),
    scope: keys ? 'categories' : 'all', categories: sel.categories, counts: sel.counts,
  };

  const files: { name: string; abs: string; store: boolean }[] = [];
  for (const d of sel.dirs) {
    for (const f of ['capture.json', 'page.html.gz']) {
      const abs = path.join(lib.root, d, f);
      if (fs.existsSync(abs)) files.push({ name: `${d}/${f}`, abs, store: f.endsWith('.gz') });
    }
  }
  for (const c of sel.covers) {
    const abs = path.join(lib.root, c);
    if (COVER_FILE.test(c) && fs.existsSync(abs)) files.push({ name: c, abs, store: true });
  }
  const subredditFiles: { name: string; abs: string }[] = [];
  for (const sub of sel.subreddits) {
    const d = path.join(lib.root, 'community', sub);
    if (!/^[A-Za-z0-9_]{2,21}$/.test(sub) || !fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter((x) => /^[A-Za-z0-9._-]+\.jsonl$/.test(x)).sort()) subredditFiles.push({ name: `community/${sub}/${f}`, abs: path.join(d, f) });
  }
  const keywords = keywordsFor(lib, keys, sel.seedCats);
  manifest.extra = { subreddits: sel.subreddits, communityFiles: subredditFiles.length, keywordSeeds: new Set([...keywords.history.map((r) => r.seed), ...keywords.lookups.map((r) => r.seed)]).size, trends: keywords.trends.length, exclusions: sel.exclusions.length };
  manifest.counts.files = files.length + subredditFiles.length;

  const fd = fs.openSync(dest, 'wx');
  try {
    let failure: Error | null = null;
    const zip = new Zip((err, chunk) => {
      if (err) failure = err;
      else fs.writeSync(fd, chunk);
    });
    const add = (name: string, data: Uint8Array, store: boolean) => {
      const entry = store ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 6 });
      zip.add(entry);
      entry.push(data, true);
    };
    add('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)), false);
    add(META_KEYWORDS, Buffer.from(JSON.stringify(keywords)), false);
    add(META_SOURCES, Buffer.from(JSON.stringify({ sources: sel.sources } satisfies SourcesFile)), false);
    add(META_EXCLUSIONS, Buffer.from(JSON.stringify({ exclusions: sel.exclusions } satisfies ExclusionsFile)), false);
    const all = [...files.map((f) => ({ ...f })), ...subredditFiles.map((f) => ({ ...f, store: false }))];
    for (let i = 0; i < all.length; i++) {
      add(all[i]!.name, fs.readFileSync(all[i]!.abs), all[i]!.store);
      if (i % 50 === 0) {
        opts.onProgress?.({ done: i, total: all.length });
        await tick();
      }
      if (failure) throw failure;
    }
    zip.end();
    if (failure) throw failure;
    opts.onProgress?.({ done: all.length, total: all.length });
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(dest, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  return manifest;
}

function parseManifest(bytes: Uint8Array | undefined): PackManifest {
  let m: Partial<PackManifest>;
  try { m = JSON.parse(Buffer.from(bytes ?? []).toString('utf8')) as Partial<PackManifest>; } catch { m = {}; }
  if (m.format !== PACK_FORMAT) throw new Error('this is not a BookScout data pack');
  if (typeof m.version !== 'number' || m.version > PACK_VERSION) throw new Error('this data pack was made by a newer BookScout; update the app to import it');
  if (typeof m.id !== 'string' || !m.id) throw new Error('this data pack has no id');
  return m as PackManifest;
}

/** Read only the manifest of a pack (what it holds, and its id), without unpacking anything else. */
export function readPackManifest(file: string): PackManifest {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(fs.readFileSync(file), { filter: (f) => f.name === 'manifest.json' }); } catch { throw new Error('this is not a BookScout data pack'); }
  return parseManifest(files['manifest.json']);
}

export interface ImportResult {
  manifest: PackManifest;
  /** Pages added to the library. */
  added: { books: number; lists: number; searches: number; covers: number };
  /** Pages the library already had. */
  alreadyHad: number;
  /** Entries that were damaged or not recognised, and so left out. */
  skipped: number;
  /** Community text and keyword research added (version 2 packs). */
  extra: { subreddits: number; posts: number; comments: number; keywordSeeds: number; trends: number; exclusions: number };
}

/**
 * Add the contents of a pack to the library. Existing captures are kept as they are, so importing the same pack twice, or two overlapping
 * packs, changes nothing the second time. Each page goes through the normal capture path, which parses and indexes it.
 */
export async function importPack(lib: Library, file: string, onProgress?: (p: PackProgress) => void): Promise<ImportResult> {
  const buf = fs.readFileSync(file);
  const manifest = readPackManifest(file);

  // names and sizes only (the filter rejects every entry), then the work in batches so memory holds a few hundred files at a time
  const names: string[] = [];
  try { unzipSync(buf, { filter: (f) => (names.push(f.name), false) }); } catch { throw new Error('the data pack is damaged'); }
  const groups = new Map<string, string[]>();
  const coverNames: string[] = [];
  const communityNames: string[] = [];
  let skipped = 0;
  for (const n of names) {
    if (n === 'manifest.json' || n === META_KEYWORDS || n === META_SOURCES || n === META_EXCLUSIONS) continue;
    if (COMMUNITY_FILE.test(n)) { communityNames.push(n); continue; }
    const cm = COVER_FILE.exec(n);
    if (cm) { coverNames.push(n); continue; }
    const dir = n.slice(0, n.lastIndexOf('/'));
    const leaf = n.slice(n.lastIndexOf('/') + 1);
    if ((leaf === 'capture.json' || leaf === 'page.html.gz') && CAPTURE_DIR.test(dir)) groups.set(dir, [...(groups.get(dir) ?? []), n]);
    else skipped++;
  }

  const result: ImportResult = { manifest, added: { books: 0, lists: 0, searches: 0, covers: 0 }, alreadyHad: 0, skipped, extra: { subreddits: 0, posts: 0, comments: 0, keywordSeeds: 0, trends: 0, exclusions: 0 } };
  const dirs = [...groups.keys()].sort();
  const total = dirs.length + coverNames.length + communityNames.length + 1;
  let done = 0;
  const BATCH = 200;

  for (let i = 0; i < dirs.length; i += BATCH) {
    const batch = dirs.slice(i, i + BATCH);
    const want = new Set(batch.flatMap((d) => groups.get(d)!));
    const data = unzipSync(buf, { filter: (f) => want.has(f.name) && f.originalSize <= MAX_PAGE_BYTES });
    for (const d of batch) {
      done++;
      if (fs.existsSync(path.join(lib.root, d, 'page.html.gz'))) { result.alreadyHad++; continue; }
      try {
        const cap = JSON.parse(Buffer.from(data[`${d}/capture.json`] ?? []).toString('utf8')) as { kind?: unknown; url?: unknown; capturedAt?: unknown };
        const page = data[`${d}/page.html.gz`];
        if (!page || (cap.kind !== 'detail' && cap.kind !== 'list' && cap.kind !== 'search') || typeof cap.url !== 'string' || typeof cap.capturedAt !== 'string') throw new Error('incomplete');
        const html = zlib.gunzipSync(page, { maxOutputLength: MAX_PAGE_BYTES }).toString('utf8');
        lib.ingest({ kind: cap.kind, url: cap.url, html, capturedAt: cap.capturedAt });
        if (cap.kind === 'detail') result.added.books++;
        else if (cap.kind === 'list') result.added.lists++;
        else result.added.searches++;
      } catch {
        result.skipped++;
      }
      if (done % 10 === 0) { onProgress?.({ done, total }); await tick(); }
    }
  }

  // covers last: they belong to books the pages above just created
  for (let i = 0; i < coverNames.length; i += BATCH) {
    const batch = coverNames.slice(i, i + BATCH);
    const want = new Set(batch);
    const data = unzipSync(buf, { filter: (f) => want.has(f.name) && f.originalSize <= MAX_COVER_BYTES });
    for (const n of batch) {
      done++;
      const m = COVER_FILE.exec(n)!;
      const bytes = data[n];
      if (!bytes || !isAsin(m[1]!)) { result.skipped++; continue; }
      const target = path.join(lib.root, n);
      if (fs.existsSync(target)) { result.alreadyHad++; continue; }
      lib.saveAsset(m[1]!, 'cover', Buffer.from(bytes), m[2]!);
      result.added.covers++;
    }
    onProgress?.({ done, total });
    await tick();
  }

  const metaFiles = unzipSync(buf, { filter: (f) => (f.name === META_KEYWORDS || f.name === META_SOURCES || f.name === META_EXCLUSIONS) && f.originalSize <= MAX_PAGE_BYTES });
  const json = <T>(name: string): T | null => {
    try { return metaFiles[name] ? (JSON.parse(Buffer.from(metaFiles[name]!).toString('utf8')) as T) : null; } catch { result.skipped++; return null; }
  };

  // subreddit text: files are copied in (kept if already there), then the new ones are read into the database
  const newFiles = new Map<string, string[]>();
  for (let i = 0; i < communityNames.length; i += BATCH) {
    const batch = communityNames.slice(i, i + BATCH);
    const want = new Set(batch);
    const data = unzipSync(buf, { filter: (f) => want.has(f.name) && f.originalSize <= MAX_COMMUNITY_BYTES });
    for (const n of batch) {
      done++;
      const [, sub, leaf] = COMMUNITY_FILE.exec(n)!;
      const bytes = data[n];
      if (!bytes) { result.skipped++; continue; }
      const target = path.join(lib.root, 'community', sub!, leaf!);
      if (fs.existsSync(target)) { result.alreadyHad++; continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
      newFiles.set(sub!, [...(newFiles.get(sub!) ?? []), target]);
    }
    onProgress?.({ done, total });
    await tick();
  }
  for (const [sub, targets] of newFiles) {
    const lines: Parameters<typeof applyCommunity>[1] = [];
    for (const t of targets.sort()) {
      for (const raw of fs.readFileSync(t, 'utf8').split('\n')) {
        if (!raw.trim()) continue;
        try { lines.push(JSON.parse(raw)); } catch { /* a damaged line */ }
      }
    }
    // posts first so a comment's chunk can carry its thread's title; the subreddit name in a line must be the folder's
    const own = lines.filter((l) => !('subreddit' in l) || l.subreddit === sub);
    own.sort((a, b) => Number(b.kind === 'post') - Number(a.kind === 'post'));
    const r = applyCommunity(lib.db, own);
    result.extra.posts += r.addedPosts;
    result.extra.comments += r.addedComments;
    result.extra.subreddits++;
    if (own.length !== lines.length) result.skipped += lines.length - own.length;
  }
  const sources = json<SourcesFile>(META_SOURCES)?.sources ?? [];
  if (sources.length) {
    const put = lib.db.prepare(
      `INSERT INTO community_source (category_key, subreddit, added_at, last_synced_at) VALUES (?,?,?,?)
       ON CONFLICT(category_key, subreddit) DO UPDATE SET last_synced_at = max(coalesce(community_source.last_synced_at, ''), coalesce(excluded.last_synced_at, '')) WHERE excluded.last_synced_at IS NOT NULL`,
    );
    for (const s of sources) {
      try { put.run(String(s.categoryKey), cleanSubreddit(s.subreddit), String(s.addedAt), s.lastSyncedAt ? String(s.lastSyncedAt) : null); } catch { result.skipped++; }
    }
    writeSources(lib.db, lib.root);
  }

  // keyword research: an answer already in the library is kept unless the pack's is newer
  const kw = json<KeywordsFile>(META_KEYWORDS);
  if (kw) {
    const db = lib.db;
    const seeds = new Set<string>();
    db.transaction(() => {
      const has = db.prepare('SELECT fetched_at AS at FROM keyword_lookup WHERE source = ? AND seed = ?');
      const putLookup = db.prepare('INSERT INTO keyword_lookup (source, seed, fetched_at, requests, stopped) VALUES (?,?,?,?,?) ON CONFLICT(source, seed) DO UPDATE SET fetched_at = excluded.fetched_at, requests = excluded.requests, stopped = excluded.stopped');
      const dropSignals = db.prepare('DELETE FROM keyword_signal WHERE source = ? AND seed = ?');
      const putSignal = db.prepare('INSERT OR IGNORE INTO keyword_signal (source, seed, keyword, position, via) VALUES (?,?,?,?,?)');
      const replaced = new Set<string>();
      for (const l of kw.lookups ?? []) {
        const old = has.get(l.source, l.seed) as { at: string } | undefined;
        if (old && old.at >= l.fetched_at) continue;
        putLookup.run(l.source, l.seed, l.fetched_at, l.requests, l.stopped);
        dropSignals.run(l.source, l.seed);
        replaced.add(`${l.source}\n${l.seed}`);
        seeds.add(l.seed);
      }
      for (const g of kw.signals ?? []) if (replaced.has(`${g.source}\n${g.seed}`)) putSignal.run(g.source, g.seed, g.keyword, g.position, g.via);
      const putHist = db.prepare('INSERT OR IGNORE INTO keyword_history (seed, first_at, last_at, searches, phrases, sources) VALUES (?,?,?,?,?,?)');
      for (const h of kw.history ?? []) { putHist.run(h.seed, h.first_at, h.last_at, h.searches, h.phrases, h.sources); seeds.add(h.seed); }
      const putTrend = db.prepare('INSERT OR IGNORE INTO keyword_trend (keyword, unit, geo, points, imported_at) VALUES (?,?,?,?,?)');
      for (const t of kw.trends ?? []) result.extra.trends += Number(putTrend.run(t.keyword, t.unit, t.geo, t.points, t.imported_at).changes);
      const putLink = db.prepare('INSERT OR IGNORE INTO keyword_category (keyword, category_key, linked_at) VALUES (?,?,?)');
      for (const l of kw.links ?? []) { putLink.run(String(l.keyword), String(l.category_key), String(l.linked_at)); seeds.add(String(l.keyword)); }
    })();
    result.extra.keywordSeeds = seeds.size;
  }

  // books taken out of a category by hand: applied last, so they leave the lists that were just read
  const ex = json<ExclusionsFile>(META_EXCLUSIONS)?.exclusions ?? [];
  for (const x of ex) {
    try {
      if (!lib.db.scalar('SELECT 1 FROM category_exclusion WHERE category_key = ? AND asin = ?', x.categoryKey, x.asin)) result.extra.exclusions++;
      lib.excludeFromCategory(x.asin, x.categoryKey);
    } catch { result.skipped++; }
  }
  done++;
  onProgress?.({ done: total, total });
  return result;
}
