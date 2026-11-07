-- Briefs: what a manuscript is meant to be (kind 'manuscript') and what an edit is asked to do (kind 'edit'). They belong to a project or
-- subproject of the project tree (a file, so `project_id` is an id, not a foreign key). A brief is never overwritten: each revision is a
-- new row in brief_version with the next number, so an edit pass can say which version of the brief it was run against.

CREATE TABLE brief (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX brief_project ON brief (studio_id, project_id, kind);

CREATE TABLE brief_version (
  brief_id TEXT NOT NULL REFERENCES brief(id),
  n INTEGER NOT NULL,
  body TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  written_at TEXT NOT NULL,
  written_by TEXT NOT NULL,
  PRIMARY KEY (brief_id, n)
);
