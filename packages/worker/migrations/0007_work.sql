-- Tasks, deadlines, approvals and decisions. They belong to a project or subproject of the project tree (a file, so `project_id` is an
-- id, not a foreign key). A deadline is a task with kind 'deadline' and a date. Approvals are sign-offs a workflow gate can ask for.
-- Decisions are an append-only ledger: a decision is never edited or removed, only superseded by a later one.

CREATE TABLE task (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'task',
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  assignee_id TEXT REFERENCES person(id),
  due TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  done_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX task_project ON task (studio_id, project_id, state);
CREATE INDEX task_assignee ON task (studio_id, assignee_id, state);

CREATE TABLE task_dependency (
  task_id TEXT NOT NULL REFERENCES task(id),
  depends_on_id TEXT NOT NULL REFERENCES task(id),
  PRIMARY KEY (task_id, depends_on_id)
);

-- `required` of the named approvers must approve; any one rejecting closes it as rejected. One pending request per project and label.
CREATE TABLE approval (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  label TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  required INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'pending',
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE UNIQUE INDEX approval_pending ON approval (studio_id, project_id, lower(label)) WHERE state = 'pending';
CREATE INDEX approval_project ON approval (studio_id, project_id);

CREATE TABLE approval_approver (
  approval_id TEXT NOT NULL REFERENCES approval(id),
  person_id TEXT NOT NULL REFERENCES person(id),
  response TEXT,
  reason TEXT NOT NULL DEFAULT '',
  responded_at TEXT,
  PRIMARY KEY (approval_id, person_id)
);
CREATE INDEX approval_approver_person ON approval_approver (person_id, response);

CREATE TABLE decision (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  project_id TEXT,
  title TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL,
  supersedes_id TEXT REFERENCES decision(id),
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
CREATE INDEX decision_project ON decision (studio_id, project_id, decided_at);
-- a decision is superseded at most once
CREATE UNIQUE INDEX decision_supersedes ON decision (supersedes_id) WHERE supersedes_id IS NOT NULL;
