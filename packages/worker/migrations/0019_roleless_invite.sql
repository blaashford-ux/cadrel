-- An invitation can name a person (a record in the Studio's people, made when the owner invites them, with their name and email) instead of a
-- role. Whoever joins with it is that person and can see nothing until the owner gives them a role, per project, in Cadrel. `role` stays
-- for older invitations and members; a roleless one holds the placeholder '_none'.

ALTER TABLE invite ADD COLUMN person_id TEXT;
ALTER TABLE member ADD COLUMN person_id TEXT;
