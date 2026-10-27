# Cadrel architecture

> **Names.** In the product the two apps are **Cadrel Write** and **Cadrel Market**, and nothing a person sees or any file or setting on disk uses the old names. "MDEdit" and "BookScout" in this document mean the original apps Cadrel was built from (and, in migration notes, the data they made).

Cadrel is a **desktop-first Windows application** for running a book studio: one app, one installer, one set of shared records, with each discipline (writing, editing, art, launch, market research, sales, business) as a **module** inside it. It is built from [MDEdit](https://github.com/blaashford-ux/MDEdit) and [BookScout](https://github.com/blaashford-ux/bookscout), harmonised, plus new modules. The scope and build order are in [PLAN.md](PLAN.md).

## 1. Stack (unchanged from MDEdit and BookScout)

| Layer | Choice | Note |
|---|---|---|
| Shell | Electron + React 18 + Vite 5 + TypeScript | Windows only; installer via electron-builder (NSIS) |
| Studio server | Cloudflare Workers (TypeScript) + **D1** (SQLite) + **R2** (files), one set per Studio in the owner's own account | the vault; see 2 and [STUDIOS.md](STUDIOS.md) |
| Repo | npm workspaces monorepo, `@cadrel/*` packages, ESM | BookScout's layout |
| Tests | vitest everywhere, real-Electron integration tests, fake-API pattern for renderer tests | both apps already do this |
| Structured data | SQLite through built-in `node:sqlite` (FTS5, `sqlite-vec` extension) | no native module to rebuild |
| Bulk data | Plain files on disk (manuscripts, assets, raw captures) | nothing locked in; Explorer, git and sync keep working |
| AI | MCP server over stdio (official TypeScript SDK) | one server for the whole suite |
| Editor | Milkdown Crepe (Markdown, WYSIWYG) | MDEdit |
| Export | EPUB, DOCX (`docx`), print PDF (Paged.js in Electron) | MDEdit |
| Capture | Chrome MV3 extension posting to a loopback server | BookScout |

The server is TypeScript too, and D1 is SQLite, so the desktop's local database and the server's database share one SQL dialect, one migration set and the same domain code.

### Harmonisation items (settled in M0)

| Item | MDEdit | BookScout | Cadrel |
|---|---|---|---|
| Electron | 33 (Node 20) | 44 | **44.9** (Node 24, Chromium 152) for the whole workspace. MDEdit needed one change (`printToPDF` margins) and one test pattern widened for the newer Chromium. |
| Main-process format | CJS bundle (esbuild) | ESM `.mjs` | Sources stay as imported. The shell's main process is one esbuild **ESM** bundle that includes both modules, so the per-app format no longer matters. |
| `pdfjs-dist` | ^6.4 | ^4.10 | **4.10.38** everywhere. pdf.js 6.4 passes BookScout's unit tests but hard-crashes the Electron app when it reads a PDF; only the desktop e2e suite shows it. Revisit later with that suite as the gate. |
| Layout | `electron/` + `src/shared` + `src/renderer` | workspaces | workspaces; MDEdit becomes `@cadrel/write` now and is split into `manuscript`, `export` and `mod-write` as the shell takes over |
| Project concept | folder + `.mdedit/project.json` in a Root Folder | library root, books keyed by ASIN | **Book record** (see 3) that owns a working folder |
| Chrome | custom title bar, menu bar, dialogs, tokens, dark mode | views, charts | one design system, `@cadrel/ui`, from both |
| App services | settings, drafts, single instance, file association | logging, updater, token | shared shell services |

Lessons from the import, kept as rules: dependencies are found through Node resolution, never by a package-local `node_modules/...` path (npm hoists them); and a test that skips when its environment is missing must **fail in CI** instead (the Electron e2e and PDF tests did exactly that and hid two real problems).

## 2. Desktop first, with a vault (the PDM model)

> Files, **file kinds** (manuscript, character, worldbuilding, outline, premise…), the per-user *active manuscript* flag, SQLite's three roles, and who may share what are in [FILES.md](FILES.md).

Cadrel is a normal desktop app working on **real files in real folders**, the way SolidWorks PDM does. A server **vault** holds the master copy of every controlled file, its version history and its metadata; each person has a **local working folder** (a cache of the vault). The server decides who may change what.

```
 Desktop app (Electron)                                  Cloudflare
 ┌──────────────────────────────┐   HTTPS   ┌────────────────────────────────────┐
 │ Modules (React)              │◄─────────►│ Worker (API, permissions, workflow)  │
 │ StudioService (local)        │           │   D1: records, versions, locks,      │
 │ Local SQLite cache + index   │           │       workflow state, audit          │
 │ Working folder (plain files) │──direct──►│   R2: file contents (content-addressed)│
 └──────────────────────────────┘ signed URL└────────────────────────────────────┘
```

### Check-in / check-out (the rules)

| State | What it means locally | What the server holds |
|---|---|---|
| **Not local** | file is in the vault, not downloaded | file + versions |
| **Latest (read-only)** | local copy matches the newest version; the file is read-only on disk | no lock |
| **Checked out by me** | writable; edit with Cadrel or any external tool (Photoshop, Word) | a lock: who, which machine, since, which version it was taken from |
| **Checked out by someone else** | read-only; shows who has it and since when; can be viewed, not changed | their lock |
| **Local copy out of date** | a newer version exists; **Get latest** | newer version |

- **Check out** is a server decision made atomically: it succeeds only if nobody holds the lock (a conditional update in D1). It needs a connection. Working offline means checking out first, then editing on the plane.
- **Check in** uploads the file to R2 (direct to storage by signed URL, not through the Worker), writes a new version with a comment, releases the lock, makes the local file read-only again.
- **Undo check-out** discards local changes, releases the lock, and restores the vault version.
- **Get latest** refreshes read-only local copies; files nobody is editing are never silently overwritten.
- **Admin force** (`vault.force` capability): an administrator can release someone else's lock. The holder's uncommitted work is **not** in the vault, so it is **lost to the vault**: the holder's file becomes an orphan flagged "lock removed by <admin> on <date>", kept on their disk and never deleted, and can be saved as a new file or merged by hand. The admin must confirm, the action is audited, and the holder is notified. This is the only way to break a lock.
- **Permissions and workflow can make files read-only in some states** (as PDM does): once an edit pass or a cover is *Approved*, further changes need a transition that someone with the right capability performs.

### Workflow = lifecycle

A PDM workflow is **states, transitions, conditions and actions**. Cadrel's book lifecycle (concept → story → manuscript → creative → launch → published) and each document's review states (draft → in review → approved) are workflows of this kind:

- A **transition** has who may perform it, conditions (the brief exists, the edit pass is approved), and actions (notify the next role, unlock the next stage, create tasks from a template).
- Workflows are **data**, editable by the studio, not code, so each project type can have its own.
- Each file or record sits in exactly one state of its workflow; the state decides what is read-only and who sees it.
- **Projects and subprojects hold the stage.** Several workflows can exist; each level (project, subproject) has its own default, so a series can use a different workflow from its books. The workflow is chosen when a project is created and **never changed afterwards**; the stage moves only through a gate-checked move. Gate conditions read the project (a manuscript is linked, no open notes under it, it has subprojects, its subprojects are all done). Write has no statuses of its own: Cadrel hands it the project's stage, read-only, and a stage of kind "review" turns on Write's editing pass.

### Metadata and references

- **Data cards**: typed metadata on a file or record (book, edition, pen name, brief kind, licence, trim size) editable in the app, searchable, and used by Preflight and Catalogue.
- **References and where-used**: a file can reference others (a cover references its source PSD and fonts; an EPUB references its manuscript version and cover). "Where used" answers *which listing, ad and banner use the old cover* without any manual register. A reference is to a specific version or "latest", and updating it is proposed, never automatic.

### Layers on the desktop (so the server can change)

The renderer talks to a `StudioService` through a transport interface. Two implementations exist:

- **Local vault** (M0–M1): service, SQLite and working folders on one machine; no server. This is what runs before Cloudflare is connected and is what the tests use.
- **Cloud vault** (M2): same service API, backed by the Worker. The local SQLite becomes a cache and search index.

Domain code (`kernel`: rules, permissions, workflow) is **runtime-neutral TypeScript** with no `node:` imports so it runs in Electron and in a Worker unchanged. The `store` interface is **async** so `node:sqlite` and D1 both implement it.

### Cloudflare components

| Piece | Role |
|---|---|
| **Worker** | API, authentication, permission checks, workflow transitions, issues signed R2 URLs, serves the update feed |
| **D1** | records, versions, locks, workflow state, audit log (same SQLite schema as the desktop cache; migrations shared) |
| **R2** | file contents, content-addressed (hash), including manuscripts, assets, captures, installers |
| **Durable Object** (only if needed) | live presence and push notifications ("your lock was removed", "new version"); locks themselves do not need it |
| **Cloudflare Access / tokens** | sign-in for staff; invite tokens for guests (decide in the spike) |

**Deployment** goes through GitHub Actions in the same dev/main flow as the app: a merge to `dev` deploys the `cadrel-api-dev` Worker with its own D1 and R2 (`cadrel-dev-*`), a merge to `main` deploys `cadrel-api` (`cadrel-*`). Cadrel's resources are separate from the account's existing projects.

To confirm in the M2 spike before committing: D1 database size and row limits, Worker request-body limit (why large files go straight to R2), signed-URL flow from Electron, and lock atomicity under concurrent check-outs. Cloudflare tooling is not yet connected to my session, so none of this has been run against the account.

### Shared captures

Captures are **append-only, content-addressed files**, so they sync with no locking: the capturing machine uploads the raw page and cover to R2 after the existing scrub step, other machines download them, and each machine rebuilds its own derived index and embeddings locally (BookScout's existing `rebuild()`), so research stays fast and works offline. The scrub step is a hard requirement of sharing: captures come from a logged-in browser and must be stripped of the capturer's name, address and session ids before anything leaves the machine; its plant-and-assert tests move with the code.

### Compatibility rule

Client and server carry a schema version. A client refuses to talk to a newer server and is offered the update, which the server hosts in R2 so the team stays on one version. The installer must be code-signed before a second person installs it.

## 3. Core records (kernel)

Everything has a `studio_id` from day one (organisational boundary), a UUIDv7 id, `created/updated` stamps and actor, and every change is appended to an audit log in the same transaction. The audit log is also what the Decision ledger, version history and later sync read.

**Projects** (built, `@cadrel/kernel` `projects.ts`)
- A **project** is the first-class object the whole suite is organised around: `project(id, parent, name, kind, status, order)`. A project holds **subprojects** to any depth. `kind` is a free label, not a type: the convention is a Series as a project with each Book a subproject, but a standalone novel, a box set, an anthology, "Marketing 2027" or a book with its own subprojects fit the same shape, and nothing in the code depends on the label.
- Modules own *records* and **link** them to a project (`link(project, module, ref)`): a Write manuscript folder, a Market category, later a cover brief, a royalty statement. A record belongs to one project; linking again moves it. A project's figures (words, goals, open notes) roll up from its whole subtree.
- Rules: names are unique among siblings; a project cannot move into its own subtree; archiving archives the subtree and restoring needs an active parent; deleting needs `cascade` when there are subprojects, and removes the notes written on it but never a module's records. A damaged file is repaired on load (orphans go to the top level, cycles are cut), never fatal.
- Permissions follow the tree: the scope of a role assignment is the studio, a project (which includes everything below it), or a file. The old IP / series / book scope kinds are projects with those labels.
- Stored today in one file, `studio.json` beside the app settings (the app and the AI server both use it; each change re-reads then replaces the file atomically). In M1 it becomes the `project` table in the store and syncs through the vault.

**Notes** (built, `@cadrel/kernel` `notes.ts`)
- MDEdit's Notes (comments and suggestions; people and AI; topics; replies; resolve; the 1,000-open-AI-notes cap) generalised: a note is about a `NoteTarget(module, kind, id, label, optional text anchor)` on a project, so any module gets Notes by naming its records. Market categories and books, a cover brief or a royalty statement need no Notes code of their own.
- Today Write keeps its manuscript notes in review files beside the manuscript. That is an interim state: Google Drive is only for **beta readers** (people with no Cadrel account), and sharing among Cadrel people is by roles, so manuscript notes move into the Notes store, anchored by file id, and the review-file format becomes the exchange format with beta readers (see [FILES.md](FILES.md)). The studio-wide list **reads** them (they carry `source: module`) rather than copying them; they are changed in Write, everything else is changed in the shared Notes panel. A note on a record that is linked to a project belongs to that project.
- One Notes panel (`NotesPanel`) serves a project, a record and the whole studio.

**Global controllers in the shell.** Things that belong to the whole app are set once, in the shell, and pushed into the modules: the **MCP server** (one, `@cadrel/mcp`), **the user** (profile and attached files; [FILES.md](FILES.md) §5a), **projects and notes**, the **appearance** (light/dark and colours; Write already spoke this model, Market has its colours mapped onto its own variable names), and where data lives. Write's own Appearance settings point to Cadrel's. Candidates for the same treatment later: Google Drive account, update channel, the capture server, the audit log.

**People and access**
- `studio`, `person`, `membership(person, studio, kind: employee | contractor | guest)`, `role`, `role_assignment(person, role, scope)`.
- `pen_name(person(s), display name)`: a credited identity, separate from the person.

**IP and catalogue** (built: `kernel/src/catalogue.ts`, migration `0003_catalogue.sql`)
- `ip`: a property the studio develops (a world / concept). Has many series.
- `series`, `book` (a title: standalone, or at a position in a series; `work` is folded into it, since its formats are its editions), `edition(book, format, asin, isbn, price, dates)`. Archived, never deleted, in M1.
- BookScout already has `work`, `book(asin)`, `own_book(asin)`: `edition.asin` is the join to market and sales data. This is the "connected book record".

**Vault**
- `vault_file(path, workflow, state, current_version)`, `file_version(hash, size, author, comment, n)`, `checkout(file, person, machine, since, base_version)`, `reference(parent, child, version | latest)`, `datacard_value(file | record, field, value)`.
- `workflow`, `state`, `transition(from, to, who, conditions, actions)`.

**Workflows** (built: `kernel/src/workflow.ts`, migration `0005_workflow.sql`)
- `workflow(name, is_default, template_key)`, `workflow_stage(key, name, position, category, color)`, `workflow_transition(from_key, to_key, conditions)` and `workflow_transition_role(transition_id, role_id)`. One default per studio; `book.workflow_id` and `book.stage` (a stage key). The shipped default is MDEdit's stages. Gate conditions are checked from the catalogue; approval, progress and task conditions arrive with those records.

**Production**
- `task(project_id, kind task|deadline, title, assignee, due, state)` and `task_dependency` (migration 0007; a deadline is a task with a date).
- `brief(kind, project, body, version)`: manuscript, edit, cover, blurb, campaign.
- `approval(project_id, label, required, state)` with `approval_approver(person, response, reason)`, and `decision(project_id, title, context, outcome, supersedes_id)` (the append-only ledger). Approvals are of a project under a label for now; approvals of a specific file version come with the vault. A workflow gate's `approved` condition reads the labels a project currently stands approved under.
- manuscripts and art are vault files with versions (above); `asset` adds purpose, channel, licence and approval on top of a vault file.
- `comment` anchored to a document passage or an asset region, with `resolution`.

**Editorial** (M3): `edit_pass(kind: developmental | line | copy | proof, version, editor, state)`, `query(anchor, author response)`, `change_decision(accept | reject | defer, reason)`.

**Canon** (M4): `canon_entry(kind: character | place | rule | event | term)`, `fact(entry, text, source passage anchor, status: proposed | canon)`, `proposal(by, change, reviewer)`.

**Business** (M7). Four separate tables, never one:
- `contribution` (who did what on what)
- `credit` (how someone is named, where)
- `rights` (who owns or licenses what, restrictions)
- `revenue_share` (percentages, advances, bonuses)

This separation is a standing requirement: credit is not ownership, contribution is not share. The schema exists from M1 even though the screens arrive in M7.

**Market and sales:** the BookScout library schema (captures, snapshots, ranks, lists, keywords, KDP reports, royalty months, payments, `person`, `book_split`) moves into the `market` and `sales` packages. Its `person` and `book_split` tables are replaced by kernel `person` and `revenue_share` in M7, with a migration.

## 4. Permissions

Role-based, scoped, additive and fully explainable, configurable by administrators from first launch, with sensible default roles. The full design (capabilities, roles, scopes, confidential projects, security policy, default role matrix, guardrails) is in [PERMISSIONS.md](PERMISSIONS.md). In short: `can(actor, capability, resource)` is one pure function, run on the server for every request and mirrored in the app for the interface; the Owner bootstraps the studio and everything after is configuration.

## 5. Modules: how packages join the suite

A module is a workspace package that exports a manifest. The shell loads manifests; nothing else is hard-wired.

```ts
interface ModuleManifest {
  id: string;                       // 'write', 'market', 'assets', ...
  name: string; icon: string;
  nav: NavEntry[];                  // left-rail items and routes
  requires: Capability[];           // module hidden if the actor has none
  records?: RecordTypeDef[];        // record types it owns + migrations
  widgets?: { home?: Widget[]; dashboard?: Widget[] };
  commands?: Command[];             // palette, shortcuts
  mcpTools?: McpTool[];             // exposed to the assistant, permission-checked
  jobs?: Job[];                     // background work (re-index, preflight)
}
```

**Home** (per person, role-aware): my tasks and deadlines, approvals waiting on me, queries and mentions, continue where I left off, plus each module's home widgets for my role.

**Dashboard** (studio): pipeline by lifecycle stage, calendar with capacity (the same editor on four November books), at-risk deliverables, and, only for those allowed, finance and market snapshots. Widgets come from modules, so a new module appears on the Dashboard without shell changes.

### Package map

| Package | Contents | From |
|---|---|---|
| `kernel` | records, lifecycle and gate rules, permissions, audit | new |
| `store` | async SQL interface, `node:sqlite` and D1 implementations, migrations, change log. Built: the file-backed implementation over the Worker's own migrations; D1's is the Worker's | new, BookScout's migration approach |
| `service` | `StudioService`, actor context, transports. Built: the catalogue behind `can`, in-process; the Worker transport is M2 | new |
| `vault` | working-folder manager, check-out / check-in, file status, sync with the Worker | new (M1 local, M2 cloud) |
| `worker` | Cloudflare Worker, D1 and R2 bindings, migrations, update feed | new (M2) |
| `ui` | design tokens, title/menu bar, dialogs, tree, tabs, charts, dark mode | MDEdit chrome + BookScout charts |
| `shell` | Electron main/preload/renderer, nav, Home, Dashboard, settings, updater | both |
| `manuscript` | chapter engine, words, tree, find, progress | MDEdit `src/shared` |
| `export` | EPUB, DOCX, print PDF, matter, trim, fonts, epubcheck harness | MDEdit `src/shared/export`, `electron/export` |
| `mod-write` | editor UI, tabs, drafts, Book Details | MDEdit `src/renderer` |
| `market` | parsers, analysis, keywords, community, search/chunks | BookScout `core`, `library` |
| `capture` | loopback ingest server, token, Chrome extension | BookScout `server`, `extension` |
| `text` | extraction, OCR, text statistics | BookScout `text` |
| `sales` (module: **Finance**) | KDP import, royalties, splits, payments, payouts; moves out of Market in M1 | BookScout `library/sales` |
| `studio` | the project tree and notes store (one file, shared by the app and the AI server), Write notes reader | new |
| `mcp` | one server, actor-scoped, tools registered by modules | BookScout `mcp` |
| `mod-*` | one UI package per further module | new |

### Existing code is imported, not rewritten

Both repos are copied in at a pinned commit (recorded in `docs/PROVENANCE.md`), their tests come with them, and they are reshaped package by package. The original repos stay as archives. Behaviour must not change during M0; the test suites are the proof.

## 6. Files on disk

```
%USERPROFILE%\Cadrel\
  vault\<studio>\             the working folder: real files, laid out by book
    <Series>\<Book>\Manuscript\*.md, Art\*.psd, Launch\*, ...
  .cadrel\                    local cache: studio.db, downloaded blobs, orphaned locks
  market\                     BookScout library (raw pages append-only; synced; index rebuilt locally)
  exports\
```

The vault folder is an ordinary folder: Explorer, Photoshop and Word open its files. Read-only attributes show lock state. It must not be inside OneDrive or Dropbox (the app warns, as MDEdit does). The MDEdit project template becomes the book folder template.

## 7. The assistant (MCP)

*Interim (shipped in 0.2):* `packages/mcp` composes each module's tool set (`registerWriteTools`, `registerMarketTools`) into one stdio server, run by the app's own runtime (`ELECTRON_RUN_AS_NODE=1`). Identity and permission filtering arrive with the vault server.

The interim server carries three parts: **studio** (`studio_projects`, `studio_create_project`, `studio_update_project`, `studio_link`, `studio_notes`, `studio_add_note`, `studio_update_note`), **Write** (MDEdit's tools and editing prompts unchanged) and **Market**. The assistant can organise projects (create, rename, move, link, archive) but has no delete; its notes are labelled with the AI's name and marked as AI; `studio_notes` lists notes across every module, including the review notes inside manuscripts.

One MCP server for the suite. Every call carries the user's identity, and tools are registered per module and filtered by permission, so an assistant can never see more than the person using it.

- **Read** tools return structured results with source ids so answers cite evidence (manuscript version and passage, asset version, capture date).
- **Write** tools are marked non-read-only (clients ask first), and the default write is a **proposal**: a canon change, a task assignment, a drafted brief goes to a human to accept. The assistant does not change canon, approve artwork, publish, or commit spend.
- **Confidential projects can disable assistant access** to their text entirely (manuscripts leave the machine when a hosted model reads them).
- Third-party text from Amazon and reviews is always labelled as quoted data, as BookScout already does.

## 8. Testing

Carried over: unit tests per package, fake-API renderer tests (MDEdit), real-Electron integration and a packaged-app smoke test (both), epubcheck / LibreOffice / poppler checks for exports (MDEdit). Added: the permission matrix as a table-driven test, migration tests from each repo's real data layout, and two-client scenarios against an in-process server (author and editor, guest isolation). CI builds the Windows installer and smoke-tests it on every PR; the placeholder in `scripts/build.sh` is replaced in M0.
