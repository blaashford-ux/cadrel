# Cadrel plan

Status: plan, no product code yet. Architecture and stack are in [ARCHITECTURE.md](ARCHITECTURE.md); roles and security in [PERMISSIONS.md](PERMISSIONS.md); versioning in [VERSIONING.md](VERSIONING.md).

## 1. What Cadrel is

A book **studio's** working environment, built as a **desktop-first** Windows application that works on real local files and synchronises them through a server vault, the way SolidWorks PDM does. The studio develops original series with house authors, in-house editors, artists and marketers, and each person does their work in Cadrel (specialist tools such as Photoshop stay outside; Cadrel links, versions and hands off their files). It starts from two apps that already exist:

- **MDEdit** → writing, chapters, goals and progress, EPUB / print PDF / DOCX export.
- **BookScout** → Amazon market research, text analysis, KDP sales and royalty analytics, MCP.

The suite is a shell with **Home** (my work) and **Dashboard** (the studio), with each discipline a module. The advantage over a bundle of utilities is the shared record: a book is created once and its manuscript, briefs, cover, metadata, edits, launch, sales and costs all hang off it.

### Principles

1. **The book is the production unit.** Every task, file, decision, deadline and result belongs to a book, series or studio initiative.
2. **People have roles.** Each person sees the work they need, not every tool.
3. **The studio owns the workflow, not the creative decisions.** Cadrel makes work visible, coordinates handoffs, records approvals and keeps institutional memory. It does not force an assembly line.
4. **Measured is not estimated.** Numbers say whether they were reported, estimated or forecast, and how they were worked out.
5. **The assistant proposes; people decide.**

### Where I depart from the discussion

- **It is too wide to build in the order it was written.** Six areas and about thirty features would produce a lot of half-finished screens. The plan builds the *team workspace and the editorial loop* first, because writing and editing is what the studio does every day, then adds departments in the order work flows through a book.
- **The studio is the first customer.** No generic multi-tenant product work. The data model carries `studio_id` and permissions from day one (cheap now, expensive later), but there is one studio, and features are judged by whether the studio uses them.
- **Multi-user is the hard part, so it comes second, not last.** Role dashboards are meaningless with one user. M1 builds shared records and the vault model behind a permission-checked service; M2 connects it to Cloudflare. Everything after is written against the service and works for a team from its first day.
- **The PDM vault model replaces my earlier check-out idea.** Real files in a local working folder; the server (Cloudflare Workers, D1, R2) owns versions and locks; check-out locks exclusively; an administrator can force a lock off, losing the holder's uncommitted work (kept on their disk as an orphan, never deleted). Workflow states and transitions drive stage gates and read-only states, as in PDM. No real-time co-editing.
- **Captures are shared.** They are the public page source, so raw captures sync through R2 like any other file (no locking, append-only), after the existing personal-data scrub step, which stays mandatory because captures come from a logged-in browser.

## 2. Modules

| Module | Job | Built from |
|---|---|---|
| **Vault** | working folder, check-out / check-in, versions, locks, where-used, data cards, workflows | new (PDM model) |
| **Home** | each person's tasks, approvals, queries, recent work | new |
| **Dashboard** | portfolio pipeline, calendar and capacity, risks, finance and market snapshots (gated) | new |
| **Catalogue** | IP, series, books, editions, metadata, the connected book record | new + BookScout `work` / `book` |
| **Write** | manuscripts, chapters, goals, progress | MDEdit |
| **Edit** | editorial passes, anchored comments and queries, version compare, revision verification | MDEdit + new |
| **Canon** | series bible, proposals, continuity checking | BookScout text + embeddings, new |
| **Art & Assets** | briefs, concepts, feedback pinned to designs, versions, usage tracking, licences (Cover Creator later) | new |
| **Preflight** | EPUB / metadata / cover / front-matter checks, error vs warning vs suggestion | MDEdit export + epubcheck |
| **Launch** | marketing briefs, launch plans, ARC tracking, campaign asset requests, post-launch review | new |
| **Market** | category, keyword and comp research, cover and blurb analysis | BookScout |
| **Sales** | KDP import, royalties, payments, series and backlist reporting | BookScout |
| **Business** | agreements, credits, contributions, rights, costs, revenue allocation, profitability, capacity planning | new + BookScout splits and payouts |
| **Assistant** | MCP tools from every module, proposals inbox | BookScout MCP |

**Deliberately not built** (from the discussion, kept): a general AI writing assistant, a worldbuilding wiki apart from Canon, a social network, a generic task manager (tasks exist only inside book and release workflows), AI toy generators, a full email-marketing platform (integrate), vanity-metric dashboards, accounting (Cadrel is the management view, not the ledger).

## 3. Milestones

Each milestone ends in a release (a Minor under [VERSIONING.md](VERSIONING.md)) with a stated exit test, and is delivered as a series of PRs into `dev`. Stage gates are the exit criteria; dates are deliberately not given until M0 shows the real cost of merging the codebases.

### M0: One app (0.2.0)
Merge and harmonise. No new features; behaviour of both apps is unchanged and their tests are the proof.
- Import both repos at pinned commits (`docs/PROVENANCE.md`), reshape into workspaces per the package map.
- Settle the harmonisation table: Electron 44, ESM main, one `pdfjs-dist`, shared toolchain.
- `@cadrel/ui` design system from MDEdit chrome and BookScout charts; shell with left-rail navigation.
- **Home** and **Dashboard** exist with real but modest content: projects and word-goal progress from Write, capture counts and last-captured from Market.
- Replace the placeholder `scripts/build.sh`: typecheck, unit tests, Windows installer, packaged-app smoke test (both apps' existing ones), installer as the downloadable artifact.
- **Cloudflare spike** (runs alongside, needs the account connected): a Worker with D1 and R2; atomic check-out under concurrent requests; signed-URL upload and download from Electron; sign-in from the desktop; record the real limits (D1 size, request body, costs). Output: `docs/spikes/cloudflare.md` with a go / adjust verdict.
- **Exit:** one installer; Write and Market work exactly as before inside the shell; all imported tests pass in CI; a user with existing MDEdit and BookScout data opens it and finds it.

### M1: Shared records (0.3.0)
- `kernel`, `store`, `service`: studio, people, roles, IP, series, books, editions, projects, stages and gates, tasks, deadlines, approvals, decisions, audit log; the credit / contribution / rights / revenue-share tables exist (no screens).
- Permission engine and **role editor** per [PERMISSIONS.md](PERMISSIONS.md): Owner bootstrap, default roles, teams, scoped assignments, confidential projects, Explain access, guardrails; matrix and property tests.
- Permission engine with the actor model, in-process transport, matrix tests. `kernel` is runtime-neutral (no `node:` imports) and `store` is async, so the same code runs in Electron and in a Worker.
- **Local vault**: working folder, file states, check-out / check-in / undo / get-latest against a local vault, with the same rules the server will enforce; workflows as data (states, transitions, conditions, actions); data cards; references and where-used.
- Catalogue module; "adopt MDEdit project as a book"; `edition.asin` joins Market and Sales data (`own_book`).
- Lifecycle with configurable stages and gates; calendar; Home and Dashboard on real records.
- MCP server skeleton, actor-scoped, with first Catalogue and Dashboard tools.
- **Exit:** create a series of three books, assign people and deadlines, see the pipeline and calendar, and see the same book's manuscript progress and KDP earnings on its record.

### M2: The team vault on Cloudflare (0.4.0)
Where it becomes a studio tool.
- Worker API with D1 (records, versions, locks, workflow state, audit) and R2 (file contents); migrations shared with the desktop cache.
- Cloud vault in the app: Create studio with a setup code (you become Owner), sign-in, invitations, security policy, teams, guests with narrow expiring grants, confidential projects; all permission checks enforced in the Worker.
- **Check-out locking, check-in versions, undo check-out, get latest, and admin force** with data-loss confirmation, orphaned-copy handling, audit and notification.
- Offline: work on checked-out files without a connection, check in on reconnect; a clear status when the server is unreachable.
- **Shared captures**: scrubbed raw pages and covers sync to R2; each client rebuilds its own index.
- Role dashboards: Author, Editor, Studio director first.
- Backups (D1 export, R2 replication), schema-version compatibility check, update feed from R2, **code-signed installer**.
- **Exit:** author and editor on two machines; the author checks a chapter out, the editor sees the lock and who holds it, the author checks in, the editor gets the new version; an admin force-releases a lock and the holder's changes are kept as an orphan copy; a freelance guest sees exactly one book and nothing else.

### M3: Editorial (0.5.0)
- Creative briefs (manuscript and edit).
- Passes (developmental, line, copy, proof), each with brief, editor, state and the exact version it covers.
- Comments and queries anchored to passages; author responses; accept / reject / defer with reasons.
- Side-by-side version compare; **revision verification** (which requested changes were made, changed or missed).
- Approval and decision ledger wired into stage gates (an approved pass unlocks the next stage).
- **Exit:** one real book goes through a full edit inside Cadrel.

### M4: Canon and continuity (0.6.0)
- Series bible with versioned entries; facts anchored to the manuscript passage that establishes them.
- Change proposals reviewed by the series lead; author assignments get the approved canon, open threads and brief.
- Continuity checker: findings cite exact passages, with severity and confidence; the author controls what becomes canon. Uses `text` and embeddings; checks a new book against series canon.
- **Exit:** Book 4's manuscript is checked against Books 1–3 and the findings are specific and checkable.

### M5: Art, assets and Preflight (0.7.0)
- Asset register with versions, approval state, licence and rights, and **usage tracking** ("which listing, ad and banner use the old cover?"); replacement is proposed, never automatic.
- Cover and campaign briefs; concepts against a brief; feedback pinned to the design; file linking and previews for Photoshop sources.
- Preflight: EPUB validity and navigation, front and back matter, name and series consistency, cover dimensions and resolution, retailer metadata requirements; results graded error / warning / suggestion.
- **Exit:** a cover goes brief → concepts → approval → used in Preflight and visible to Launch.

### M6: Launch and market (0.8.0)
- Release plans from templates, worked backwards from the date; dependencies and outstanding assets.
- Marketing briefs from Market comps; ARC recruitment, distribution and review tracking; campaign asset requests to Art; post-launch review.
- Market becomes studio-facing: shared comps, category reports and cover/blurb comparisons tied to briefs; decision history (change cover, blurb, keywords, price → outcome).
- **Exit:** a release is planned, executed and reviewed from one record.

### M7: Business (0.9.0)
- Agreements, credits, contributions and rights as the four separate concepts, with restricted access.
- Production costs and ad spend per book and series; budgets; unit economics and break-even.
- Royalty reconciliation and revenue allocation generalised from BookScout payments and splits to all contributors; actual vs estimated vs forecast clearly separated.
- Backlist health, series sell-through (only where the data allows; labelled measured vs estimated), marketing ROI, capacity planning.
- **Exit:** a studio director can answer "which series earn the best margin" and "how much money is committed to unreleased books" from real records.

### M8: Coordinator (1.0.0)
Cross-module assistant on top of the MCP tools already shipped by earlier modules: at-risk projects, missing launch assets, unresolved revisions, cross-book continuity reports; a proposals inbox where people accept or reject what it suggests.
- **Exit:** the five example questions in the discussion are answered with cited evidence and no unreviewed changes.

## 4. Risks

| Risk | Mitigation |
|---|---|
| Merging two codebases with different conventions stalls everything | M0 changes no behaviour; import tests with the code; one package at a time |
| Scope: this is a very large product | Studio is the only customer; milestones end in a usable release; modules are cut by use, not by the list |
| Multi-user complexity (sync, conflicts, offline) | PDM-style exclusive locks so conflicts cannot happen; no real-time co-edit; atomic check-out proven in the Cloudflare spike |
| Cloudflare limits or cost surprise (D1 size, request size, R2 operations) | Spike records real numbers before M2; large files go direct to R2; `store` interface keeps the database swappable |
| Force-released lock destroys work | Never deletes local files: holder's copy becomes a flagged orphan; admin confirmation, audit entry, notification |
| Raw captures contain the capturer's personal data | Scrub step is mandatory before upload; plant-and-assert tests stay in CI |
| Retrofit cost of permissions and rights | `studio_id`, actor and the four rights tables exist before any workflow is built |
| Unsigned installer and no team update channel | Signing and updates from R2 are M2 exit criteria |
| Manuscripts leaving the machine via hosted AI | Per-project switch to disable assistant access; read tools permission-checked |
| Native pieces (`sharp`, `sqlite-vec`, OCR) in the installer | Packaged-app smoke test in CI on Windows, as both apps do today |
| Electron / `pdfjs-dist` upgrade breaks PDF export | M0 keeps MDEdit's real-Electron PDF and epubcheck tests as gates |

## 5. Decisions I need from you

I have assumed a default for each so work is not blocked; tell me where you disagree.

| # | Question | Assumed default |
|---|---|---|
| 1 | Are authors employees, contractors, or both? | **Both.** Membership has a kind; contractors and guests get scoped access. Affects M2 permissions and M7 agreements. |
| 2 | Where does the studio server run? | **Decided: Cloudflare (Workers, D1, R2) on your account.** The connector is not authorised in this session yet, so the spike is blocked until it is. |
| 3 | Team size at launch | Up to about 25 people, one studio. |
| 4 | Platforms | **Decided: Windows only.** No macOS build. |
| 5 | Sharing BookScout captures across the studio | **Decided: share them** (public page source), scrubbed of personal data first. |
| 6 | Assistant | Each person's own Claude through MCP first; an in-app assistant panel later if wanted. |
| 7 | Do `MDEdit` and `bookscout` stay alive? | Archived once M0 ships; fixes after that go in Cadrel. |
| 8 | Product name for modules and Cadrel installer | Suite is "Cadrel"; modules use the plain names in section 2. |
| 9 | Who may force a lock? | **Decided:** you start as Owner; administrators configure roles. `vault.force` is held by Owner and Admin by default and can be granted to any role. |
| 10 | Default roles | Owner, Admin, Director, Series Lead, Author, Editor, Art Director, Artist, Marketing, Analyst, Finance, Guest, with the matrix in PERMISSIONS.md. Tell me which to drop, rename or change. |

## 6. The Cloudflare account (checked)

Read-only look through the connector:
- Existing: three D1 databases (`eidolon-db`, `storyforge-db`, `author_portal_db`), seven R2 buckets and seven Workers for your other projects. Cadrel gets its own `cadrel-*` and `cadrel-dev-*` resources and touches none of them.
- The connected tool is the old Workers Bindings server, which Cloudflare marks deprecated. It can create and query D1 and R2 but **cannot deploy a Worker**, and this sandbox cannot reach `api.cloudflare.com`.
- So Workers are deployed from **GitHub Actions** on merge (dev and main), which needs two repository secrets in `blaashford-ux/cadrel`: a Cloudflare API token scoped to Workers, D1 and R2 on this account, and the account id. Add them in GitHub (Settings → Secrets and variables → Actions); do not paste them in chat.
- Limits from the docs, relevant to the design: a Worker request body is capped at 100 MB on Free and Pro and 200 MB on Business (hence file transfers go straight to R2 by signed URL, and R2 multipart handles anything large); since 1 September 2026 D1 queries on the Workers **Free** plan fail once the daily row-read or row-write limit is reached, so confirm which plan the account is on before the studio relies on it.

## 7. Next step

Start M0 on a branch off `dev`: skeleton and CI first (workspaces, shared toolchain, a shell that opens), then import `manuscript` / `export` (pure, most tested), then `market` / `sales`, then the two UIs as modules, then Home and Dashboard. Raise `VERSION` to 0.2.0 on the `dev` → `main` PR.
