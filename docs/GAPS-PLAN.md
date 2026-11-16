# Closing the small M2 and M3 gaps: implementation plan

Status: **A, B and C all built and released as 0.13.0. A and C are server revision 8 and database step 20; B needs no server change.** Branch `dev`. Three items listed as "not done" in [PLAN.md](PLAN.md) (M2 and M3) and [STUDIOS.md](STUDIOS.md) §"Not built". Each is its own slice and release-able alone. Versions are not tied to the plan ([VERSIONING.md](VERSIONING.md)); each slice is a Minor or a Fix as it turns out.

Order: **A (assistant on server Studios) → B (role dashboards) → C (security policy page).** A first because it is a hole (a feature that works on a local Studio silently does not on a server one) and it is the riskiest; B is the most visible to a team; C is the smallest and is cut down to what is real (see C).

## What the code shows today

- **Assistant (MCP).** `packages/mcp/src/main.ts` `findRecords()` opens the Studio's records as a **local file** (`--records <file> --person <id> --studio-id <id> --vault-blobs <dir>`), builds a `StudioService` on it and registers `recordsModule`, `editorialModule` and `projectsModule`. `people.mcpArgs()` returns **no arguments when the Studio is remote** (`!this.remote`), so for a server Studio the records, editorial and project tools are simply absent. The MCP process is separate from the app and the device's key is sealed by the app, so it cannot just open a client itself.
- The app side already has what a remote service needs: `remoteService(client)` (`shell/src/main/remote.ts`) proxies the namespaces `catalogue, people, business, work, workflows, briefs, passes, queries` and `can / canOn / canAt / explain / visibleProjects`; `RemoteBlobs` reads version contents. `editorialModule` also writes straight to the audit table with `db.run(...)` and reads the pinned version's hash through `db`, which a remote Studio does not give it.
- **Dashboards.** `Home.tsx` (163 lines) and `Dashboard.tsx` (218) are one layout for everyone; a card a role may not read is left out, nothing more. There is no notion of a person's working role.
- **Security policy.** `PERMISSIONS.md` §5 lists a table of settings written for email-link sign-in, 14-day sessions and second factors. **That is not how Cadrel signs in**: every request is signed by a device key, invitations are single-use codes, and the server holds only public keys. Much of the table therefore does not apply. What exists: invitation lifetime (fixed in the Worker), an end date on a role grant, `people.invite` as a capability, per-project assistant switch, force release with confirmation and audit, device list and revoke (`/v1/devices`, `/v1/members/:id`).

## A. The assistant's tools for a Studio whose records are on its server

**Built (released as 0.13.0; needs each Studio's server upgraded to revision 8).** What was done, against the slices below: the door is `shell/src/main/assistantDoor.ts` (127.0.0.1 only, token per launch, refuses any browser request that carries an `Origin`, carries only the service's namespaces, the vault's reading operations and a version's contents by hash); the assistant's process reaches it with a `DoorClient` (`studio-client/src/remote.ts`, which also now holds `remoteService` and `RemoteVaultStore`, moved from the shell); the three tool modules no longer take a raw database: the audit line is the service's new `assistant.note` (written on the Studio's side, held on any project or the Studio), versions and files come from a `VaultStore`, contents from a `BlobStore`; `mcpArgs` gives a server Studio `--door --door-token --person --studio-id`. Tested: `shell/test/assistantDoor.test.ts` (an Editor lists their pass, reads the exact pinned text and raises a query through the door against the real Worker code; a refusal arrives with its reason; the door refuses no token, a wrong token, a browser origin, an unknown namespace and any vault write). **Left out on purpose:** the project tools (create, move, stage) stay local-Studio only, because only the owner changes the project tree on a server. **Still to do for A:** a manual run on a real Studio (the one thing the stand-in cannot show), and `files_list` asks for `manuscript.read` on the whole Studio, so a project-scoped Editor is refused it (as on a local Studio today).

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

**Built (released as 0.13.0; no server change).** `kernel/src/lens.ts` decides the views from what a person's roles hold; `shell/src/main/lens.ts` builds them from the passes and tasks the service already lets that person read; `renderer/LensPanel.tsx` shows the panel at the top of **Home and the Dashboard**, with a switch when a person has more than one. **What differs from the design below, because of what the code showed:** there is no `studio.dashboard` capability, so the rules are the ones in `lens.ts` (Director: may manage roles, or approves editorial work without running it; Editor: `edit.run`; Author: `manuscript.write`); the Owner holds all three and leads with the Director's view; Marketing, Finance, Art, Analyst, Guest and Beta Reader have no working view and see Home and the Dashboard exactly as before. **The Director's two numbers:** *late books* (a book with an open deadline, a task of kind deadline, past its date; the worst first) and *queries waiting on authors* (delivered passes with queries unanswered, by book, with the longest wait). **Cost:** no server count was added: the views reuse the reads the Editing page and the plan already make, and a role with no working view reads nothing extra. If a very large Studio's Home turns out to be slow, the server count described in B2 is the next step. Tested: the rule for every default role (`kernel/test/lens.test.ts`), the views from fixtures (`shell/test/lens.test.ts`), the views on real records as the Owner moves a pass from planned to delivered and a deadline passes (`shell/test/lensLive.test.ts`), and a project-scoped Author against the real Worker code (`remote.test.ts`). **Not done:** the screen has not been seen in a real window; the views are as of when the page opens (no live update); a Studio's own meaning of "late" beyond deadline tasks (a stage that has run long) is not used.

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

**Built (released as 0.13.0).** `PERMISSIONS.md` §3 and §5 now describe what Cadrel really does (a device is a key; no emailed sign-in, sessions or second factor) and list what is not planned. The policy is the table `studio_policy` (database step 20; one row per Studio, none meaning the defaults), `kernel/src/policy.ts` (defaults, ranges, audited change), the service's `policy.get` (anyone) and `policy.set` (`studio.settings`) and `assistant.check`, the Worker (invitation lifetime and the guest default are applied when an invitation is made), and **Admin → Security policy** (`renderer/SecurityPolicy.tsx`). The Files page flags a check-out older than the stale limit to its holder and to anyone who may force a release; the assistant's record, editorial and project tools refuse for everyone when the Studio turns it off. Tested in the kernel, the service, the Worker over HTTP, and the shell against the real Worker code (including the assistant refusing through the door). **Not done:** the stale warning is on the Files page only (not on Home); the page's screen has not been seen in a real window; the switch covers the records, editorial and project tools, not Write's or Market's own tools (those are governed per computer by Settings → MCP).

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

Release shape: **0.13.0** carries A, B and C together (one server revision, one Upgrade). If you would rather see dashboards sooner, B can go first with no server change if its counts are read client-side, at the cost of the CPU risk noted in B2.

## Decided (15 November 2026)

1. **A:** the app is the door (loopback endpoint in the app's main process; the key never leaves the app).
2. **B:** the Director leads with **late books** and **unanswered queries**; money waits for M7. The Owner defaults to the Director lens.
3. **C:** the page is cut to what the server can enforce, and the unenforceable rows are removed from `PERMISSIONS.md`.
