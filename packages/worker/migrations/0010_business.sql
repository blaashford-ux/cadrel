-- The four business concepts, kept as four tables on purpose (docs/ARCHITECTURE.md): credit is not ownership, contribution is not share.
--   contribution: who did what on what.           credit: how someone is named, and where.
--   rights: who owns or licenses what, and limits.  revenue_share: who is paid what share, with advances.
-- Each is about a subject, an IP, series, book or edition of the catalogue (`subject_kind`, `subject_id`; polymorphic, so no foreign key,
-- checked by the code that writes them). Nothing here refers to another of the four. Money is whole minor units (cents) and shares are
-- basis points (10000 = 100%), never floating point. Rows are archived, never deleted.

CREATE TABLE contribution (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES person(id),
  role TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  started_on TEXT,
  done_on TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX contribution_subject ON contribution (studio_id, subject_kind, subject_id);
CREATE INDEX contribution_person ON contribution (person_id);

-- A credit names a person or one of their pen names (exactly one), in a role, in a place (the cover, the title page, the listing...).
CREATE TABLE credit (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  person_id TEXT REFERENCES person(id),
  pen_name_id TEXT REFERENCES pen_name(id),
  role TEXT NOT NULL,
  placement TEXT NOT NULL,
  display_as TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  CHECK ((person_id IS NULL) <> (pen_name_id IS NULL))
);
CREATE INDEX credit_subject ON credit (studio_id, subject_kind, subject_id);

-- Rights: held by a person or by a named outside party (exactly one), of one kind (owned, licensed in or out, reverted), over one right,
-- in a territory and period, exclusive or not, with the restrictions in words. `ends_on` null means it does not end.
CREATE TABLE rights (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  holder_person_id TEXT REFERENCES person(id),
  holder_name TEXT,
  kind TEXT NOT NULL,
  right_type TEXT NOT NULL,
  territory TEXT NOT NULL DEFAULT 'worldwide',
  language TEXT NOT NULL DEFAULT '',
  starts_on TEXT,
  ends_on TEXT,
  exclusive INTEGER NOT NULL DEFAULT 0,
  restrictions TEXT NOT NULL DEFAULT '',
  archived_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  CHECK ((holder_person_id IS NULL) <> (holder_name IS NULL))
);
CREATE INDEX rights_subject ON rights (studio_id, subject_kind, subject_id);

-- A share of what a subject earns, for a person, over a period. At no moment may the live shares on one subject add up to more than 100%
-- (checked by the code that writes them). The advance is what was paid up front against the share, in minor units.
CREATE TABLE revenue_share (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES person(id),
  share_bp INTEGER NOT NULL CHECK (share_bp >= 0 AND share_bp <= 10000),
  basis TEXT NOT NULL DEFAULT 'net',
  from_date TEXT NOT NULL,
  to_date TEXT,
  advance_minor INTEGER NOT NULL DEFAULT 0 CHECK (advance_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  notes TEXT NOT NULL DEFAULT '',
  archived_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX revenue_share_subject ON revenue_share (studio_id, subject_kind, subject_id);
CREATE INDEX revenue_share_person ON revenue_share (person_id);
