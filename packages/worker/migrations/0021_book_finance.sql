-- What a book earned, month by month, kept so the people who wrote it can see it. The figures come from the publisher's own KDP reports, which
-- only the publisher's computer has; their Cadrel publishes each book's months here when a report is imported. One row per book per month,
-- holding that month's report for that one book alone (never a month with other books in it), as JSON. Authors read only the books they are
-- credited on as author or co-author; the people who manage royalties read them all.

CREATE TABLE book_finance (
  studio_id TEXT NOT NULL,
  asin TEXT NOT NULL,
  month TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  report TEXT NOT NULL,
  published_at TEXT NOT NULL,
  published_by TEXT NOT NULL,
  PRIMARY KEY (studio_id, asin, month)
);
