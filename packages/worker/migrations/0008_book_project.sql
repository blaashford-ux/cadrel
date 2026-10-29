-- A catalogue book can be linked to the project (or subproject) it is made in, so a book's page shows its stage, manuscript and progress.
-- Projects are in the project tree (a file), so `project_id` is an id, not a foreign key. A book has at most one project and a project at most one book.

CREATE TABLE book_project (
  book_id TEXT PRIMARY KEY REFERENCES book(id),
  studio_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  linked_by TEXT NOT NULL
);
CREATE UNIQUE INDEX book_project_project ON book_project (studio_id, project_id);
