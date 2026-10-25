-- Vault: controlled files, their versions, check-out locks, force-release orphans, audit.
-- D1 and the desktop cache are both SQLite; this file is applied to each.

CREATE TABLE vault_file (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  path TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'draft',
  UNIQUE (studio_id, path)
);

CREATE TABLE file_version (
  file_id TEXT NOT NULL REFERENCES vault_file(id),
  n INTEGER NOT NULL,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  author TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (file_id, n)
);

-- One row per locked file. The primary key is what makes check-out atomic.
CREATE TABLE checkout (
  file_id TEXT PRIMARY KEY REFERENCES vault_file(id),
  person_id TEXT NOT NULL,
  machine TEXT NOT NULL,
  since TEXT NOT NULL,
  base_version INTEGER NOT NULL
);

-- A lock removed by an administrator. The holder's machine keeps its copy aside and flags it.
CREATE TABLE orphan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id TEXT NOT NULL REFERENCES vault_file(id),
  person_id TEXT NOT NULL,
  machine TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  removed_by TEXT NOT NULL,
  removed_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  acknowledged_at TEXT
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX audit_target ON audit (target);
