-- Beta reading: which chapters of a manuscript file a Beta Reader may be sent. One row per manuscript file that has been set up. `chapters`
-- is a JSON array of the chapter keys that are switched ON (`level` is the heading level chapters are split at); every other chapter, and any
-- chapter added later, is off, so nothing reaches a beta reader unless the author turned it on. No row means no chapter is on.

CREATE TABLE beta_read (
  file_id TEXT PRIMARY KEY REFERENCES vault_file(id),
  level INTEGER NOT NULL DEFAULT 1,
  chapters TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
