# Closing the small M2 and M3 gaps: implementation plan

Status: **plan, nothing built.** Branch `dev`. Three items listed as "not done" in [PLAN.md](PLAN.md) (M2 and M3) and [STUDIOS.md](STUDIOS.md) §"Not built". Each is its own slice and release-able alone. Versions are not tied to the plan ([VERSIONING.md](VERSIONING.md)); each slice is a Minor or a Fix as it turns out.

Order: **A (assistant on server Studios) → B (role dashboards) → C (security policy page).** A first because it is a hole (a feature that works on a local Studio silently does not on a server one) and it is the riskiest; B is the most visible to a team; C is the smallest and is cut down to what is real (see C).

## What the code shows today

- **Assistant (MCP).** `packages/mcp/src/main.ts` `findRecords()` opens the Studio's records as a **local file** (`--records <file> --person <id> --studio-id <id> --vault-blobs <dir>`), builds a `StudioService` on it and registers `recordsModule`, `editorialModule` and `projectsModule`. `people.mcpArgs()` returns **no arguments when the Studio is remote** (`!this.remote`), so for a server Studio the records, editorial and project tools are simply absent. The MCP process is separate from the app and the device's key is sealed by the app, so it cannot just open a client itself.
- The app side already has what a remote service needs: `remoteService(client)` (`shell/src/main/remote.ts`) proxies the namespaces `catalogue, people, business, work, workflows, briefs, passes, queries` and `can / canOn / canAt / explain / visibleProjects`; `RemoteBlobs` reads version contents. `editorialModule` also writes straight to the audit table with `db.run(...)` and reads the pinned version's hash through `db`, which a remote Studio does not give it.
- **Dashboards.** `Home.tsx` (163 lines) and `Dashboard.tsx` (218) are one layout for everyone; a card a role may not read is left out, nothing more. There is no notion of a person's working role.
- **Security policy.** `PERMISSIONS.md` §5 lists a table of settings written for email-link sign-in, 14-day sessions and second factors. **That is not how Cadrel signs in**: every request is signed by a device key, invitations are single-use codes, and the server holds only public keys. Much of the table therefore does not apply. What exists: invitation lifetime (fixed in the Worker), an end date on a role grant, `people.invite` as a capability, per-project assistant switch, force release with confirmation and audit, device list and revoke (`/v1/devices`, `/v1/members/:id`).

## A. The assistant's tools for a Studio whose records are on its server

**Goal:** a person on a server Studio gets the same records, editorial and project tools as on a local one, acting as themselves under their role, with every check still made on the server.

**Decision to confirm first (the one real design choice):** how the separate MCP process reaches the server without holding the device key.

- **Option 1 (recommended): the app is the door.** The app's main process already holds the key and the `StudioClient`. It serves a small authenticated **loopback endpoint** (random port, per-launch token passed to the MCP process in its arguments, nothing else listening) that forwards `rpc` and blob reads to the Studio. The MCP process gets `--records-remote <url> --token <t>` and builds `remoteService`-style proxies over HTTP. The key never leaves the app; the assistant works only while the app is open, which is already true of the server Studio's key being sealed to the signed-in user.
- Option 2: give the MCP process the device key (sealed-store read from the child). Simpler plumbing, but a second place a Studio key is held and a wider blast radius if the MCP is misconfigured. Not recommended.

**Slices**

1. **Door and client.** Loopback endpoint in `shell/src/main` (new `assistantDoor.ts`), token per launch, only `rpc` for the allowed namespaces and `blob get`; `peopleHost.mcpArgs` returns the remote flags when `this.remote`. In `packages/mcp`, a `remoteRecords()` beside `findRecords()` that yields the same `RecordsParts` (`service`, `view`, `closedBooks`, `stageForNewBook`). Tests: a request without the token is refused; a forged namespace is refused; the door closes with the app.
2. **Make the modules independent of a local `db`.** `editorialModule` and `recordsModule` take a raw `Db` for (a) the audit line "via the assistant" and (b) the pinned version's hash. Replace both with service calls: add an `audit.note(action, target, detail)` on the service (server-side, so the Worker writes it and it cannot be forged by the door) and read the hash from the pass/version record the service already returns. Local Studios keep working through the same calls. This is the one change that touches the Worker and bumps the server revision (a Studio needs one **Upgrade**).
3. **Blobs.** `--vault-blobs` becomes a `BlobStore` (local dir or the door's blob route) so `edit_read` quotes the exact pinned version on a server Studio.
4. **Extend the remote proxy** if any namespace the modules use is missing from `NAMESPACES` in `remote.ts` (decisions, verification and `audit` are the ones to check); a test lists every method the three modules call and asserts the remote proxy exposes it.
5. **Exit test.** Same shape as `m3Exit.test.ts` but through the door against the real Worker code: the assistant as an Editor lists passes, reads the pinned version, raises a query; as an Author it can read but not answer or decide; as someone with no `assistant.use` or on a confidential project it sees nothing. Confirmed manually on a real Studio.

**Not in scope:** new tools; letting the assistant answer, decide, move or close anything (still the person's own act).

**Risks:** the door is a new local listening surface (loopback only, token, short allow-list, closes with the app); the Worker change needs the Studio upgraded (the app already offers it, and the People page says so when behind).

## B. Role dashboards: Author, Editor and Director

**Goal:** Home opens on what this person does today, by their working role, without a second app or a separate permission system. The cards already exist; this arranges them and adds the few missing ones.

**Design.** A **lens**, not a mode: a person's lens is derived from the capabilities their roles hold (never a separate setting that could disagree with access), with a manual switch to another lens they are *allowed* to see. Mapping:

| Lens | Chosen when they hold | Home leads with | Dashboard leads with |
|---|---|---|---|
| **Author** | `edit.respond`, `manuscript.write` | Chapters to write and word goal progress; **queries waiting for my answer** (by pass, oldest first); sign-offs waiting on me; tasks due | my books' stages and deadlines |
| **Editor** | `edit.run` | **Passes assigned to me** by state (planned, in progress, due to deliver); my open queries by author response; next deadlines | passes across the books I'm assigned to, overdue deliveries |
| **Director** | `edit.assign`, `studio.dashboard` or `roles.manage` | At-risk books (late stage, open gates, unanswered queries beyond N days); approvals waiting; who is overloaded | pipeline, calendar and capacity, blockers by book; money and market snapshots only where the role may read them |

A person with several lenses sees the highest-reach one first and a switch; Owner defaults to Director. Everything is still filtered by the existing service checks and project assignment, so a lens can never show more than the person may read.

**Slices**

1. **Lens resolution** (pure, kernel or shell shared): `lensesFor(capabilities) → ordered list`, tested against every default role in `PERMISSIONS.md` (Owner, Admin, Director, Series Lead, Author, Editor, Art Director, Artist, Marketing, Analyst, Finance, Guest). Roles with none fall back to today's Home unchanged.
2. **Facts the lenses need**, from records the service already holds: queries awaiting my answer and passes assigned to me (from `editorial.ts`'s "waiting on you" arrangement, reused, not rewritten); overdue and stalled passes; books past a stage's expected time. A server-side count for the Director's at-risk list so a large Studio does not read every pass per page open (the Worker's CPU limit was the cause of three earlier fixes; one query per card, measured).
3. **Home and Dashboard screens**: reorder and add the cards per lens, with the switch; no change for roles without a lens. Keep the existing empty states.
4. **Tests**: lens table; a card for a capability the role lacks is absent, not empty; Author sees only their own queries; Director sees nothing from a project they are not assigned to (confidential and hidden projects); a shell end-to-end that signs in as each role against the Worker code.

**Not in scope:** user-defined dashboards or drag layout; notifications (tasks still notify no one, per STUDIOS.md); live updates (a page shows the state when opened or refreshed).

**Open question for you:** which three or four numbers a Director most wants first (late books, unanswered queries, money committed, who is overloaded?). The plan assumes the first and second; money waits for M7.

## C. Security policy page: cut to what is real

**Finding.** The table in `PERMISSIONS.md` §5 assumes email-link sign-in, sessions and second factors; Cadrel uses device keys. Building the page as written would promise controls that do not exist. So this slice **first rewrites that section to match how sign-in works**, then builds a page that sets only what the server can enforce.

**The page (Admin → Security policy; owner and holders of `studio.settings`)**

| Setting | Today | Enforced where |
|---|---|---|
| Invitation lifetime (default 7 days) | fixed in the Worker | Worker, on join |
| Who may invite | `people.invite` (Owner, Admin) | already in the service; the page shows who holds it and links to the role |
| Default guest access end (days; 0 = none) | set per invitation | Worker, as the default when an invitation names none |
| Stale check-out warning (default 7 days) | not built | shown on the Files page and Home for the holder and admins; **never auto-released** |
| Assistant on or off for the whole Studio | per project only | service, before any assistant tool |
| Devices | list and revoke exist | link from the page |
| Local copies on departure | described, not built | **out of scope here**; listed on the page as "not enforced" so no one assumes it |

Anything in the old table that cannot be enforced (second factor, session length, SSO) is removed from `PERMISSIONS.md` and listed once under "Not planned", so the documentation stops promising it.

**Slices**

1. Rewrite `PERMISSIONS.md` §5 to match reality; list what is not planned.
2. Store the policy in the Studio's records (one small `studio_policy` migration; defaults as above; audited like any change); the Worker reads it for invitation lifetime and the guest default; the service reads it for the assistant switch.
3. The page, the stale-check-out indicator, tests (a policy change takes effect on the next invitation; an invitation made before keeps its end date; a non-admin cannot change it; defaults when the row is absent equal today's behaviour).

**Risk:** a migration and a server revision (one Upgrade, same as A). Do C's migration and A's service change in the **same server revision** so a Studio upgrades once.

## Sequencing and effort

| Slice | Depends on | Size | Needs the Studio upgraded |
|---|---|---|---|
| A1 to A5 | decision on the door | largest | yes (A2) |
| B1 to B4 | none (reads A's service calls only if reused) | medium | maybe (B2 server count) |
| C1 to C3 | none | smallest | yes (C2) |

Suggested release shape: **0.13.0** = A + C together (one server revision, one Upgrade); **0.14.0** = B. If you would rather see dashboards sooner, B can go first with no server change if its counts are read client-side, at the cost of the CPU risk noted in B2.

## Needs your decision

1. **A:** the app as the door (recommended) or the key in the assistant's process?
2. **B:** the three Director numbers, and whether Owner should default to the Director lens.
3. **C:** agree to cut the page to what the server can enforce, and to remove the aspirational rows from `PERMISSIONS.md` rather than keep them.
