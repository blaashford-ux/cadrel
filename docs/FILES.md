# Files, kinds and sharing

How Cadrel keeps a project's files, how it knows what each file *is*, and who can share what with whom. Read with [ARCHITECTURE.md](ARCHITECTURE.md) (the vault, §2 and §6), [PERMISSIONS.md](PERMISSIONS.md) and [PLAN.md](PLAN.md).

**Status: design. None of this is built yet.** Today Write still keeps MDEdit's `.mdedit/project.json` and its Google Drive sync, and the shell's project tree only *links* a Write folder. What exists now is called out under [Where we are](#where-we-are).

## 1. Decided

These come from the product owner and are not open for redesign here.

1. **Sharing inside Cadrel is Role-Based Access.** People signed in to Cadrel share through the vault and their roles (see PERMISSIONS.md). **Google Drive is for beta readers only**: people with no Cadrel account who need to read a manuscript and send comments back.
2. **Project folders and files are local and synced by Cadrel.** Each person works on real files in a local folder; the vault (Cloudflare, later) keeps the master copies, versions and locks.
3. **Pure text is `.md`.** Anything a person writes as prose (manuscript, outline, premise, character sheet, worldbuilding) is a Markdown file that any editor can open.
4. **Cadrel, and every MCP tool, must know what kind of file each one is**: manuscript, worldbuilding, character, outline, premise, and so on. MDEdit does this only in part, in `project.json`; Cadrel may also use SQLite.
5. **Active Manuscript is a local, per-user flag.** It is not shared project data.

## 2. Sharing: who gets in, and how

| Person | How they get in | What they can do | Where their work lives |
|---|---|---|---|
| **Team member** (employee, contractor with an account) | Cadrel sign-in; roles and scopes | whatever the roles give: check out and edit, comment, approve | the vault; Notes are native records |
| **Freelancer / guest** | Cadrel account with the **Guest** role, scoped to books or files, expiring | read, comment, or edit exactly what was granted | the vault |
| **Beta reader** (no account) | a **Google Drive review package** (a link to a read-and-comment copy) | read and comment; nothing else | their comments come back as a review file that is **imported into Notes** |

What this removes from MDEdit's model once the vault exists:
- **Drive as the way a team shares a project** (MDEdit's "collaborator" share with edit rights, and the *Shared With Me* folder). Colleagues are Cadrel people; there is nothing to share by link.
- **Drive as whole-project sync** between a person's own machines. The vault does that. *Open question 2 covers the phone app and a solo author with no server.*
- The "final sync on quit" pass.

What stays: building a **review package** for a beta reader, and importing the review file they return. After import their comments are ordinary Notes (`origin: external`, with the reader's name), so the author deals with them in the same panel as everything else.

Notes written by Cadrel people are **records in the studio** (anchored to a file by its id), no longer files beside the manuscript. The review-file format stays as the **exchange format with beta readers**. (Write's manuscript notes are read from review files today; moving them into the Notes store is part of M1.)

## 3. Files on disk

The working folder mirrors the project tree (ARCHITECTURE §6): a project's files sit in its folder, and each subproject is a subfolder.

```
<working root>\<Series>\                   project: Dragon Rider           (kind label: Series)
    Series Bible\*.md                      files of this project
    <Book 1>\                              subproject: Book 1              (kind label: Book)
        Manuscript\Draft 1.md
        Characters\Mira.md
        Worldbuilding\Dragons.md
        Outline.md   Premise.md
        Research\*.pdf   Art\cover.psd   Exports\
    <Book 2>\ ...
```

Rules:
- **Text people write is `.md`.** Pure text carries **no required front matter**, no sidecar and nothing Cadrel-specific inside it. A file stays valid Markdown and survives being opened in any tool.
- **Other files are what they are** (`.psd`, `.pdf`, `.docx`, images). They get a kind and metadata like any other file.
- **Structured data that is not prose** (canon facts, tasks, approvals, notes, goals) lives in records, not in Markdown. A character *sheet* is a file; a *fact* extracted from it (M4) is a record that points back to the passage.
- **Cadrel owns moves and renames** of project folders (moving a project in the tree moves its folder). The folder is ordinary, so people can also use Explorer; Cadrel reconciles on the next scan (see identity below).
- Not inside OneDrive or Dropbox (the app warns, as MDEdit does).

### Identity

Each file has a **stable id** (a UUID in the catalog). A path is an attribute of the file, not its identity. Renaming or moving inside Cadrel keeps the id. After outside changes, a scan matches files by (content hash, size, name) before deciding something is new, so notes, goals and edited marks follow a file that was renamed in Explorer. Anything unmatched is a new file (and gets a suggested kind).

## 4. Kinds: how Cadrel knows what a file is

A **kind** is a field in the file's data card (ARCHITECTURE §2: *Metadata and references*). It is stored in the catalog, **not in the file**. A file with kind `manuscript` and a file with kind `character` are both plain Markdown on disk.

### The registry

Kinds are **data**, not code, like roles and workflows: a built-in set that studios can edit and extend. A module declares the kinds it provides or understands in its manifest.

| Property of a kind | Why it exists |
|---|---|
| `id`, `name`, `description`, `icon` | shown in the app, and **read to the AI** so a studio-defined kind explains itself |
| `prose` | is it a running text with chapters (so it has word counts, a chapter index, goals, an editor)? |
| `counts` | do its words count toward goals and dashboards? (replaces MDEdit's `excludedFolders`) |
| `exportable` | is it part of a book build (EPUB, DOCX, print)? Only manuscripts and the matter pages are. |
| `canon` | does it feed Continuity and the series bible (M4)? Characters, worldbuilding, outline, premise, and the manuscript itself. |
| `area` | the **permission area** it falls under: `manuscripts`, `canon`, `assets`, `launch`… so roles apply per kind (an Editor edits manuscripts but only comments on canon; see the matrix in PERMISSIONS.md) |
| `ai` | default assistant access: `read`, `notes` (may leave notes), or `none` |
| `ext` | file types it normally has (`.md` for every prose kind) |
| `folder` | the template folder it defaults to |

Built-in kinds (a starting set; extendable):

| Kind | What it is | prose | counts | exportable | canon | area |
|---|---|---|---|---|---|---|
| `manuscript` | the book's text; one or more drafts | yes | yes | yes | yes | manuscripts |
| `matter` | front and back matter (title page, dedication, about the author) | yes | no | yes | no | manuscripts |
| `outline` | beats, chapter plan | yes | no | no | yes | canon |
| `premise` | concept, logline, pitch, series arc | yes | no | no | yes | canon |
| `character` | a character sheet | yes | no | no | yes | canon |
| `world` | worldbuilding: places, magic, history | yes | no | no | yes | canon |
| `research` | notes and source material, md or pdf | no | no | no | no | canon |
| `style` | style sheet, voice notes | yes | no | no | no | canon |
| `brief` | cover, blurb, campaign briefs | yes | no | no | no | assets / launch |
| `copy` | blurbs, descriptions, ad text | yes | no | no | no | launch |
| `image` | a picture: cover art, a map, character art, a reference or inspiration image, a photo (PNG, JPG, GIF, WebP, SVG, TIFF) | no | no | no | no | assets |
| `asset` | a production file that is not a plain picture: layered art (PSD), fonts, design files | no | no | no | no | assets |
| `export` | generated EPUB, PDF, DOCX | no | no | no | no | manuscripts |
| `reference` | an imported file kept as is (a Word draft, a PDF) | no | no | no | no | canon |
| `other` | not classified yet | no | no | no | no | none until sorted |

### How a file gets its kind

In order, the first that applies:

1. **You set it** (file menu, new-file dialog, drag to a kind folder, or "Set kind" on several files at once).
2. **Its folder's kind**, from the project template (`Manuscript/` is `manuscript`, `Characters/` is `character`, `Worldbuilding/` is `world`). Files inherit it, and the kind of a folder is a catalog entry like any other. MDEdit's templates already have these folders; they gain kinds.
3. **On import or first scan**: a *suggestion* from where it was found, its extension, and its content (headings, front matter if it happens to have it, size). The suggestion is shown and nothing is silently filed under a guess. Until accepted it is `other`.
4. **The assistant can propose a kind**; a person accepts it. It never changes a kind by itself.

A file's front matter, if it has one (`kind: character`, or Obsidian-style tags), is read as a **hint** at step 3, never required and never written back.

*Alternatives considered:* front matter in every `.md` (self-describing, but it pollutes pure text, breaks if an editor or an AI rewrites the file, and cannot carry kinds for non-text files); a sidecar JSON per file (clutter, and drifts on rename); folder-only (no way to mark one file different, and it breaks when someone drags files around).

### Active manuscript

**Active manuscript is a local flag**, one per person per project (per subproject if they work on several books). It is stored in the user's own local database, keyed by project id and file id, and is never synced. It means only: *the manuscript my goal bar, my progress, Home's "continue writing" and Write's default view follow.*

What it does **not** mean: it is not the file that exports, not the one Preflight checks, and not what the assistant reads by default. Those use **explicit choices** (the file you picked) or, when a book has several manuscripts, the file whose **workflow state** says it is current (*Approved* or *Current draft*), and fall back to the only manuscript when there is one. To the assistant, the active manuscript is just a field on `list_files` (`active: true` for the person it is acting for).

### Export works on one chosen file

Export is never an automated pick. It exports **the file you ask for**:
- **from the open file**: Export… in the toolbar, File → Export, or Ctrl+E, all acting on the file you are in; or
- **from the tree**: right-click any file (it does not have to be open or focused) and choose Export…

If nothing is open, Ctrl+E says so instead of choosing a manuscript. The dialog states which file it is exporting and does not offer to switch. There is no "mark for export" step: a file's export settings (book details, outputs) are created the first time it is exported or its Book Details are opened. This is independent of the *active manuscript*, which has no effect on export. Today it applies to Markdown files in Write; once kinds exist, Export is offered on kinds that are `exportable` (manuscript, matter).

## 5. Shared state and personal state

| Shared (vault records, synced, permissioned) | Personal (local database, never synced) |
|---|---|
| file id, path, **kind**, title, description | **active manuscript** (per project) |
| workflow state, check-out lock | open tabs, cursor and scroll position |
| word goals and deadlines (on the manuscript record) | autosaved drafts of unsaved text |
| **edited** marks per chapter | my daily writing progress (streaks) |
| Notes and replies | sidebar width, panel layout, filters |
| project data: status, template, book details, overrides | appearance (until a studio default exists) |
| references and where-used | which files I keep downloaded |
| | my **profile** and the files attached to it, until I join a studio (§5a) |

MDEdit keeps every item above in one synced `project.json`, which is why the active manuscript there collides between people.

### 5a. The user (profile and attached files)

The **user** is one object at the shell level: the person using this copy of Cadrel. Every module can ask it who is acting; none of them owns it.

- **Profile:** display name (the name on notes, comments and approvals), email (for sign-in and invitations; never shown on notes), pen names, a short "about me", and a photo.
- **Attached files:** any file can be attached to the user (a photo, an author bio, a signed contract, a tax form). They are **copied** into Cadrel's own folder under their own ids (the original is untouched), carry a note saying what they are for, are checked against their hash so a missing or changed copy is reported, and can be opened, shown in the folder or removed. A picture can be chosen as the photo.
- **Today (local):** `user.json` and `attachments/` beside the app's settings. The shell exposes it as `window.cadrel.user`; the rail shows the photo; the **Profile** page edits it. The name replaces the old "name on notes" setting.
- **In a studio (M2):** the profile becomes the person's `person` record and the attachments become vault files that only that person and people holding `people.read` can open (contracts and tax forms are sensitive: opening them is audited like finance data). Attachments are *not* part of any project and are never exported or sent to a beta reader.
- **The assistant** may read the name, pen names and about-me (`studio_user`) so it can sign things and write in the person's voice. It never receives the email or the attached files.

## 6. SQLite

SQLite appears in three places, with one schema family.

1. **The local vault cache** (in the working root's `.cadrel/`, excluded from sync): file, kind, project, chapter index, word counts, references, notes, workflow state. It is the same schema as D1 and uses the same migrations (ARCHITECTURE §2). Before a server exists it **is** the vault ("local vault", M1); afterwards it is a cache filled from the server's change log. **The database file is never what syncs**: records sync through the Worker, files through R2.
2. **A text index** over the project's `.md` files (SQLite FTS5): fast search for `search_text` and Continuity, chapter lookup, "where is this name used". It is derived, so it can always be rebuilt from the files.
3. **The user's local database** (in app data): the personal column above.

Both the app and the MCP server open the project database (WAL mode, a busy timeout); the MCP server never writes to it directly but goes through the same service the app uses, so locks, permissions, workflow state and the audit log apply. (Today the interim server writes `studio.json` itself; that goes away with the store.)

Sketch (the real migrations land in `@cadrel/store`):

```sql
file(id, project_id, path, kind, title, hash, size, words, mtime, state, version, updated_at)
kind(id, name, description, prose, counts, exportable, canon, area, ai, ext, folder, builtin)
folder_kind(project_id, path, kind)               -- a folder's default
chapter(id, file_id, ord, heading, level, words, edited, anchor_hash)   -- derived from headings
file_ref(from_file, to_file, to_version)          -- references / where-used
note(id, project_id, file_id, chapter_id, anchor, ...)                  -- Notes, anchored by file id
-- local database only:
local_flag(user, project_id, file_id, key, value)  -- e.g. key='active_manuscript'
```

## 7. What the assistant (MCP) sees

- `list_files(project, kind?)` returns, for each file, `kind`, words, chapters, workflow state, check-out state and `active` (for the person it acts for). The existing tool grows these fields; its name and arguments stay.
- `search_text(…, kind?)` defaults to the **manuscript and canon** kinds and says which kind each hit came from; research and assets are searched only when asked for.
- The server's instructions include the **kind glossary** from the registry, so the assistant knows a `world` file is reference material, a `manuscript` file is the text it is editing, and what a studio's own kind (say *Magic system*) means.
- **The editing prompts and `add_notes` apply to manuscripts.** Canon kinds are read for context; the assistant can leave notes on them but cannot rewrite them. Each tool is also filtered by the caller's roles and the kind's `area` and `ai` setting.
- `set_file_kind` exists as a **proposal** (the change waits for a person).

## 8. Moving MDEdit projects over ("adopt")

Adoption is **copy-on-read**: Cadrel scans a project folder and builds the catalog without changing anything in it. `.mdedit/` is left untouched until the person confirms.

| MDEdit | Cadrel |
|---|---|
| `project.json`: `id`, `name`, `status`, `notes`, `archived` | the project record |
| `templateId` and its folders | folder kinds (by folder name: `Manuscript` → `manuscript`, `Characters` → `character`, …); unknown folders → `other` for review |
| `activeManuscript` | this user's **local** flag (becomes personal on adoption) |
| `manuscriptGoals` | goals on the manuscript record |
| `excludedFolders` | the `counts` property of the folders' kinds |
| `editedChapters` | per-chapter `edited` state |
| `overrides` (book details, chapter level) | the project data card |
| `.mdedit/review/*.json` | Notes (the author's, AI reviewers', and any beta reader's, by reviewer id) |
| `.mdedit/progress.json`, `drafts/` | personal local data |
| `.mdedit/shared.json`, Drive sync state | retired for team use; a Drive review share can be re-made as a beta package |

## 9. Where we are

| Item | State |
|---|---|
| Project tree, links to a Write folder, Notes across modules, one MCP server | built (0.2) |
| `activeManuscript`, `excludedFolders`, goals, edited marks in `.mdedit/project.json` | MDEdit's, unchanged; still synced by its own Drive sync |
| Write's Google Drive sync, collaborator shares, final sync on quit | present, unchanged; to be retired as described in §2 |
| file kinds, the catalog, the local flag, FTS index, adopt, kind-aware MCP tools | **not built** |

## 10. Order of work

- **M1 (shared records, local vault):** the kind registry in `@cadrel/kernel` with the built-in kinds and tests; the `@cadrel/store` catalog (SQLite, migrations shared with D1); scan and **adopt**; the local flag; the chapter index and FTS index; Write reads kinds (file tree icons, "Set kind"); MCP `list_files` / `search_text` gain `kind`; manuscript Notes move into the Notes store; the review package keeps working for beta readers.
- **M2 (vault on Cloudflare):** records sync through the Worker, files through R2; Drive whole-project sync and collaborator shares are removed; kinds feed role checks.
- **M3 onward:** beta-reader packages from the vault; editorial passes and canon use `canon` kinds.

## 11. Decisions made on this design

1. **Folder layout mirrors the project tree.** `<root>/<Series>/<Book>/…`; Cadrel moves a project's folder when the project moves. Write's project list becomes the book-level projects (projects that hold files), and "linking a Write folder" is replaced by projects owning their files.
2. **A file's kind is stored in the catalog, with folder defaults.** Files stay pure Markdown; front matter is read only as a hint.
3. **A solo author is a one-person studio on the Cadrel server**; their machines and, later, the phone app sync through it. Google Drive is not used for sync. Until the server exists, a solo author works on the local vault of one machine. The phone app waits for the server.
4. **Beta readers use Drive review packages**; the file they return is imported into Notes as external notes.

Still open (not blocking M1): when a book has several manuscript files, which one exports. The proposal in §4 is the file whose workflow state is *Current*, else the one the person picks, else the only one.
