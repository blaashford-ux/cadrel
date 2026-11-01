-- The Studio server holds the records for everyone (people, roles, catalogue, work) and the vault, so an invitation can say where its role
-- applies and until when: a guest can be given one project, for a while. Older invitations are for the whole Studio with no end.

ALTER TABLE invite ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'studio';
ALTER TABLE invite ADD COLUMN scope_id TEXT;
ALTER TABLE invite ADD COLUMN grant_expires_at TEXT;
