-- Queries and comments raised inside an editorial pass, anchored to a passage of the exact file version the pass covers. A query asks the
-- author something and gets a response; a comment needs none; a suggestion carries replacement text (the author's accept / reject / defer
-- on it is recorded separately). The anchor is the quote, a little of the text on either side, and its place in that version, so it can be
-- found again in a later version. `seq` numbers the items within a pass (Q1, Q2...). Nothing is ever deleted: an item is withdrawn.

CREATE TABLE edit_query (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  pass_id TEXT NOT NULL REFERENCES edit_pass(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  category TEXT,
  anchor_quote TEXT,
  anchor_prefix TEXT NOT NULL DEFAULT '',
  anchor_suffix TEXT NOT NULL DEFAULT '',
  anchor_start INTEGER,
  body TEXT NOT NULL,
  replacement TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  response TEXT,
  responded_by TEXT,
  responded_at TEXT,
  raised_by TEXT NOT NULL,
  raised_at TEXT NOT NULL,
  resolved_by TEXT,
  resolved_at TEXT,
  UNIQUE (pass_id, seq)
);
CREATE INDEX edit_query_pass ON edit_query (studio_id, pass_id, state);
