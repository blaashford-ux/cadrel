-- The Studio's security policy: the few rules an administrator can set that the Studio itself enforces. One row per Studio; a Studio with no row
-- behaves as the defaults below (7-day invitations, no default guest end, a stale check-out warning after 7 days, the assistant on), so nothing
-- changes for a Studio until someone saves the page. `guest_days` NULL means a guest's access has no end unless the invitation names one.

CREATE TABLE studio_policy (
  studio_id TEXT PRIMARY KEY,
  invite_days INTEGER NOT NULL DEFAULT 7,
  guest_days INTEGER,
  stale_checkout_days INTEGER NOT NULL DEFAULT 7,
  assistant_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
