import type { Db } from './schema.js';
import { authorNamesOf } from './authors.js';

/** SQL for a category's name as the user sees it: their own name for it if they gave one, else Amazon's. `alias` is the category table's alias. */
export const categoryNameSql = (alias: string) => `COALESCE((SELECT r.name FROM category_rename r WHERE r.category_key = ${alias}.key), ${alias}.name)`;

export interface CategorySummary {
  key: string;
  /** The name shown: the user's own if they renamed it, else Amazon's. */
  name: string | null;
  /** True when `name` is the user's own (see renameCategory). */
  renamed: boolean;
  store: string;
  nodeId: string;
  listCaptures: number;
  lastListCapture: string | null;
  /** Books in the newest capture of each list of this category. */
  listedBooks: number;
  /** Of those, how many have a detail capture. */
  capturedBooks: number;
}

export interface BookRow {
  asin: string;
  title: string | null;
  authors: string | null;
  /** The people credited as authors (not editors, illustrators and so on), in order; a collaboration has several. */
  authorNames: string[];
  ratingValue: number | null;
  ratingCount: number | null;
  kindlePrice: number | null;
  lastSeen: string;
  snapshots: number;
  /** Rank in the Kindle Store overall list, from the newest snapshot. */
  overallRank: number | null;
  /** Rank on the most recently captured list that includes the book (within the chosen category if one is). Different books can share a rank: lists are independent. */
  listRank: number | null;
  /** Name of that list's category. */
  listCategory: string | null;
  /** Which text the library holds for the book: a whole manuscript, only the free sample, or none. */
  text: 'manuscript' | 'sample' | null;
  /** 1 when the book is in My Books. */
  own: number;
}

export interface QueueItem {
  asin: string;
  rank: number;
  categoryKey: string;
  categoryName: string | null;
  title: string | null;
  author: string | null;
  price: number | null;
  state: 'pending' | 'opened' | 'skipped';
}

/** Queue bucket for books known only from search results. */
export const UNCATEGORISED = 'uncategorised';

export const amazonUrl = (asin: string) => `https://www.amazon.com/dp/${asin}`;

/**
 * The Best Sellers page of a category, as Amazon links it from a book page ("/gp/bestsellers/digital-text/12527147011/ref=..."): the
 * store's address segment and the browse node id, without the tracking that follows them. A store Cadrel Market does not know has no such
 * segment, so its browse-node page is used instead.
 */
export function bestsellersUrl(category: { marketplace?: string | null; store: string; nodeId: string }): string {
  const site = `https://www.${category.marketplace || 'amazon.com'}`;
  if (!/^\d+$/.test(category.nodeId)) throw new Error('bad category node id');
  const slug = category.store === 'kindle' ? 'digital-text' : category.store === 'books' ? 'books' : null;
  return slug ? `${site}/gp/bestsellers/${slug}/${category.nodeId}` : `${site}/b?node=${category.nodeId}`;
}

/** The Best Sellers page of a known category (by key), or null. */
export function categoryUrl(db: Db, key: string): string | null {
  const c = db.prepare('SELECT marketplace, store, node_id AS nodeId FROM category WHERE key = ?').get(key) as { marketplace: string; store: string; nodeId: string } | undefined;
  return c ? bestsellersUrl(c) : null;
}

/** Newest capture of each (category, list kind, page): the "current" view of a list. */
const LATEST_LISTS = `
  SELECT lc.* FROM list_capture lc
  WHERE lc.captured_at = (
    SELECT max(captured_at) FROM list_capture x
    WHERE x.category_key = lc.category_key AND x.list_kind = lc.list_kind AND x.page = lc.page)`;

export function listCategories(db: Db): CategorySummary[] {
  return db
    .prepare(
      `SELECT c.key, ${categoryNameSql('c')} AS name, EXISTS (SELECT 1 FROM category_rename r WHERE r.category_key = c.key) AS renamed, c.store, c.node_id AS nodeId,
         (SELECT count(*) FROM list_capture WHERE category_key = c.key) AS listCaptures,
         (SELECT max(captured_at) FROM list_capture WHERE category_key = c.key) AS lastListCapture,
         (SELECT count(DISTINCT e.asin) FROM list_entry e JOIN (${LATEST_LISTS}) l ON l.id = e.list_capture_id
            WHERE l.category_key = c.key) AS listedBooks,
         (SELECT count(DISTINCT e.asin) FROM list_entry e JOIN (${LATEST_LISTS}) l ON l.id = e.list_capture_id
            WHERE l.category_key = c.key AND e.asin IN (SELECT asin FROM snapshot)) AS capturedBooks
       FROM category c
       WHERE EXISTS (SELECT 1 FROM list_capture WHERE category_key = c.key)
       ORDER BY name`,
    )
    .all()
    .map((r: any) => ({ ...r, renamed: !!r.renamed })) as unknown as CategorySummary[];
}

export function listBooks(db: Db, opts: { categoryKey?: string; search?: string } = {}): BookRow[] {
  // every statement parameter is always bound (?1 category, ?2 like pattern, ?3 ASIN), so the SQL needs no building
  const like = opts.search ? `%${opts.search.replace(/[\\%_]/g, '\\$&')}%` : null;
  const where = [
    `(?1 IS NULL OR b.asin IN (SELECT e.asin FROM list_entry e JOIN (${LATEST_LISTS}) l ON l.id = e.list_capture_id WHERE l.category_key = ?1))`,
    `(?2 IS NULL OR s.title LIKE ?2 ESCAPE '\\' OR s.authors LIKE ?2 ESCAPE '\\' OR b.asin = ?3)`,
  ];
  return db
    .prepare(
      `SELECT b.asin, s.title, s.authors, s.rating_value AS ratingValue, s.rating_count AS ratingCount,
         s.kindle_price AS kindlePrice, b.last_seen AS lastSeen,
         (SELECT count(*) FROM snapshot WHERE asin = b.asin) AS snapshots,
         (SELECT r.rank FROM rank_entry r WHERE r.snapshot_id = s.id AND r.scope = 'overall' AND r.store = 'kindle') AS overallRank,
         (SELECT e.rank FROM list_entry e JOIN list_capture l ON l.id = e.list_capture_id
            WHERE e.asin = b.asin AND (?1 IS NULL OR l.category_key = ?1) ORDER BY l.captured_at DESC, e.rank LIMIT 1) AS listRank,
         (SELECT ${categoryNameSql('c')} FROM list_entry e JOIN list_capture l ON l.id = e.list_capture_id JOIN category c ON c.key = l.category_key
            WHERE e.asin = b.asin AND (?1 IS NULL OR l.category_key = ?1) ORDER BY l.captured_at DESC, e.rank LIMIT 1) AS listCategory,
         (SELECT CASE WHEN count(CASE source WHEN 'upload' THEN 1 END) > 0 THEN 'manuscript' WHEN count(*) > 0 THEN 'sample' END FROM manuscript WHERE asin = b.asin) AS text,
         EXISTS (SELECT 1 FROM own_book WHERE asin = b.asin) AS own
       FROM book b JOIN snapshot s ON s.asin = b.asin AND s.captured_at = b.last_seen
       WHERE ${where.join(' AND ')}
       ORDER BY (overallRank IS NULL), overallRank, s.title`,
    )
    .all(opts.categoryKey ?? null, like, opts.search ? opts.search.toUpperCase() : null)
    .map((r: any) => ({ ...r, authorNames: authorNamesOf(r.authors) })) as unknown as BookRow[];
}

export interface BookDetail {
  asin: string;
  url: string;
  /** The people credited as authors on the newest capture. */
  authorNames: string[];
  latest: Record<string, unknown>;
  formats: Record<string, unknown>[];
  ranks: Record<string, unknown>[];
  /** Oldest first: one point per capture, for the history charts. */
  history: { capturedAt: string; ratingValue: number | null; ratingCount: number | null; kindlePrice: number | null; overallRank: number | null }[];
  covers: { sha256: string; path: string }[];
  issues: { field: string; severity: string; detail: string | null }[];
  rawDir: string;
}

export function getBook(db: Db, asin: string): BookDetail | null {
  const latest = db.prepare('SELECT * FROM snapshot WHERE asin = ? ORDER BY captured_at DESC LIMIT 1').get(asin) as
    | (Record<string, unknown> & { id: number; dir: string })
    | undefined;
  if (!latest) return null;
  return {
    asin,
    url: amazonUrl(asin),
    authorNames: authorNamesOf(latest.authors as string | null),
    latest,
    formats: db.prepare('SELECT code, label, price, note FROM format_offer WHERE snapshot_id = ?').all(latest.id) as Record<string, unknown>[],
    ranks: db.prepare('SELECT category_key AS categoryKey, store, scope, name, rank FROM rank_entry WHERE snapshot_id = ? ORDER BY scope DESC, rank').all(latest.id) as Record<string, unknown>[],
    history: db
      .prepare(
        `SELECT s.captured_at AS capturedAt, s.rating_value AS ratingValue, s.rating_count AS ratingCount, s.kindle_price AS kindlePrice,
           (SELECT r.rank FROM rank_entry r WHERE r.snapshot_id = s.id AND r.scope = 'overall' AND r.store = 'kindle') AS overallRank
         FROM snapshot s WHERE s.asin = ? ORDER BY s.captured_at`,
      )
      .all(asin) as BookDetail['history'],
    covers: db.prepare("SELECT sha256, path FROM asset WHERE asin = ? AND kind = 'cover' ORDER BY captured_at").all(asin) as BookDetail['covers'],
    issues: db
      .prepare("SELECT field, severity, detail FROM parse_issue WHERE source_kind = 'snapshot' AND source_id = ?")
      .all(latest.id) as BookDetail['issues'],
    rawDir: latest.dir,
  };
}

export function listIssues(db: Db): { source: string; ref: string; field: string; severity: string; detail: string | null }[] {
  return db
    .prepare(
      `SELECT 'snapshot' AS source, s.asin || ' @ ' || s.captured_at AS ref, i.field, i.severity, i.detail
         FROM parse_issue i JOIN snapshot s ON s.id = i.source_id WHERE i.source_kind = 'snapshot'
       UNION ALL
       SELECT 'list', l.category_key || ' ' || l.list_kind || ' p' || l.page || ' @ ' || l.captured_at, i.field, i.severity, i.detail
         FROM parse_issue i JOIN list_capture l ON l.id = i.source_id WHERE i.source_kind = 'list_capture'
       UNION ALL
       SELECT 'search', c.query || ' @ ' || c.captured_at, i.field, i.severity, i.detail
         FROM parse_issue i JOIN search_capture c ON c.id = i.source_id WHERE i.source_kind = 'search_capture'
       ORDER BY 2`,
    )
    .all() as ReturnType<typeof listIssues>;
}

/**
 * Books seen on the newest capture of a list that have no detail capture yet, best rank first.
 * A book on several lists appears once, at its best rank.
 */
export function queue(db: Db, opts: { categoryKey?: string; includeSkipped?: boolean } = {}): QueueItem[] {
  const fromLists = opts.categoryKey === UNCATEGORISED ? [] : (db
    .prepare(
      `SELECT e.asin, min(e.rank) AS rank, l.category_key AS categoryKey, ${categoryNameSql('c')} AS categoryName,
         max(e.title) AS title, max(e.author) AS author, max(e.price) AS price, q.state AS qstate
       FROM list_entry e
       JOIN (${LATEST_LISTS}) l ON l.id = e.list_capture_id
       JOIN category c ON c.key = l.category_key
       LEFT JOIN queue_item q ON q.asin = e.asin
       WHERE e.asin NOT IN (SELECT asin FROM snapshot)
         ${opts.categoryKey ? 'AND l.category_key = ?' : ''}
       GROUP BY e.asin
       ORDER BY rank, e.asin`,
    )
    .all(...(opts.categoryKey ? [opts.categoryKey] : [])) as (Omit<QueueItem, 'state'> & { qstate: string | null })[]);
  // Books seen only on a search page have no category yet (a search does not say); a book on a captured list stays under that
  // list's category, and its detail capture, which carries the book's categories, takes it out of the queue.
  const fromSearches = opts.categoryKey && opts.categoryKey !== UNCATEGORISED ? [] : (db
    .prepare(
      `SELECT e.asin, min(e.position) AS rank, '${UNCATEGORISED}' AS categoryKey, 'Uncategorised' AS categoryName,
         max(e.title) AS title, max(e.author) AS author, max(e.price) AS price, q.state AS qstate
       FROM search_entry e
       LEFT JOIN queue_item q ON q.asin = e.asin
       WHERE e.sponsored = 0
         AND e.asin NOT IN (SELECT asin FROM snapshot)
         AND e.asin NOT IN (SELECT le.asin FROM list_entry le JOIN (${LATEST_LISTS}) l ON l.id = le.list_capture_id)
       GROUP BY e.asin
       ORDER BY rank, e.asin`,
    )
    .all() as (Omit<QueueItem, 'state'> & { qstate: string | null })[]);
  return [...fromLists, ...fromSearches]
    .map(({ qstate, ...r }) => ({ ...r, state: (qstate ?? 'pending') as QueueItem['state'] }))
    .filter((r) => opts.includeSkipped || r.state !== 'skipped');
}

/** First pending item (opened ones wait for their capture; skipped ones are out). */
export function nextInQueue(db: Db, categoryKey?: string): QueueItem | null {
  return queue(db, { categoryKey }).find((q) => q.state === 'pending') ?? null;
}

export function setQueueState(db: Db, asin: string, state: 'opened' | 'skipped' | 'pending', now = new Date().toISOString()): void {
  if (state === 'pending') db.prepare('DELETE FROM queue_item WHERE asin = ?').run(asin);
  else
    db.prepare(
      `INSERT INTO queue_item (asin, state, updated_at) VALUES (?,?,?)
       ON CONFLICT(asin) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
    ).run(asin, state, now);
}

/** Pick the next pending book, mark it opened, and return it (the caller opens its URL). */
export function openNext(db: Db, categoryKey?: string): (QueueItem & { url: string }) | null {
  const item = nextInQueue(db, categoryKey);
  if (!item) return null;
  setQueueState(db, item.asin, 'opened');
  return { ...item, state: 'opened', url: amazonUrl(item.asin) };
}
