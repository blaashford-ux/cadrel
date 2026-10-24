# Cadrel architecture

Cadrel is a Windows desktop suite for running a book studio: one app, one installer, one set of shared records, with each discipline (writing, editing, art, launch, market research, sales, business) as a **module** inside it. It is built from [MDEdit](https://github.com/blaashford-ux/MDEdit) and [BookScout](https://github.com/blaashford-ux/bookscout), harmonised, plus new modules. The scope and build order are in [PLAN.md](PLAN.md).

## 1. Stack (unchanged from MDEdit and BookScout)

| Layer | Choice | Note |
|---|---|---|
| Shell | Electron + React 18 + Vite 5 + TypeScript | Windows installer via electron-builder (NSIS) |
| Repo | npm workspaces monorepo, `@cadrel/*` packages, ESM | BookScout's layout |
| Tests | vitest everywhere, real-Electron integration tests, fake-API pattern for renderer tests | both apps already do this |
| Structured data | SQLite through built-in `node:sqlite` (FTS5, `sqlite-vec` extension) | no native module to rebuild |
| Bulk data | Plain files on disk (manuscripts, assets, raw captures) | nothing locked in; Explorer, git and sync keep working |
| AI | MCP server over stdio (official TypeScript SDK) | one server for the whole suite |
| Editor | Milkdown Crepe (Markdown, WYSIWYG) | MDEdit |
| Export | EPUB, DOCX (`docx`), print PDF (Paged.js in Electron) | MDEdit |
| Capture | Chrome MV3 extension posting to a loopback server | BookScout |

New backend code (studio server) is also Node + TypeScript so that domain code is shared, not rewritten.

### Harmonisation items (checked against the two repos)

These differ today and must be settled in M0:

| Item | MDEdit | BookScout | Cadrel |
|---|---|---|---|
| Electron | 33 (Node 20) | 44 | **44.** `node:sqlite` needs a newer Node than Electron 33 ships, so the suite cannot stay on MDEdit's version. |
| Main-process format | CJS bundle (esbuild) | ESM `.mjs` | **ESM** |
| `pdfjs-dist` | ^6.4 | ^4.10 | **one version**, chosen by whichever passes both apps' PDF tests |
| Layout | `electron/` + `src/shared` + `src/renderer` | workspaces | **workspaces**; MDEdit's `shared` becomes packages |
| Project concept | folder + `.mdedit/project.json` in a Root Folder | library root, books keyed by ASIN | **Book record** (see 3) that owns a working folder |
| Chrome | custom title bar, menu bar, dialogs, tokens, dark mode | views, charts | one design system, `@cadrel/ui`, from both |
| App services | settings, drafts, single instance, file association | logging, updater, token | shared shell services |

## 2. Topology: one codebase, two transports

The decision that is expensive to retrofit: **every read and write goes through a `StudioService` that takes an `actor` (who is asking) and checks permission.** Modules never touch the database directly.

```
Renderer (React modules)
      │  typed API (transport interface)
      ▼
 ┌─ in-process transport ──────────┐      ┌─ network transport (M2) ─────────┐
 │ Electron main hosts the service │  or  │ HTTPS + WebSocket to Studio server│
 └────────────┬────────────────────┘      └────────────────┬──────────────────┘
              ▼                                            ▼
        StudioService  →  kernel (rules, permissions)  →  store (SQLite + blobs)
```

- **Local studio (M0–M1):** the service runs inside the app. One person, one machine, behaves like MDEdit and BookScout today. This is also how the app runs offline for market research.
- **Studio server (M2):** the same service packages run as a small Node process the studio hosts (a VM or a machine in the office). Clients connect to it. SQLite on the server is sufficient for a studio of tens of people (one writer, WAL, backed up with Litestream-style replication); the `store` interface keeps Postgres possible if that ever stops being true.
- **No real-time co-editing.** Manuscripts use **check-out / check-in** at chapter level: the author works in a local working copy (a normal folder of Markdown, as in MDEdit), checks in a new version, and the editor works on a named version. This matches how editorial passes work (a pass is against a specific version) and avoids CRDT complexity. Revisit only if users ask.
- **Market data is not collaborative-write.** The BookScout library (raw pages, covers, derived index) lives on the analyst's machine and is published to the studio as read-only snapshots and aggregates; the studio server stores the results other roles need (comps, category reports, sales), not the raw archive.
- **Sync folders:** SQLite databases and the working root must not live in OneDrive/Dropbox (MDEdit's rule: default root is `%USERPROFILE%\Cadrel`, not Documents). The app warns, as MDEdit does.

### Compatibility rule

Client and server both carry a schema version. A client refuses to talk to a newer server and offers the update; the server hosts the update feed so the team stays on one version. (Neither app has code signing or a team update channel today; both are needed before a second person installs it, see PLAN risks.)

## 3. Core records (kernel)

Everything has a `studio_id` from day one (organisational boundary), a UUIDv7 id, `created/updated` stamps and actor, and every change is appended to an audit log in the same transaction. The audit log is also what the Decision ledger, version history and later sync read.

**People and access**
- `studio`, `person`, `membership(person, studio, kind: employee | contractor | guest)`, `role`, `role_assignment(person, role, scope)`.
- `pen_name(person(s), display name)`: a credited identity, separate from the person.

**IP and catalogue**
- `ip`: a property the studio develops (a world / concept). Has many series.
- `series`, `work` (a title across formats), `book` (a work's place in a series), `edition(book, format, asin, isbn, price, dates)`.
- BookScout already has `work`, `book(asin)`, `own_book(asin)`: `edition.asin` is the join to market and sales data. This is the "connected book record".

**Production**
- `project(book | series | initiative, lifecycle, status)`, `stage`, `gate(criteria)`, `deliverable(owner, due)`, `task`, `dependency`.
- `brief(kind, project, body, version)`: manuscript, edit, cover, blurb, campaign.
- `approval(subject, version, decider, outcome, conditions)` and `decision(context, subject, outcome, follow-ups)` (the ledger).
- `document` + `document_version(hash, parent, author, note)` for manuscripts; `asset` + `asset_version` for art; blobs are content-addressed files.
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

`can(actor, action, resource) → allow | deny` is one pure function in the kernel, tested as a matrix.

- **Roles** are bundles of capabilities (`manuscript.write`, `edit.pass.run`, `asset.approve`, `finance.read`, …). Built-in: Studio director, Series lead, Author, Editor, Art director, Designer, Marketing manager, Analyst, Finance, Guest. A person can hold several.
- **Scope** limits where a role applies: studio, IP, series, or one book.
- **Guests** (freelance proofreader, illustrator, sensitivity reader, beta reader) get grants on specific records only and see nothing studio-wide.
- **Confidential projects** are hidden from anyone without an explicit grant, including studio-wide roles.
- **Sensitive data** (contracts, revenue shares, costs, profit) needs its own capability; a Series lead does not get it by default.
- **Approvals are configurable** per project and decision type, so minor choices do not need a ceremony.

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
| `store` | `node:sqlite`, migrations, blob store, change log | new, BookScout's migration approach |
| `service` | `StudioService`, actor context, transports | new |
| `server`, `client` | studio server, network transport, offline queue | new (M2) |
| `ui` | design tokens, title/menu bar, dialogs, tree, tabs, charts, dark mode | MDEdit chrome + BookScout charts |
| `shell` | Electron main/preload/renderer, nav, Home, Dashboard, settings, updater | both |
| `manuscript` | chapter engine, words, tree, find, progress | MDEdit `src/shared` |
| `export` | EPUB, DOCX, print PDF, matter, trim, fonts, epubcheck harness | MDEdit `src/shared/export`, `electron/export` |
| `mod-write` | editor UI, tabs, drafts, Book Details | MDEdit `src/renderer` |
| `market` | parsers, analysis, keywords, community, search/chunks | BookScout `core`, `library` |
| `capture` | loopback ingest server, token, Chrome extension | BookScout `server`, `extension` |
| `text` | extraction, OCR, text statistics | BookScout `text` |
| `sales` | KDP import, royalties, payments, payouts | BookScout `library/sales` |
| `mcp` | one server, actor-scoped, tools registered by modules | BookScout `mcp` |
| `mod-*` | one UI package per further module | new |

### Existing code is imported, not rewritten

Both repos are copied in at a pinned commit (recorded in `docs/PROVENANCE.md`), their tests come with them, and they are reshaped package by package. The original repos stay as archives. Behaviour must not change during M0; the test suites are the proof.

## 6. Files on disk

```
%USERPROFILE%\Cadrel\
  studio.db                  records (source of truth for structured studio data)
  blobs\                     content-addressed files (versions, assets)
  workspaces\<book>\         working copies a person edits (plain Markdown folders, MDEdit style)
  market\                    BookScout library (raw pages append-only, derived index rebuildable)
  exports\
```

Split of truth: **studio records and versions are authoritative in `studio.db` + `blobs`**; **market and sales indexes stay derived-and-rebuildable from their files**, as in BookScout. A working copy is a checkout, not the master.

## 7. The assistant (MCP)

One MCP server for the suite. Every call carries the user's identity, and tools are registered per module and filtered by permission, so an assistant can never see more than the person using it.

- **Read** tools return structured results with source ids so answers cite evidence (manuscript version and passage, asset version, capture date).
- **Write** tools are marked non-read-only (clients ask first), and the default write is a **proposal**: a canon change, a task assignment, a drafted brief goes to a human to accept. The assistant does not change canon, approve artwork, publish, or commit spend.
- **Confidential projects can disable assistant access** to their text entirely (manuscripts leave the machine when a hosted model reads them).
- Third-party text from Amazon and reviews is always labelled as quoted data, as BookScout already does.

## 8. Testing

Carried over: unit tests per package, fake-API renderer tests (MDEdit), real-Electron integration and a packaged-app smoke test (both), epubcheck / LibreOffice / poppler checks for exports (MDEdit). Added: the permission matrix as a table-driven test, migration tests from each repo's real data layout, and two-client scenarios against an in-process server (author and editor, guest isolation). CI builds the Windows installer and smoke-tests it on every PR; the placeholder in `scripts/build.sh` is replaced in M0.
