-- Launch and market (docs/M6-PLAN.md). A release plan is a record that works backwards from a date: each item is an ordinary task (so it is in the
-- Planner and on people's Home) plus what it needs, and what is outstanding is computed from the records, never typed in. Moving the date makes a
-- proposal a person applies. Market figures are compact, dated and published to the Studio by whoever holds the library; no captured page text is here.
-- ARC reader details are personal data: only people who manage launches read them, every read is logged, and a reader can be erased.

CREATE TABLE release_template (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  key TEXT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  archived_at TEXT
);
CREATE UNIQUE INDEX release_template_name ON release_template (studio_id, lower(name)) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX release_template_key ON release_template (studio_id, key) WHERE key IS NOT NULL;

CREATE TABLE release_template_version (
  template_id TEXT NOT NULL REFERENCES release_template(id),
  n INTEGER NOT NULL,
  items TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  written_at TEXT NOT NULL,
  written_by TEXT NOT NULL,
  PRIMARY KEY (template_id, n)
);

CREATE TABLE release_plan (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  edition_id TEXT,
  template_id TEXT,
  template_version INTEGER,
  name TEXT NOT NULL,
  release_date TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  targets TEXT NOT NULL DEFAULT '{}',
  approved_revision TEXT,
  approved_by TEXT,
  approved_at TEXT,
  live_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX release_plan_project ON release_plan (studio_id, project_id, state);

CREATE TABLE release_item (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES release_plan(id),
  key TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES task(id),
  offset_days INTEGER NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  role TEXT NOT NULL DEFAULT '',
  requirement TEXT NOT NULL DEFAULT '{"kind":"manual"}',
  UNIQUE (plan_id, key)
);

CREATE TABLE date_proposal (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  plan_id TEXT NOT NULL REFERENCES release_plan(id),
  from_date TEXT NOT NULL,
  new_date TEXT NOT NULL,
  changes TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  reason TEXT NOT NULL DEFAULT '',
  proposed_by TEXT NOT NULL,
  proposed_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT
);
CREATE INDEX date_proposal_plan ON date_proposal (plan_id, state);

-- Asked of Art from a brief. Fulfilled when an asset meets the spec as measured and a version is approved.
CREATE TABLE asset_request (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  plan_id TEXT,
  brief_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  spec TEXT NOT NULL DEFAULT '{}',
  due TEXT,
  assignee_id TEXT,
  task_id TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  asset_id TEXT,
  delivered_version INTEGER,
  measured TEXT,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX asset_request_project ON asset_request (studio_id, project_id, state);

-- Compact, dated figures per ASIN, published to the Studio from a computer that has the library. Idempotent by (asin, captured_at).
CREATE TABLE market_figure (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  asin TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  price REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  rank INTEGER,
  ratings INTEGER,
  rating_avg REAL,
  categories TEXT NOT NULL DEFAULT '[]',
  published_by TEXT NOT NULL,
  published_at TEXT NOT NULL,
  UNIQUE (studio_id, asin, captured_at)
);
CREATE INDEX market_figure_asin ON market_figure (studio_id, asin, captured_at);

CREATE TABLE comp_set (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  asins TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

-- A marketing brief names its comps and pins the figures it saw, as of their capture dates.
CREATE TABLE brief_comp (
  brief_id TEXT NOT NULL REFERENCES brief(id),
  brief_version INTEGER NOT NULL,
  asin TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'comp',
  figure_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (brief_id, brief_version, asin)
);

CREATE TABLE market_report (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  as_of TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX market_report_project ON market_report (studio_id, project_id, kind);

CREATE TABLE arc_campaign (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  plan_id TEXT NOT NULL REFERENCES release_plan(id),
  name TEXT NOT NULL,
  target_readers INTEGER NOT NULL DEFAULT 0,
  review_target INTEGER NOT NULL DEFAULT 0,
  send_by TEXT,
  review_by TEXT,
  file_id TEXT,
  file_version INTEGER,
  state TEXT NOT NULL DEFAULT 'open',
  reported_reviews INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE arc_reader (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES arc_campaign(id),
  name TEXT,
  email TEXT,
  source TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'invited',
  sent_at TEXT,
  reviewed_at TEXT,
  review_url TEXT,
  note TEXT NOT NULL DEFAULT '',
  erased_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX arc_reader_campaign ON arc_reader (studio_id, campaign_id, state);

CREATE TABLE launch_review (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  plan_id TEXT NOT NULL REFERENCES release_plan(id),
  state TEXT NOT NULL DEFAULT 'open',
  measured TEXT NOT NULL DEFAULT '{}',
  planned TEXT NOT NULL DEFAULT '{}',
  worked TEXT NOT NULL DEFAULT '',
  did_not TEXT NOT NULL DEFAULT '',
  next TEXT NOT NULL DEFAULT '',
  opened_at TEXT NOT NULL,
  opened_by TEXT NOT NULL,
  done_at TEXT,
  done_by TEXT
);
CREATE UNIQUE INDEX launch_review_plan ON launch_review (plan_id);

CREATE TABLE market_decision (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  edition_id TEXT NOT NULL,
  asin TEXT,
  kind TEXT NOT NULL,
  from_value TEXT NOT NULL DEFAULT '',
  to_value TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  asset_id TEXT,
  brief_id TEXT,
  decision_id TEXT,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
CREATE INDEX market_decision_edition ON market_decision (studio_id, edition_id, decided_at);
