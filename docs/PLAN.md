# Cadrel plan

> **Names.** In the product the two apps are **Cadrel Write** and **Cadrel Market**, and nothing a person sees or any file or setting on disk uses the old names. "MDEdit" and "BookScout" in this document mean the original apps Cadrel was built from (and, in migration notes, the data they made).

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
- **Sharing and files (decided):** inside Cadrel, sharing is by roles through the vault; Google Drive is for beta readers only. Project files are local `.md` (and other) files synced by Cadrel, each with a **kind** Cadrel and the assistant understand; the active manuscript is a per-user local flag. See [FILES.md](FILES.md).
- **The PDM vault model replaces my earlier check-out idea.** Real files in a local working folder; the server (Cloudflare Workers, D1, R2) owns versions and locks; check-out locks exclusively; an administrator can force a lock off, losing the holder's uncommitted work (kept on their disk as an orphan, never deleted). Workflow states and transitions drive stage gates and read-only states, as in PDM. No real-time co-editing.
- **Captures are shared.** They are the public page source, so raw captures sync through R2 like any other file (no locking, append-only), after the existing personal-data scrub step, which stays mandatory because captures come from a logged-in browser.

## 2. Modules

| Module | Job | Built from |
|---|---|---|
| **Vault** | working folder, check-out / check-in, versions, locks, where-used, data cards, workflows | new (PDM model) |
| **Home** | each person's tasks, approvals, queries, recent work | new |
| **My Books** | the portal for a published book: its listing, market data, sales and royalties, payments and splits in one place, with the save and export features of Market and Finance | new, consolidating Market and Finance views |
| **Dashboard** | portfolio pipeline, calendar and capacity, risks, finance and market snapshots (gated) | new |
| **Catalogue** | IP, series, books, editions, metadata, the connected book record | new + BookScout `work` / `book` |
| **Write** | manuscripts, chapters, goals, progress | MDEdit |
| **Edit** | editorial passes, anchored comments and queries, version compare, revision verification | MDEdit + new |
| **Canon** | series bible, proposals, continuity checking | BookScout text + embeddings, new |
| **Art & Assets** | briefs, concepts, feedback pinned to designs, versions, usage tracking, licences (Cover Creator later) | new |
| **Preflight** | EPUB / metadata / cover / front-matter checks, error vs warning vs suggestion | MDEdit export + epubcheck |
| **Launch** | marketing briefs, launch plans, ARC tracking, campaign asset requests, post-launch review | new |
| **Market** | category, keyword and comp research, cover and blurb analysis. Research only: no money. | BookScout |
| **Finance** | KDP import, sales, royalties, splits, payments and payouts, series and backlist reporting | BookScout `library/sales` and the Money / Royalties / Payments / Payouts views |
| **Business** | agreements, credits, contributions, rights, costs, revenue allocation, profitability, capacity planning | new + BookScout splits and payouts |
| **Assistant** | MCP tools from every module, proposals inbox | BookScout MCP |

**Deliberately not built** (from the discussion, kept): a general AI writing assistant, a worldbuilding wiki apart from Canon, a social network, a generic task manager (tasks exist only inside book and release workflows), AI toy generators, a full email-marketing platform (integrate), vanity-metric dashboards, accounting (Cadrel is the management view, not the ledger).

## 3. Milestones

Each milestone ends in a release (a Minor under [VERSIONING.md](VERSIONING.md)) with a stated exit test, and is delivered as a series of PRs into `dev`. Stage gates are the exit criteria; dates are deliberately not given until M0 shows the real cost of merging the codebases.

### M0: One app (0.2.0)
Merge and harmonise. No new features; behaviour of both apps is unchanged and their tests are the proof.

**Status: built and verified on Linux; the Windows installer is built by CI and not yet seen.**

Done:
- Both repos imported at pinned commits (`docs/PROVENANCE.md`); every original suite passes in Cadrel with the same counts (MDEdit 564, BookScout 506 plus its own skips).
- Toolchain settled (`docs/ARCHITECTURE.md`): Electron 44.9 for everything, one `pdfjs-dist` (4.10.38; 6.4 crashes the Electron app reading a PDF), dependencies found through Node resolution.
- Both main processes split into a hostable module plus a thin standalone entry, with the standalone apps unchanged.
- `@cadrel/shell`: one window, left rail, **Home** and **Dashboard** with live data from both modules, Write and Market each in its own view with its own bridge, last page remembered, close guard for unsaved edits, only the shell's own page can drive the shell. 33 tests (27 unit and 6 real-Electron end-to-end).
- Installer (NSIS), version taken from `VERSION`, headless smoke test (`Cadrel.exe --smoke-test=file`, 14 checks), CI that builds and smoke-tests the installer and publishes it on merge. Packaged Linux app: smoke 14/14, shell end-to-end 6/6 against the packaged binary.
- Whole workspace: typecheck clean, 1,157 tests passing with `CI=true`.
- Projects (a tree, Series → Book by convention), Notes across modules, shell Settings with app-wide appearance, Cadrel icons and palette; `docs/ARCHITECTURE.md` §3.
- Cloudflare: resources created (`cadrel-*`, `cadrel-dev-*`), Worker with `/v1/health` and vault migration, deploy step in the release workflow (not yet run on GitHub).

Not done or not yet verified (carry into M1):
- **Windows**: the NSIS installer, the installed layout and the Windows window chrome have never run. The first dev merge is the real test. Existing MDEdit and BookScout users are meant to find their settings (the shell keeps their data folders) but that is unproven on a real profile.
- **GitHub workflows** and the Worker deploy have not run yet.
- Tests that skip themselves where their environment is missing still skip in this sandbox: the capture-extension browser tests (7) and the Market walkthrough (4) need Chromium via `playwright install`, which CI does; 2 library performance tests are opt-in.
- `@cadrel/ui` (a shared design system) is deferred: the shell's CSS is its own until a second shell-owned surface needs it. The split of MDEdit into `manuscript` and `export` packages is also deferred; nothing needs it yet.
- Market's tray and "keep running when the window closes" are not carried into the shell; its About page is not reachable; 
- Code signing; the installer is unsigned.

### M1: Shared records (0.3.0)
**Progress on the shared-records list below.** Built: the `store` (file-backed async `Db`, the Worker's migrations applied in order, newer files refused), the `catalogue` records (IP, series, books at positions, editions with ASIN and ISBN; unique names, positions, ASINs and ISBNs enforced by the database; archive with cascade; every change and its audit row in one transaction; one studio cannot reach another's), and the `service` (every catalogue call checked with `can` for a named person; the one-person Studio runs as its Owner). The role matrix is tested against each operation. People and roles are built: records (migration 0004), the permission-checked service with the guardrails (a randomized test of hundreds of role-manager actions checks nobody gains a governance power the granter lacked) and the role editor in Admin (People, Teams, Roles, Explain access, capability review). Not built there: invitations and sign-in mapping onto people (M2, with the server), "View as", the security policy screen, and default roles receiving new capabilities automatically (a newer capability goes to the review list instead). Stages and gates are built: workflows as data (migrations 0005 and 0006), with MDEdit's stages (Planning, Drafting, Revising, Editing, Published, On hold) as the shipped default; several workflows, a default for projects and another for subprojects, chosen once when a project is created and never changed; stages live on projects and subprojects and move only through gate-checked moves (roles and conditions such as a linked manuscript or finished subprojects); Write has no statuses of its own and shows Cadrel's; a workflow builder in Admin. Not yet: stage shown on a book's page in My Books (it needs My Books on the catalogue records), gate conditions that depend on manuscript progress, transition actions, and read-only states. Tasks, deadlines, approvals and decisions are built (migration 0007): tasks with dependencies, sign-offs by named people that gates can require, an append-only decision ledger, a Work section on each project's page and a "Waiting on you" card on Home; a Planner page with the pipeline and the calendar (month view) is built; reminders, task templates and dragging are not. Not yet built: the credit / contribution / rights / revenue-share tables, the role editor, the local vault, and Home and Dashboard on real records. No Catalogue screens and no separate adopt step are planned (My Books and Import project cover them); My Books still lists Market's own-books list and moves onto the catalogue (the ASIN join) once the app opens the store.

Three additions are in scope before any M1 code: **Backup and Import**, a **Finance** module split out of Market, and **My Books**. Their design is in "M1 additions" below; the build order puts them first because they are restructuring and safety work that the shared records then sit on.

- `kernel`, `store`, `service`: studio, people, roles, IP, series, books, editions, projects, stages and gates, tasks, deadlines, approvals, decisions, audit log; the credit / contribution / rights / revenue-share tables exist (no screens).
- Permission engine and **role editor** per [PERMISSIONS.md](PERMISSIONS.md): Owner bootstrap, default roles, teams, scoped assignments, confidential projects, Explain access, guardrails; matrix and property tests.
- Permission engine with the actor model, in-process transport, matrix tests. `kernel` is runtime-neutral (no `node:` imports) and `store` is async, so the same code runs in Electron and in a Worker.
- **Local vault**: working folder, file states, check-out / check-in / undo / get-latest against a local vault, with the same rules the server will enforce; workflows as data (states, transitions, conditions, actions); data cards; references and where-used.
- **No separate Catalogue module: My Books is the catalogue's screen** (decided). "Adopt an MDEdit project as a book" is replaced by **Import project** (built). `edition.asin` joins Market and Finance data (`own_book`); the catalogue records (series, position, stage, editions) sit behind My Books, which gains series, position and edition editing as the screens need them.
- Lifecycle with configurable stages and gates; calendar; Home and Dashboard on real records.
- MCP server: already serves the enabled features (Write, Market, Studio notes and projects). What M1 adds is actor-scoping and tools for the new records as they get screens, not a new server.
- **Backup and Import projects** (below), **Finance** (below) and **My Books** (below).
- **Exit:** create a series of three books, assign people and deadlines, see the pipeline and calendar, and see the same book's manuscript progress and KDP earnings on its record, and open that book from My Books to reach its Market and Finance records and save them. Also: back up a Studio, restore it on a clean profile, and import a real MDEdit project into Cadrel with its chapters, goals, notes and settings intact.

#### M1 additions

**A. Backup and Import projects** (built: `packages/shell/src/main/backup.ts`, Settings → Backup and import; scheduled backups and Market's library are not in it yet)
Two jobs with different shapes, built on one archive format.
- **Backup** (STUDIOS.md lists the button as present and disabled): a Studio's backup is a single `.cadrel-backup` file (a zip with a `manifest.json`: Cadrel version, schema versions, Studio id and name, date, contents, a checksum per entry). It can cover the whole Studio or chosen projects. Contents: project records and links, Notes, the project working folders, Write's data, Finance data, and Market's library (optional, because it is large; BookScout's existing "Back up…" is reused for it). Never included: the owner key, API tokens, `secrets\`, and the pairing codes. A backup is read-only and does not stop the app; it is verified on write by reading the archive back and checking every checksum. Backups can be manual or scheduled, with a keep-last-N rule, into a folder the person picks. Restore is into an empty Studio or as a new Studio and never overwrites silently; a manifest with a newer schema than the app refuses with "update Cadrel".
- **Import project from MDEdit**: pick an MDEdit Root Folder or a single project folder (or an MDEdit export of one). Cadrel reads `.mdedit/project.json` (status, goals, active manuscript, excluded folders, edited marks, per-book settings), the Markdown files and style sheet, and the manuscript notes/review files, and creates a Cadrel project (placed in the project tree, Series → Book by convention) whose files are **copied**, never moved, so the MDEdit original is untouched and can be removed by the person once satisfied. A preview lists what will be created and what could not be carried over before anything is written; a project of the same name offers rename, skip or merge-as-new-copy. Google Drive sync state is not imported (the vault replaces it); the report says so. Notes become Notes (origin kept). Safe to run twice: it recognises a project it already imported by a recorded source id.
- **Import a Cadrel project** from a backup (restore one project into the current Studio), using the same reader.
- **Tests:** round-trip (back up then restore equals the original, byte for byte on files); a corrupted archive and a newer-schema archive refuse; secrets are absent from a backup (plant-and-assert, as with captures); import runs against MDEdit's real fixture projects with their goals, notes and settings; running an import twice creates one project.

**B. Finance module** (out of Market) (built: `packages/finance-desktop`; see the status note at the end of this part)
Market becomes research only. Everything about money moves to a new **Finance** module on the rail, with no change to its behaviour and its tests as the proof (as in M0).
- **Moves out of Market:** KDP report import (Orders, KENP, Payments), the Money views (months, analysis), Royalties, Payments, Payouts and statements, people and book splits, FX and KENP rates, "clear sales data", and the sales-estimate calibration (it is fitted to the studio's own sales; Market only reads the resulting curve). Their code is the `sales` part of `market-library` and the corresponding Market views and bridge calls, which gain a `finance` package and bridge.
- **Stays in Market:** captures, queue, library (the books, their pages, ranks, text), categories, keywords, analysis, community, parser health, settings. The one cross-over is **My Books' ownership flag and `edition.asin`**: Market keeps knowing which books are the studio's own (`own_book`), and Finance reads it; Finance never writes to the Market library.
- **Data stays where it is for now.** Sales data lives in the library schema; Finance reads and writes it through an interface so a later move to the Studio's own store (and, in M7, kernel `person` / `revenue_share`) does not touch screens. No data migration in M1, so an existing BookScout/Market user loses nothing and needs no conversion.
- **Permissions:** the Finance module is gated by the *Royalties, payments, payouts* row in PERMISSIONS.md (Owner and Finance modify; Admin, Director, Series Lead read). Author sees their own books only. Market's gate no longer covers money. With roles not yet applied (M2), the module is simply visible to the Owner.
- **Moves in the shell:** a new rail entry, a `finance` module id beside `write` and `market`, its own view and bridge, the same close guard and remembered page. Dashboard and Home money snapshots read from Finance. Market's renderer and bridge lose the money calls. The MCP server is one process for the whole suite, so its money tools stay where they are for now and keep their names; moving them under Finance is not part of this split.
- **Tests:** Market's remaining suite and Finance's moved suite together equal the pre-split counts; a test asserts Market's renderer and bridge expose no money calls; the shell end-to-end gains a Finance page.

*Status of B:* built. Finance is its own rail page and view (`window.cadrelFinance`, channels `finance:*`, only the Finance view may call them) and its own package, `@cadrel/finance-desktop`. It still reads and writes Market's library through the same `AppService` and `market-library` code, so no data moved and no behaviour changed; Finance reads Market's list of the studio's own books and asks Market to open a book for capture, and does nothing else to Market's records. The look is Market's stylesheet and its `DataTable` and charts, imported from `@cadrel/market-desktop` until the shared design system exists. Market's My Books list keeps the books and the capture actions but no longer shows orders, pages read or sales. Not done: the standalone Market app (kept for development) no longer has any money screens; the Electron end-to-end suites could not be run in the sandbox (no Electron binary), so the shell page-flow for Finance and the edited Market My Books test have not been exercised.

**C. My Books** (new module, directly below Home on the rail) (built: `packages/shell/src/main/mybooks.ts` and `renderer/MyBooks.tsx`; see the status note at the end of this part)
The portal for everything about a **published** book, so a person does not hunt through Market and Finance for it. It consolidates; it does not own data, and nothing is stored twice.
- **A list** of the studio's published books (editions with an ASIN, from the Catalogue and the `own_book` flag), filterable by series and pen name, with cover, rank, last-30-day units and royalties.
- **A book page** with sections that are views of the owning modules: *Overview* (cover, metadata, status, links to its project and manuscript), *Listing and market* (rank and price history, comps, categories and keywords it is in, from Market), *Sales* (units, KENP, trend), *Royalties and splits* (what was earned, who is owed what, payments and payouts, from Finance, shown only to roles that may see it), *Notes and tasks* for the book. Each section opens the full Market or Finance screen for that book when more depth is wanted.
- **The same save features as Market and Finance, in one place.** Anything that can be saved or exported from either module for a book can be saved from its My Books page: Market's category export (csv / md report), data packs, and the book's captured pages; Finance's payment calculators (csv / pdf), roll-ups, author statements (csv / pdf) and payout statements. The page adds **Save everything for this book**: one folder with its Market export and its Finance statements. These actions call the owning module's existing save code, so output is identical and there is one implementation to test.
- **Rules:** My Books never shows what the person's role may not see (Finance sections hidden, not blank); a book with no sales data says so instead of showing zeros; figures say whether they were reported, estimated or forecast (principle 4).
- **Tests:** each save action from My Books produces byte-identical output to the same action in its module; role-gated sections are absent for a role without access; a book without an ASIN or without sales renders its empty states.

*Status of C:* built as a page the shell draws (not a module view), reading Market and Finance through their services and keeping no data. List with search and pen-name filter; a book page with Overview, Listing and market (rank and price history, category lists), Sales and royalties by month labelled reported / estimated, Splits, Save and the book's Notes. Finance's sections and figures are decided in the main process from the person's role (`financeAccess`): Owner, Admin, Director and Finance see them; every other role, and Authors for now (their own-books-only rule needs agreements, M7), get a page with those sections absent, not zero. Save: "Save everything for this book", Market exports (CSV and report for each category the book is on) and Finance (the book's earnings CSV and each author's statement as CSV and PDF) go into a new folder for the book through the same `exportContent` / `statementFile` generators Market and Finance use; statements are for the last 12 months, "paid" once a KDP payment report is imported and "earned" until then. "Open on Amazon" opens the book's Amazon page (Market's own opener); "Open in Market" opens the book in Market's Library and "Open in Finance" opens the book's own page in Finance (a per-book view: earnings by month, marketplace and rate, split, save). Per-book payments: the book page lists its payments with the book's part of each, Finance's book page has the payment calculators and a roll-up by period limited to the book, and Save includes them; allocation stays whole-payment (Payments tab). Not done: tasks (no task records exist yet) and a Catalogue-backed list (the list is Market's own-books list until Catalogue exists); the shell Electron end-to-end flow was not run (no Electron binary in the sandbox).

**Build order inside M1:** (1) docs and this plan; (2) Backup and Import, because it protects every later migration and the existing users' data; (3) Finance split, a behaviour-preserving move; (4) My Books on top of the split; (5) the shared-records work listed above, with Catalogue giving My Books its list. The shell's page list becomes: Home, **My Books**, Dashboard, Projects, Notes, Write, Market, **Finance**, Assistants, Admin, Profile, Settings.


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
- Market (research only since M1) becomes studio-facing: shared comps, category reports and cover/blurb comparisons tied to briefs; decision history (change cover, blurb, keywords, price → outcome).
- **Exit:** a release is planned, executed and reviewed from one record.

### M7: Business (0.9.0)
- Agreements, credits, contributions and rights as the four separate concepts, with restricted access.
- Production costs and ad spend per book and series; budgets; unit economics and break-even.
- Royalty reconciliation and revenue allocation generalised from the Finance module's payments and splits (moved out of Market in M1) to all contributors; actual vs estimated vs forecast clearly separated.
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
| 10 | Default roles | **Decided:** Owner, Admin, Director, Series Lead, Author, Editor, Art Director, Artist, Marketing, Analyst, Finance, Guest (matrix in PERMISSIONS.md). Admin sees everything. |
| 11 | Sign-in | **Decided:** email invitation plus one-time link. Needs an email sender; see PERMISSIONS.md. |
| 12 | Domain for email sending and the API | Open: do you have a domain on Cloudflare to use (for example `api.<yourdomain>` and the sender address)? Without one the Worker runs on a `workers.dev` address and invitations are copied by hand. |

## 6. The Cloudflare account (checked)

Read-only look through the connector:
- Existing: three D1 databases (`eidolon-db`, `storyforge-db`, `author_portal_db`), seven R2 buckets and seven Workers for your other projects. Cadrel gets its own `cadrel-*` and `cadrel-dev-*` resources and touches none of them.
- The connected tool is the old Workers Bindings server, which Cloudflare marks deprecated. It can create and query D1 and R2 but **cannot deploy a Worker**, and this sandbox cannot reach `api.cloudflare.com`.
- So Workers are deployed from **GitHub Actions** on merge (dev and main), which needs two repository secrets in `blaashford-ux/cadrel`: a Cloudflare API token scoped to Workers, D1 and R2 on this account, and the account id. Add them in GitHub (Settings → Secrets and variables → Actions); do not paste them in chat.
- Limits from the docs, relevant to the design: a Worker request body is capped at 100 MB on Free and Pro and 200 MB on Business (hence file transfers go straight to R2 by signed URL, and R2 multipart handles anything large); since 1 September 2026 D1 queries on the Workers **Free** plan fail once the daily row-read or row-write limit is reached, so confirm which plan the account is on before the studio relies on it.

## 7. Next step

Start M0 on a branch off `dev`: skeleton and CI first (workspaces, shared toolchain, a shell that opens), then import `manuscript` / `export` (pure, most tested), then `market` / `sales`, then the two UIs as modules, then Home and Dashboard. Raise `VERSION` to 0.2.0 on the `dev` → `main` PR.
