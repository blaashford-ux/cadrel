-- Canon and continuity (docs/M4-PLAN.md). Canon is the series' agreed facts, kept as records the studio governs; the prose files (series bible,
-- character sheets) stay the authors' own, and a fact points back to the passage that established it. All of it belongs to a series (a project of
-- the project tree, so `project_id` is an id, not a foreign key); a book reads the series' canon.
--
-- Nothing becomes canon except through a proposal that someone holding canon.approve approves. A fact is never edited: a change supersedes it
-- (the old one is kept, retired), so a check made against earlier canon stays truthful.

CREATE TABLE canon_entry (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX canon_entry_name ON canon_entry (studio_id, project_id, kind, lower(name)) WHERE state = 'active';
CREATE INDEX canon_entry_project ON canon_entry (studio_id, project_id, state);

-- An entry's summary, revised by new numbered versions; earlier ones stay readable.
CREATE TABLE canon_entry_version (
  entry_id TEXT NOT NULL REFERENCES canon_entry(id),
  n INTEGER NOT NULL,
  summary TEXT NOT NULL,
  written_at TEXT NOT NULL,
  written_by TEXT NOT NULL,
  PRIMARY KEY (entry_id, n)
);

-- One agreed fact about an entry. `source_*` is the passage that established it, in an exact version of a file (a quote with a little context and
-- where it was), so it can be shown and found again; a fact with no source is canon by decision alone. `book_project_id` and `chapter` say where in
-- the series it was established. `supersedes_id` names the fact this one replaces.
CREATE TABLE canon_fact (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  entry_id TEXT NOT NULL REFERENCES canon_entry(id),
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'canon',
  source_file_id TEXT,
  source_version INTEGER,
  source_quote TEXT,
  source_prefix TEXT NOT NULL DEFAULT '',
  source_suffix TEXT NOT NULL DEFAULT '',
  source_start INTEGER,
  book_project_id TEXT,
  chapter INTEGER,
  supersedes_id TEXT,
  proposal_id TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  retired_at TEXT,
  retired_by TEXT,
  retired_reason TEXT
);
CREATE INDEX canon_fact_entry ON canon_fact (studio_id, entry_id, status);
CREATE INDEX canon_fact_project ON canon_fact (studio_id, project_id, status);

-- A requested change to canon. `change` is add_entry, edit_entry, retire_entry, add_fact, supersede_fact or retire_fact; `payload` is its details as
-- JSON, checked when it is proposed and again when it is approved. A proposal made from a continuity finding names it in `finding_id`.
CREATE TABLE canon_proposal (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  change TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  reason TEXT,
  finding_id TEXT,
  proposed_by TEXT NOT NULL,
  proposed_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT
);
CREATE INDEX canon_proposal_project ON canon_proposal (studio_id, project_id, state);

-- A continuity check of one book's manuscript against the series' canon: pinned to the exact version of the file and to the canon as it stood
-- (`canon_stamp` is the time of the last canon change), so a later edit never makes an old finding point at the wrong text.
CREATE TABLE continuity_check (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  file_version INTEGER NOT NULL,
  canon_stamp TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  run_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  closed_at TEXT,
  closed_by TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX continuity_check_project ON continuity_check (studio_id, project_id, state);
CREATE INDEX continuity_check_file ON continuity_check (studio_id, file_id);

-- What a check found. Every finding quotes a passage of the pinned version and cites at least one canon fact (`fact_ids`, a JSON list), says how
-- bad it is and how sure the finder is, and is decided by a person: fixed (the passage is gone from a later version), accepted as canon (the
-- manuscript is right: a proposal is made), or dismissed with a reason. `seq` numbers findings within the check.
CREATE TABLE continuity_finding (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  check_id TEXT NOT NULL REFERENCES continuity_check(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  confidence TEXT NOT NULL,
  body TEXT NOT NULL,
  anchor_quote TEXT NOT NULL,
  anchor_prefix TEXT NOT NULL DEFAULT '',
  anchor_suffix TEXT NOT NULL DEFAULT '',
  anchor_start INTEGER NOT NULL,
  fact_ids TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'open',
  response TEXT,
  proposal_id TEXT,
  fixed_in_version INTEGER,
  raised_by TEXT NOT NULL,
  raised_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  UNIQUE (check_id, seq)
);
CREATE INDEX continuity_finding_check ON continuity_finding (studio_id, check_id, state);
