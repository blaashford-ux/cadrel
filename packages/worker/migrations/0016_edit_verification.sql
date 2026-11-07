-- Revision verification: after the author revises the manuscript, each change they accepted in an editorial pass is checked against the revised
-- version: made (the suggested text is there), changed (the passage was altered, but not to the suggestion), missed (the passage is as it was),
-- or unchecked (an accepted item with no passage to look for). One result per item per revised version; checking again replaces it.

CREATE TABLE edit_verification (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  pass_id TEXT NOT NULL REFERENCES edit_pass(id),
  query_id TEXT NOT NULL REFERENCES edit_query(id),
  revised_version INTEGER NOT NULL,
  result TEXT NOT NULL,
  found_start INTEGER,
  found_end INTEGER,
  note TEXT NOT NULL DEFAULT '',
  checked_by TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  UNIQUE (query_id, revised_version)
);
CREATE INDEX edit_verification_pass ON edit_verification (studio_id, pass_id, revised_version);
