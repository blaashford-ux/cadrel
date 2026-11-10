-- A Beta Reader's notes on a manuscript: one file of notes per reader per manuscript, in the same format Write keeps notes in. The server
-- holds the text as it is given and never reads it; the author's Write takes every reader's notes into the project, the reader's app puts
-- their own back. A reader can only ever reach their own row.

CREATE TABLE beta_note (
  file_id TEXT NOT NULL REFERENCES vault_file(id),
  person_id TEXT NOT NULL,
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (file_id, person_id)
);
