-- Workflows belong to projects and subprojects, not to catalogue books: each project is given a workflow when it is made and keeps it,
-- so a Series can live by one workflow and its Books by another. A studio has one default workflow for new projects and one for new
-- subprojects (the same one, until an administrator chooses otherwise). `workflow.is_default` and `book.stage` / `book.workflow_id`
-- from earlier steps are no longer used; they stay so that a database made by an earlier build still opens.

ALTER TABLE workflow ADD COLUMN default_project INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow ADD COLUMN default_subproject INTEGER NOT NULL DEFAULT 0;
UPDATE workflow SET default_project = is_default, default_subproject = is_default;
DROP INDEX workflow_default;
CREATE UNIQUE INDEX workflow_default_project ON workflow (studio_id) WHERE default_project = 1;
CREATE UNIQUE INDEX workflow_default_subproject ON workflow (studio_id) WHERE default_subproject = 1;
