import { createRequire } from 'node:module';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

// Loaded with require because Vite-based tooling (vitest) does not yet recognise 'node:sqlite' as a built-in.
const { DatabaseSync: Sqlite } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/**
 * Thin wrapper over node:sqlite. It ships inside both Node and Electron, so there is no native module to rebuild
 * for each Electron version or on the user's machine.
 */
export class Db {
  private depth = 0;
  private readonly raw: DatabaseSync;

  /** True once the sqlite-vec extension is loaded (vector search available). */
  vecEnabled = false;

  constructor(file: string) {
    this.raw = new Sqlite(file, { allowExtension: true });
  }

  /** Load sqlite-vec. Returns false (and leaves vector search off) if the extension cannot be loaded here. */
  loadVec(): boolean {
    try {
      const { getLoadablePath } = createRequire(import.meta.url)('sqlite-vec') as { getLoadablePath(): string };
      // inside an installed app the module resolves into app.asar, but a native library must be loaded from the unpacked copy
      this.raw.loadExtension(getLoadablePath().replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'));
      this.vecEnabled = true;
    } catch {
      this.vecEnabled = false;
    }
    return this.vecEnabled;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  prepare(sql: string): StatementSync {
    return this.raw.prepare(sql);
  }

  /** First column of the first row, or undefined. */
  scalar<T = unknown>(sql: string, ...args: any[]): T | undefined {
    const row = this.raw.prepare(sql).get(...args) as Record<string, T> | undefined;
    return row ? Object.values(row)[0] : undefined;
  }

  /** Open a transaction that stays open across calls (and awaits); nested transaction() calls join it. */
  begin(): void {
    this.raw.exec('BEGIN');
    this.depth++;
  }

  commit(): void {
    this.raw.exec('COMMIT');
    this.depth--;
  }

  rollback(): void {
    this.raw.exec('ROLLBACK');
    this.depth--;
  }

  /** Wrap fn in a transaction; nested calls join the outer one. */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A) => {
      if (this.depth > 0) return fn(...args);
      this.raw.exec('BEGIN');
      this.depth++;
      try {
        const r = fn(...args);
        this.raw.exec('COMMIT');
        return r;
      } catch (e) {
        this.raw.exec('ROLLBACK');
        throw e;
      } finally {
        this.depth--;
      }
    };
  }

  close(): void {
    this.raw.close();
  }
}

/** Each entry upgrades the schema by one version. Never edit a shipped entry; append. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE book (
    asin TEXT PRIMARY KEY,
    marketplace TEXT NOT NULL,
    title TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
  );
  CREATE TABLE snapshot (
    id INTEGER PRIMARY KEY,
    asin TEXT NOT NULL REFERENCES book(asin),
    captured_at TEXT NOT NULL,
    dir TEXT NOT NULL,
    url TEXT,
    title TEXT,
    authors TEXT,
    series_name TEXT,
    series_position REAL,
    series_total INTEGER,
    rating_value REAL,
    rating_count INTEGER,
    histogram TEXT,
    kindle_price REAL,
    pages INTEGER,
    publication_date TEXT,
    publisher TEXT,
    language TEXT,
    isbn13 TEXT,
    file_size_mb REAL,
    description TEXT,
    has_read_sample INTEGER NOT NULL DEFAULT 0,
    UNIQUE (asin, captured_at)
  );
  CREATE TABLE format_offer (
    snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    label TEXT,
    price REAL,
    note TEXT
  );
  CREATE TABLE category (
    key TEXT PRIMARY KEY,
    marketplace TEXT NOT NULL,
    store TEXT NOT NULL,
    node_id TEXT NOT NULL,
    name TEXT,
    path TEXT
  );
  CREATE TABLE rank_entry (
    snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
    category_key TEXT,
    store TEXT NOT NULL,
    scope TEXT NOT NULL,
    name TEXT,
    rank INTEGER NOT NULL
  );
  CREATE TABLE list_capture (
    id INTEGER PRIMARY KEY,
    category_key TEXT NOT NULL REFERENCES category(key),
    list_kind TEXT NOT NULL,
    page INTEGER NOT NULL,
    captured_at TEXT NOT NULL,
    dir TEXT NOT NULL,
    url TEXT,
    listed_count INTEGER NOT NULL,
    rendered_count INTEGER NOT NULL,
    UNIQUE (category_key, list_kind, page, captured_at)
  );
  CREATE TABLE list_entry (
    list_capture_id INTEGER NOT NULL REFERENCES list_capture(id) ON DELETE CASCADE,
    rank INTEGER NOT NULL,
    asin TEXT NOT NULL,
    rendered INTEGER NOT NULL,
    title TEXT,
    author TEXT,
    author_id TEXT,
    rating_value REAL,
    rating_count INTEGER,
    format TEXT,
    price REAL,
    price_layout TEXT,
    formats_available INTEGER,
    cover_url TEXT
  );
  CREATE TABLE asset (
    sha256 TEXT PRIMARY KEY,
    asin TEXT NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    captured_at TEXT NOT NULL
  );
  CREATE TABLE parse_issue (
    id INTEGER PRIMARY KEY,
    source_kind TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    field TEXT NOT NULL,
    severity TEXT NOT NULL,
    detail TEXT
  );
  CREATE INDEX idx_snapshot_asin ON snapshot(asin, captured_at);
  CREATE INDEX idx_rank_snapshot ON rank_entry(snapshot_id);
  CREATE INDEX idx_rank_cat ON rank_entry(category_key);
  CREATE INDEX idx_entry_asin ON list_entry(asin);
  CREATE INDEX idx_entry_list ON list_entry(list_capture_id);
  `,
  // Queue state the user sets by hand. "Captured" is never stored: it is derived from the existence of a snapshot.
  `
  CREATE TABLE queue_item (
    asin TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('opened','skipped')),
    updated_at TEXT NOT NULL
  );
  `,
  // Text for retrieval. text_block is derived from pages; chunk is derived from text_block; embedding is a cache keyed by text.
  `
  CREATE TABLE text_block (
    snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    ordinal INTEGER NOT NULL DEFAULT 0,
    body TEXT NOT NULL,
    meta TEXT,
    PRIMARY KEY (snapshot_id, kind, ordinal)
  );
  CREATE TABLE chunk (
    id INTEGER PRIMARY KEY,
    asin TEXT NOT NULL,
    snapshot_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    text TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    meta TEXT
  );
  CREATE INDEX idx_chunk_asin ON chunk(asin);
  CREATE INDEX idx_chunk_hash ON chunk(text_hash);
  CREATE VIRTUAL TABLE chunk_fts USING fts5(text, content='chunk', content_rowid='id', tokenize='porter unicode61');
  CREATE TRIGGER chunk_ai AFTER INSERT ON chunk BEGIN
    INSERT INTO chunk_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER chunk_ad AFTER DELETE ON chunk BEGIN
    INSERT INTO chunk_fts(chunk_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TABLE embedding (
    text_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vec BLOB NOT NULL,
    PRIMARY KEY (text_hash, model)
  );
  `,
  // User-authored. Also mirrored to <library>/user/annotations.json so it survives losing the database.
  `
  CREATE TABLE annotation (
    id INTEGER PRIMARY KEY,
    asin TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('tag','note')),
    value TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (asin, kind, value)
  );
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // Derived from cover files; safe to recompute.
  `
  CREATE TABLE cover_metrics (
    sha256 TEXT PRIMARY KEY,
    asin TEXT NOT NULL,
    metrics TEXT NOT NULL,
    analyzed_at TEXT NOT NULL
  );
  `,
  // Text of a whole book (user upload) or of the free sample (OCR of page screenshots). Rows index files under books/<ASIN>/.
  `
  CREATE TABLE manuscript (
    id INTEGER PRIMARY KEY,
    asin TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('upload','sample')),
    kind TEXT NOT NULL,
    label TEXT,
    chars INTEGER NOT NULL,
    words INTEGER NOT NULL,
    pages INTEGER,
    chapters INTEGER NOT NULL,
    quality REAL,
    complete INTEGER NOT NULL DEFAULT 1,
    warnings TEXT,
    metrics TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (asin, source)
  );
  `,
  // What people say in subreddits linked to a category: only thread title, body, comment text, scores, flair and dates (no authors).
  // community_item is an index over the files under <library>/community/, which are the source of truth; chunk.ref links derived chunks to items.
  `
  CREATE TABLE community_source (
    category_key TEXT NOT NULL,
    subreddit TEXT NOT NULL,
    added_at TEXT NOT NULL,
    last_synced_at TEXT,
    PRIMARY KEY (category_key, subreddit)
  );
  CREATE TABLE community_item (
    kind TEXT NOT NULL CHECK (kind IN ('post','comment')),
    id TEXT NOT NULL,
    subreddit TEXT NOT NULL,
    link_id TEXT NOT NULL,
    parent_id TEXT,
    title TEXT,
    body TEXT NOT NULL,
    score INTEGER,
    flair TEXT,
    created_utc INTEGER NOT NULL,
    PRIMARY KEY (kind, id)
  );
  CREATE INDEX idx_community_sub ON community_item(subreddit, created_utc);
  CREATE INDEX idx_community_link ON community_item(link_id);
  ALTER TABLE chunk ADD COLUMN ref TEXT;
  CREATE INDEX idx_chunk_ref ON chunk(ref);
  `,
  // Keyword research. keyword_lookup/keyword_signal cache autocomplete answers per source (a cache: safe to delete);
  // keyword_trend holds Google Trends exports the user imported; search_capture/search_entry index Amazon search-result
  // pages the user browsed (the saved page under <library>/searches is the source of truth).
  `
  CREATE TABLE keyword_lookup (
    source TEXT NOT NULL,
    seed TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    requests INTEGER NOT NULL,
    stopped TEXT,
    PRIMARY KEY (source, seed)
  );
  CREATE TABLE keyword_signal (
    source TEXT NOT NULL,
    seed TEXT NOT NULL,
    keyword TEXT NOT NULL,
    position INTEGER NOT NULL,
    via TEXT NOT NULL,
    PRIMARY KEY (source, seed, keyword)
  );
  CREATE INDEX idx_keyword_signal_kw ON keyword_signal(keyword);
  CREATE TABLE keyword_trend (
    keyword TEXT PRIMARY KEY,
    unit TEXT NOT NULL,
    geo TEXT,
    points TEXT NOT NULL,
    imported_at TEXT NOT NULL
  );
  CREATE TABLE search_capture (
    id INTEGER PRIMARY KEY,
    query TEXT NOT NULL,
    marketplace TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    dir TEXT NOT NULL,
    url TEXT,
    result_count INTEGER,
    result_count_min INTEGER NOT NULL DEFAULT 0,
    listed_count INTEGER NOT NULL,
    UNIQUE (query, marketplace, captured_at)
  );
  CREATE TABLE search_entry (
    search_capture_id INTEGER NOT NULL REFERENCES search_capture(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    asin TEXT NOT NULL,
    sponsored INTEGER NOT NULL,
    title TEXT,
    author TEXT,
    rating_value REAL,
    rating_count INTEGER,
    price REAL,
    format TEXT
  );
  CREATE INDEX idx_search_entry_cap ON search_entry(search_capture_id);
  `,
  // The author's own sales (imported from KDP reports) and rank history (imported files), used to calibrate the rank-to-sales
  // curve. The imported files under <library>/sales are the source of truth; these tables are derived from them.
  `
  CREATE TABLE sales_day (
    asin TEXT NOT NULL,
    day TEXT NOT NULL,
    marketplace TEXT NOT NULL,
    paid_units INTEGER NOT NULL,
    free_units INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    PRIMARY KEY (asin, day, marketplace)
  );
  CREATE TABLE rank_point (
    asin TEXT NOT NULL,
    at TEXT NOT NULL,
    rank INTEGER NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY (asin, at, source)
  );
  `,
  // Kindle Unlimited: pages read per day (KDP's KENP Read report) and the user's own page count (KENPC) per book, which turns pages
  // read into estimated borrows. Without a user value the captured print length is used and labelled as a stand-in.
  `
  CREATE TABLE kenp_day (
    asin TEXT NOT NULL,
    day TEXT NOT NULL,
    marketplace TEXT NOT NULL,
    pages INTEGER NOT NULL,
    source TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    PRIMARY KEY (asin, day, marketplace)
  );
  CREATE TABLE book_kenpc (
    asin TEXT PRIMARY KEY,
    kenpc INTEGER NOT NULL
  );
  `,
  // The user's own books ("My Books"): created from imported KDP reports, or flagged by hand. Mirrored to user/user-data.json.
  // Kept apart from `book` (which means "a page of this was captured") so a book can be mine before it has been captured.
  `
  CREATE TABLE own_book (
    asin TEXT PRIMARY KEY,
    title TEXT,
    author TEXT,
    source TEXT NOT NULL CHECK (source IN ('report','manual')),
    added_at TEXT NOT NULL
  );
  `,
  // Keyword searches the user has run, one row per phrase, so a search can be reopened from the saved results instead of retyped.
  `
  CREATE TABLE keyword_history (
    seed TEXT PRIMARY KEY,
    first_at TEXT NOT NULL,
    last_at TEXT NOT NULL,
    searches INTEGER NOT NULL DEFAULT 1,
    phrases INTEGER NOT NULL DEFAULT 0,
    sources TEXT NOT NULL DEFAULT '[]'
  );
  `,
  // Books the user took out of a category's lists (wrong genre). User-authored: kept when the index is rebuilt, mirrored to user/user-data.json.
  `
  CREATE TABLE category_exclusion (
    category_key TEXT NOT NULL,
    asin TEXT NOT NULL,
    title TEXT,
    excluded_at TEXT NOT NULL,
    PRIMARY KEY (category_key, asin)
  );
  `,
  // Which category a keyword was researched for: the category chosen when a phrase was searched or a Google Trends CSV imported.
  // keyword_lookup/keyword_signal stay shared caches by phrase; this says whose research a phrase belongs to, so a category's keyword
  // work can be listed, exported and imported as a unit.
  `
  CREATE TABLE keyword_category (
    keyword TEXT NOT NULL,
    category_key TEXT NOT NULL,
    linked_at TEXT NOT NULL,
    PRIMARY KEY (keyword, category_key)
  );
  CREATE INDEX idx_keyword_category_cat ON keyword_category(category_key);
  `,
  // Money: KDP's monthly royalty sheets (per book, marketplace, royalty type, in the marketplace's currency) and its Summary sheet
  // (whose royalty minus the sheets' royalty is the KENP money of a finalized month). The user's own tables are the FX rates and KENP
  // rates they override, the people who are paid, and each book's royalty split (a split applies from the month it was saved).
  // sales_day is emptied because earlier versions read a monthly "Orders Processed" sheet as one-day totals; it is read again from the
  // saved report files when the library opens.
  `
  DELETE FROM sales_day;
  CREATE TABLE royalty_month (
    asin TEXT NOT NULL,
    month TEXT NOT NULL,
    marketplace TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('ebook','paperback','hardcover')),
    royalty_type TEXT NOT NULL,
    transaction_type TEXT NOT NULL,
    currency TEXT NOT NULL,
    title TEXT,
    units INTEGER NOT NULL,
    refunded INTEGER NOT NULL,
    net_units INTEGER NOT NULL,
    list_price REAL,
    offer_price REAL,
    royalty REAL NOT NULL,
    source TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    PRIMARY KEY (asin, month, marketplace, format, royalty_type, transaction_type, currency)
  );
  CREATE INDEX idx_royalty_month ON royalty_month(month);
  CREATE TABLE kdp_summary (
    month TEXT NOT NULL,
    currency TEXT NOT NULL,
    royalty REAL NOT NULL,
    source TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    PRIMARY KEY (month, currency)
  );
  CREATE TABLE fx_rate (
    month TEXT NOT NULL,
    currency TEXT NOT NULL,
    to_usd REAL NOT NULL,
    PRIMARY KEY (month, currency)
  );
  CREATE TABLE kenp_rate (
    month TEXT NOT NULL,
    currency TEXT NOT NULL,
    rate REAL NOT NULL,
    PRIMARY KEY (month, currency)
  );
  CREATE TABLE person (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    pen_names TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE book_split (
    asin TEXT NOT NULL,
    from_month TEXT NOT NULL,
    person_id INTEGER NOT NULL REFERENCES person(id),
    pct REAL NOT NULL,
    PRIMARY KEY (asin, from_month, person_id)
  );
  `,
  // KDP payment reports: one lump sum per payment, in USD, covering many sales months; its lines are per month and source (Sales,
  // Kindle+ Royalties). The bank-currency conversion (fx_rate, payout_*) is the user's own and may still be pending.
  `
  CREATE TABLE payment (
    number TEXT PRIMARY KEY,
    entity TEXT,
    paid_on TEXT NOT NULL,
    method TEXT,
    period_from TEXT,
    period_to TEXT,
    currency TEXT NOT NULL,
    accrued REAL NOT NULL,
    tax REAL NOT NULL,
    net REAL NOT NULL,
    fx_rate REAL,
    payout_currency TEXT,
    payout_amount REAL,
    status TEXT,
    source TEXT NOT NULL,
    imported_at TEXT NOT NULL
  );
  CREATE TABLE payment_line (
    payment_number TEXT NOT NULL REFERENCES payment(number) ON DELETE CASCADE,
    month TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('sales','kenp')),
    currency TEXT NOT NULL,
    accrued REAL NOT NULL,
    tax REAL NOT NULL,
    net REAL NOT NULL
  );
  CREATE INDEX idx_payment_line ON payment_line(month, source, currency);
  `,
  // Paying the collaborators: a payment is allocated (what each author is owed from it is frozen, so a later change of split does not
  // rewrite it), and what the user has paid out to each author is kept as a ledger. Both are user-authored and mirrored to user-data.json.
  `
  CREATE TABLE payment_allocation (
    payment_number TEXT NOT NULL,
    payee TEXT NOT NULL,
    person_id INTEGER,
    accrued REAL NOT NULL,
    tax REAL NOT NULL,
    owed REAL NOT NULL,
    detail TEXT NOT NULL DEFAULT '[]',
    allocated_at TEXT NOT NULL,
    PRIMARY KEY (payment_number, payee)
  );
  CREATE TABLE payment_allocated (
    payment_number TEXT PRIMARY KEY,
    allocated_at TEXT NOT NULL,
    unmatched_net REAL NOT NULL DEFAULT 0
  );
  CREATE TABLE payout (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payee TEXT NOT NULL,
    person_id INTEGER,
    paid_on TEXT NOT NULL,
    usd REAL NOT NULL,
    period TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL
  );
  `,
  // Keyword suggestions an AI tool sent in through the MCP server (it has read the book's outline and the category and can do better than the
  // built-in rules). Shown beside Cadrel's own suggestions, labelled with who sent them; the user can dismiss any. A newer set from the same tool
  // for the same category replaces its earlier one, except what the user dismissed, which stays dismissed.
  `
  CREATE TABLE keyword_suggestion (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_key TEXT NOT NULL,
    asin TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('keyword','string')),
    keyword TEXT NOT NULL,
    reason TEXT,
    client TEXT NOT NULL,
    created_at TEXT NOT NULL,
    dismissed_at TEXT,
    UNIQUE (category_key, kind, keyword)
  );
  `,
  // The user's own name for a category. The name Amazon gives it is rewritten by every list capture, so a rename is kept apart from it
  // (and from the category row, which a rebuild recreates). User-authored: mirrored to user/user-data.json.
  `
  CREATE TABLE category_rename (
    category_key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    renamed_at TEXT NOT NULL
  );
  `,
];

export function openDb(file: string): Db {
  const db = new Db(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  db.loadVec();
  return db;
}

export function migrate(db: Db): void {
  const current = db.scalar<number>('PRAGMA user_version') ?? 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}

export const SCHEMA_VERSION = MIGRATIONS.length;
