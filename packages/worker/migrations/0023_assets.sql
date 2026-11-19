-- Art, assets and Preflight (docs/M5-PLAN.md). An asset is a vault file plus governance: the bytes and the versions stay the vault's; the asset adds what
-- it is for, whether a version is approved (of an exact version and hash), its licence, and where it is used. Cover and art briefs are the existing
-- `brief` records with two new kinds. Nothing replaces an approved version automatically: a replacement is a proposal that moves nothing.

CREATE TABLE asset (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  file_id TEXT NOT NULL REFERENCES vault_file(id),
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'draft',
  licence_kind TEXT NOT NULL DEFAULT '',
  licensor TEXT NOT NULL DEFAULT '',
  licence_ref TEXT NOT NULL DEFAULT '',
  licence_expires TEXT,
  territory TEXT NOT NULL DEFAULT '',
  credit_line TEXT NOT NULL DEFAULT '',
  licence_file_id TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX asset_file ON asset (studio_id, file_id);
CREATE INDEX asset_project ON asset (studio_id, project_id, kind, state);

-- Append-only: an approval names the exact version and its hash; a revocation is a later row, never an edit.
CREATE TABLE asset_approval (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES asset(id),
  version INTEGER NOT NULL,
  hash TEXT NOT NULL,
  state TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
CREATE INDEX asset_approval_asset ON asset_approval (asset_id, decided_at);

-- A use of an asset that is not a vault file: a listing, an ad, a banner. (File uses are read from file_reference.)
CREATE TABLE asset_use (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES asset(id),
  version INTEGER,
  user_kind TEXT NOT NULL,
  user_ref TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'current',
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX asset_use_asset ON asset_use (asset_id, state);

CREATE TABLE asset_replacement (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES asset(id),
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  decision_reason TEXT,
  proposed_by TEXT NOT NULL,
  proposed_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT
);
CREATE INDEX asset_replacement_asset ON asset_replacement (asset_id, state);

-- A concept: an exact version of a file offered against an exact version of a brief.
CREATE TABLE concept (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  brief_id TEXT NOT NULL REFERENCES brief(id),
  brief_version INTEGER NOT NULL,
  file_id TEXT NOT NULL REFERENCES vault_file(id),
  file_version INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'submitted',
  note TEXT NOT NULL DEFAULT '',
  submitted_by TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  asset_id TEXT
);
CREATE INDEX concept_brief ON concept (studio_id, brief_id, state);

-- Feedback pinned to a region of an image at an exact version (fractions of its width and height).
CREATE TABLE asset_feedback (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  file_version INTEGER NOT NULL,
  x REAL,
  y REAL,
  w REAL,
  h REAL,
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  by TEXT NOT NULL,
  at TEXT NOT NULL,
  resolved_by TEXT,
  resolved_at TEXT
);
CREATE INDEX asset_feedback_target ON asset_feedback (studio_id, target_kind, target_id);

-- Preflight: a run is pinned to the exact file, cover and catalogue metadata it saw; each result says what was measured and what the rule expects.
CREATE TABLE preflight_run (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  edition_id TEXT,
  file_id TEXT NOT NULL,
  file_version INTEGER NOT NULL,
  file_hash TEXT NOT NULL,
  cover_asset_id TEXT,
  cover_version INTEGER,
  metadata_hash TEXT NOT NULL DEFAULT '',
  pack_id TEXT NOT NULL,
  pack_version TEXT NOT NULL,
  pack_verified TEXT NOT NULL DEFAULT '',
  run_by TEXT NOT NULL,
  at TEXT NOT NULL,
  errors INTEGER NOT NULL DEFAULT 0,
  warnings INTEGER NOT NULL DEFAULT 0,
  suggestions INTEGER NOT NULL DEFAULT 0,
  not_checked TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX preflight_run_edition ON preflight_run (studio_id, project_id, edition_id, at);

CREATE TABLE preflight_result (
  run_id TEXT NOT NULL REFERENCES preflight_run(id),
  seq INTEGER NOT NULL,
  rule_id TEXT NOT NULL,
  grade TEXT NOT NULL,
  what TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  measured TEXT NOT NULL DEFAULT '',
  expected TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open',
  waived_by TEXT,
  waived_reason TEXT,
  waived_at TEXT,
  PRIMARY KEY (run_id, seq)
);
