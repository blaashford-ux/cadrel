-- The author's decision on an item raised in an editorial pass: accept, reject or defer, with a reason (required to reject or defer). Each one
-- is also written to the decision ledger, and a deferral makes a task dated for the revisit. Decisions are append-only: changing your mind
-- records a new decision that supersedes the old one (and cancels the old one's revisit task). The current decision on an item is the one
-- nothing supersedes.

CREATE TABLE edit_decision (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  query_id TEXT NOT NULL REFERENCES edit_query(id),
  outcome TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  revisit TEXT,
  ledger_id TEXT NOT NULL REFERENCES decision(id),
  task_id TEXT REFERENCES task(id),
  supersedes_id TEXT REFERENCES edit_decision(id),
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
CREATE INDEX edit_decision_query ON edit_decision (studio_id, query_id);
-- one first decision per item, and a decision is superseded at most once
CREATE UNIQUE INDEX edit_decision_first ON edit_decision (query_id) WHERE supersedes_id IS NULL;
CREATE UNIQUE INDEX edit_decision_supersedes ON edit_decision (supersedes_id) WHERE supersedes_id IS NOT NULL;
