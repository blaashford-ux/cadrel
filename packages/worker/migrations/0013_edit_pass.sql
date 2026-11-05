-- Editorial passes: one editor's pass of one kind (developmental, line, copy or proof) over one exact version of a manuscript file, under a
-- brief (an exact version of it, optional). The pass is pinned to `file_version`, so later changes to the manuscript never move what the
-- editor was shown. A file has at most one live pass of each kind at a time. State runs planned, in_progress, delivered, responded, closed;
-- a pass that is called off is cancelled. Projects are in the project tree (a file), so `project_id` is an id, not a foreign key.

CREATE TABLE edit_pass (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  file_id TEXT NOT NULL,
  file_version INTEGER NOT NULL,
  brief_id TEXT,
  brief_version INTEGER,
  editor_id TEXT NOT NULL REFERENCES person(id),
  state TEXT NOT NULL DEFAULT 'planned',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  started_at TEXT,
  delivered_at TEXT,
  responded_at TEXT,
  closed_at TEXT,
  closed_by TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (file_id, file_version) REFERENCES file_version(file_id, n),
  FOREIGN KEY (brief_id, brief_version) REFERENCES brief_version(brief_id, n)
);
CREATE INDEX edit_pass_project ON edit_pass (studio_id, project_id, state);
CREATE INDEX edit_pass_editor ON edit_pass (studio_id, editor_id, state);
CREATE INDEX edit_pass_file ON edit_pass (file_id);
-- one live pass of a kind per file
CREATE UNIQUE INDEX edit_pass_live ON edit_pass (studio_id, file_id, kind) WHERE state NOT IN ('closed', 'cancelled');
