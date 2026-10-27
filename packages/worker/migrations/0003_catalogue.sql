-- Catalogue: the studio's IP, series, books and editions. Every row carries studio_id, who made and last changed it, and when.
-- Names and ISBNs are unique among live rows (archived rows may share them); an ASIN is unique among all editions, so a sales row can
-- never join two books. Changes are also appended to `audit` in the same batch by the code that makes them.

CREATE TABLE ip (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  archived_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE UNIQUE INDEX ip_name ON ip (studio_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE series (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  ip_id TEXT REFERENCES ip(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  archived_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE UNIQUE INDEX series_name ON series (studio_id, lower(name)) WHERE archived_at IS NULL;
CREATE INDEX series_ip ON series (ip_id);

-- A book is one title in the studio's catalogue: standalone (series_id NULL) or at a position in a series. Its formats are its editions.
CREATE TABLE book (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  series_id TEXT REFERENCES series(id),
  position REAL,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  pen_name TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'concept',
  archived_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE UNIQUE INDEX book_position ON book (series_id, position) WHERE archived_at IS NULL AND series_id IS NOT NULL AND position IS NOT NULL;
CREATE UNIQUE INDEX book_title_in_series ON book (studio_id, ifnull(series_id, ''), lower(title)) WHERE archived_at IS NULL;
CREATE INDEX book_series ON book (series_id);

-- One format of a book. `asin` is the join to Market and Finance (their own_book / sales rows are keyed by it).
CREATE TABLE edition (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  book_id TEXT NOT NULL REFERENCES book(id),
  format TEXT NOT NULL,
  asin TEXT,
  isbn TEXT,
  price REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  published_on TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE UNIQUE INDEX edition_asin ON edition (studio_id, asin) WHERE asin IS NOT NULL;
CREATE UNIQUE INDEX edition_isbn ON edition (studio_id, isbn) WHERE isbn IS NOT NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX edition_format ON edition (book_id, format) WHERE archived_at IS NULL;
CREATE INDEX edition_book ON edition (book_id);
