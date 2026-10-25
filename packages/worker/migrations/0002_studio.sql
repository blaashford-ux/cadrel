-- Studio: who may use it. The owner's key is in the Worker's settings; members are the people the owner invited.

CREATE TABLE studio_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE member (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  revoked_at TEXT
);

-- Only a hash of the one-time code is kept, so a copy of the database cannot be used to join.
CREATE TABLE invite (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- Signatures already seen in the last few minutes, so a captured request cannot be played again.
CREATE TABLE request_nonce (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
