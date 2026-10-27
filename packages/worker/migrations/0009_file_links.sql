-- References between vault files (a cover refers to its source PSD and fonts; an EPUB to its manuscript version and cover), "where used" is the
-- same table read backwards, and a data card: a few typed facts about a file that people can edit and search. A reference names a specific
-- version, or none (the latest); updating a reference to a newer version is a person's choice, never automatic.

CREATE TABLE file_reference (
  file_id TEXT NOT NULL REFERENCES vault_file(id),
  refers_to_id TEXT NOT NULL REFERENCES vault_file(id),
  version INTEGER,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (file_id, refers_to_id)
);
CREATE INDEX file_reference_to ON file_reference (refers_to_id);

CREATE TABLE file_card (
  file_id TEXT PRIMARY KEY REFERENCES vault_file(id),
  project_id TEXT,
  fields TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
