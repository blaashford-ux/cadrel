-- People, teams, roles and assignments (docs/PERMISSIONS.md §7). `person.kind` is the membership kind (employee, contractor, guest): one
-- database is one studio, so a separate membership row would only repeat the studio. A person has no role until one is assigned.
-- scope_id is a project id (the project tree is still a file in M1) or the studio's id, so it is not a foreign key.

CREATE TABLE person (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  kind TEXT NOT NULL DEFAULT 'employee',
  deactivated_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE UNIQUE INDEX person_email ON person (studio_id, lower(email)) WHERE email IS NOT NULL AND deactivated_at IS NULL;

-- A credited identity, separate from the person: one person may write under several, and a name may be shared by several people.
CREATE TABLE pen_name (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE UNIQUE INDEX pen_name_name ON pen_name (studio_id, lower(display_name));
CREATE TABLE pen_name_person (
  pen_name_id TEXT NOT NULL REFERENCES pen_name(id),
  person_id TEXT NOT NULL REFERENCES person(id),
  PRIMARY KEY (pen_name_id, person_id)
);

CREATE TABLE team (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE UNIQUE INDEX team_name ON team (studio_id, lower(name));
CREATE TABLE team_member (
  team_id TEXT NOT NULL REFERENCES team(id),
  person_id TEXT NOT NULL REFERENCES person(id),
  PRIMARY KEY (team_id, person_id)
);

-- `all_caps` is the Owner role: every capability, including ones added later. `template_key` names the shipped default it came from.
CREATE TABLE role (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  template_key TEXT,
  all_caps INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE UNIQUE INDEX role_name ON role (studio_id, lower(name));
CREATE UNIQUE INDEX role_template ON role (studio_id, template_key) WHERE template_key IS NOT NULL;
CREATE TABLE role_capability (
  role_id TEXT NOT NULL REFERENCES role(id),
  capability TEXT NOT NULL,
  PRIMARY KEY (role_id, capability)
);

-- This person (or team) has this role at this scope, optionally until a date. Additive: there is no deny.
CREATE TABLE assignment (
  id TEXT PRIMARY KEY,
  studio_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES role(id),
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  expires_at TEXT,
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL
);
CREATE UNIQUE INDEX assignment_once ON assignment (studio_id, subject_kind, subject_id, role_id, scope_kind, scope_id);
CREATE INDEX assignment_role ON assignment (role_id);
CREATE INDEX assignment_subject ON assignment (subject_kind, subject_id);

-- Capabilities an administrator has been shown (or has placed in a role). One that a newer version adds is not in here until it is, so it
-- appears in the capability review instead of silently being Owner-only forever.
CREATE TABLE capability_seen (
  capability TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL
);
