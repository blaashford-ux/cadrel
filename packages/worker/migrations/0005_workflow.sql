-- Workflows: the stages a book moves through and the gates between them (docs/PERMISSIONS.md §7, ARCHITECTURE.md). A workflow is data an
-- administrator builds; exactly one is the default, which a new book starts in. A book keeps the workflow it started in when the default
-- changes. `book.stage` is a stage key of that workflow; keys never change once made (names do), so renaming a stage moves no book.

CREATE TABLE workflow (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  template_key TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE UNIQUE INDEX workflow_name ON workflow (studio_id, lower(name));
CREATE UNIQUE INDEX workflow_default ON workflow (studio_id) WHERE is_default = 1;

CREATE TABLE workflow_stage (
  workflow_id TEXT NOT NULL REFERENCES workflow(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  category TEXT NOT NULL DEFAULT 'active',
  color TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (workflow_id, key)
);

-- A way from one stage to another. `conditions` is a JSON list of checks on the book that must all hold (see kernel workflow.ts); the roles
-- in workflow_transition_role, when there are any, are the ones allowed to make the move (none listed: anyone who may edit the book).
CREATE TABLE workflow_transition (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflow(id),
  from_key TEXT NOT NULL,
  to_key TEXT NOT NULL,
  conditions TEXT NOT NULL DEFAULT '[]',
  UNIQUE (workflow_id, from_key, to_key)
);
CREATE TABLE workflow_transition_role (
  transition_id TEXT NOT NULL REFERENCES workflow_transition(id),
  role_id TEXT NOT NULL REFERENCES role(id),
  PRIMARY KEY (transition_id, role_id)
);
CREATE INDEX workflow_transition_role_role ON workflow_transition_role (role_id);

ALTER TABLE book ADD COLUMN workflow_id TEXT REFERENCES workflow(id);
CREATE INDEX book_workflow ON book (workflow_id);
