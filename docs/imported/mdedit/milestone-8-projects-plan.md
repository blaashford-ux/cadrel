# Milestone 8 — Projects

Status: **in progress (0.3).** Decisions are recorded in section 8; sections 9–10 cover export defaults / overrides and goals / progress tracking.

## 1. The idea

Today the app opens "a folder". From 0.3 it works out of a **Root Folder** that contains **Projects**. A project is still
an ordinary folder with subfolders and Markdown files (nothing is locked in; Explorer, git and sync keep working), but the
app treats it as a first-class thing: it is created from a **template**, listed on a Projects home screen, switched between
quickly, and carries a little metadata.

```
C:\Users\you\MDEdit\                 ← Root Folder (default; chosen at first run, changeable in Settings)
├── The Lost King\                   ← Project   (has .mdedit\project.json)
│   ├── Manuscript\
│   ├── Characters\
│   ├── Worldbuilding\
│   ├── Research\
│   └── Exports\
└── Short Stories\                   ← Project
```

## 2. Data model

| Thing | Where | Contents |
|---|---|---|
| Root folder, templates, default template, last project | app `settings.json` | `rootFolder`, `templates[]`, `defaultTemplateId`, `lastProject` |
| Project marker | `<project>\.mdedit\project.json` | `version`, `id`, `name`, `templateId` + template name, `createdAt`, optional `status`, `notes` |
| Template | in settings | `id`, `name`, `description`, `folders[]` (nested tree of names), optional `files[]` (starter Markdown) |

* **Recognising a project:** a direct child of the Root that contains `.mdedit\project.json`. Other child folders are shown
  under "Not projects" with a one-click **Convert to project** (creates the marker, changes nothing else).
* The `.mdedit` folder is hidden from the file tree. The existing `<name>.export.json` sidecars stay beside their manuscripts.
* Everything is plain JSON, written atomically, sanitised on read (same approach as Book Details), and tidied on first read.
* Built-in templates: **Novel** (Manuscript, Characters, Worldbuilding, Research, Exports), **Series** (Manuscripts, Series Bible…),
  **Short Story** (Drafts, Notes, Exports), **Blank** (no subfolders). Editable; "Reset to defaults" restores them.

## 3. What the user sees

1. **First run** (and upgraders): a welcome dialog — choose the Root Folder (default shown, Browse…, "Create it for me"),
   optionally create a first project, then done. Upgraders from 0.2 are offered to adopt their last folder as a project
   (see question 2).
2. **Projects home** (the sidebar when no project is open; also reachable any time): rows or cards with name, template,
   word count, last edited, status chip; search, sort (recent / name), **New Project** primary button, empty state that
   shows the templates. Right-click: Open, Rename, Duplicate, Show in Explorer, Archive, Delete.
3. **Inside a project:** the sidebar header is a **project switcher** (name + ▾ → recent projects, "All projects…",
   "New project…"); the title bar shows `Root › Project`. The existing tree, tabs, chapters, export and find all work
   unchanged inside the project. **Ctrl+K** opens a quick switcher (type to filter projects, Enter to open).
4. **New Project modal** (File → New Project…, home button, switcher): Name (live validation), Template (dropdown with a
   live preview of the folders it will make), live path preview ("Creates C:\Users\you\MDEdit\The Lost King"), Create /
   Cancel. Collisions ("a project with that name exists") and Windows name rules are explained inline. On success the
   project opens with its first useful thing selected.
5. **Settings → Projects:** Root Folder (path, Change…, Open in Explorer, what-happens-to-existing-projects notice);
   **Project Templates** editor — list on the left (add, duplicate, delete, set default, reset), on the right the name,
   description, and a **folder tree editor** (add child, rename, drag or ↑/↓ to reorder, remove) with a live preview and
   inline name validation; optional starter files. Also "reopen last project at launch".
6. **Project properties** (right-click → Properties): name, template, created, size, word count, status, notes;
   "Add missing template folders" and "Save this structure as a template".

## 4. Behaviour rules that matter

* Creating a project is all-or-nothing: made in a temp name and renamed, or rolled back on error; never half a project.
* Rename renames the folder and the marker together; open tabs, session and drafts follow (the workspace already remaps paths).
* Delete goes to the Recycle Bin after a **type the project name** confirmation; unsaved edits are resolved first.
* Switching projects uses the existing Save / Don't Save / Cancel flow; each project keeps its own tabs and session.
* Root missing or unreachable (renamed, external drive, sync client): a banner on the home screen with **Choose Root…** /
  **Retry**; nothing is deleted or recreated silently.
* Changing the Root only repoints the app; **no files are moved** unless the user asks ("Move my projects there").
* Folders added or removed in Explorer appear on focus / Refresh (F5); the home list refreshes when the window regains focus.
* Windows realities handled: illegal characters, reserved names (CON, NUL…), trailing dots/spaces, case-insensitive
  clashes, long paths, OneDrive/Dropbox roots (a gentle note, not a block), read-only roots.

## 5. Code plan

Pure, unit-tested (`src/shared`): `projectTemplates.ts` (model, defaults, sanitize, validate names/tree, preview),
`projectName.ts` (Windows-safe names, collision keys), `projectMeta.ts` (marker format, migrations).
Main (`electron`): `projects.ts` (list/scan root, create from template with rollback, rename, duplicate, delete, convert,
stats), settings additions, IPC, scan change to hide `.mdedit`, root-missing detection.
Renderer: `Workspace` gains a `project` (the folder it already opens stays the workspace root), `ProjectsHome`,
`NewProjectDialog`, `ProjectSwitcher` + `QuickSwitcher`, `TemplateEditor` (Settings tab), `WelcomeDialog`,
breadcrumb in the title bar, menu items.

## 6. Build order (each step tested before the next)

* **8a** Data model + main-process project operations + migrations, with temp-folder tests (create/rollback/rename/delete/convert, name rules, template sanitising).
* **8b** Settings: Root Folder and the Template editor (live preview, validation, defaults, reset).
* **8c** New Project modal, Projects home, switcher, quick switcher, breadcrumb, menu/shortcuts; Workspace project awareness.
* **8d** First run and 0.2 migration; root-missing handling; focus refresh.
* **8e** Polish: properties, status, word counts, archive, save-as-template, docs, changelog, e2e suite, **0.3.0** release.

## 7. Tests

Unit: names and collisions, template tree validation, marker round-trip, scan classification, create with forced failure
at each step (rollback leaves nothing), rename/delete/convert on temp dirs, settings migration. Workspace tests: project
switch with dirty tabs (save / discard / cancel), rename remap, delete cleanup. E2E (real app): first run, create from
each template, edit and use a custom template, switch with unsaved edits, rename, delete (typed confirm), root change,
root missing banner, upgrade path.

## 8. Decisions

| # | Question | Decision |
|---|---|---|
| 1 | How a project is recognised | The marker file `.mdedit\project.json` |
| 2 | Existing 0.2 folders | Asked once at upgrade (adopt last folder as a project / leave it) |
| 3 | Nesting | One level: Root → Project → subfolders |
| 4 | Template contents | Folders + optional starter files **+ export defaults** (see 9) |
| 5 | Open any folder | Kept under File → Open Folder… for folders outside the Root |
| 6 | Default Root | `%USERPROFILE%\MDEdit` (not Documents, which OneDrive often redirects) |
| 7 | Changing the Root | Repoint; offer to move existing projects |
| 8 | Open projects | One at a time |
| 9 | Extras | **Status**, **per-project overrides**, **word-count goals** with **progress tracking** (see 10), archive |
| 10 | Shortcuts | New Project = Ctrl+Alt+N (File menu too); Ctrl+N / Ctrl+Shift+N unchanged; Ctrl+K quick switcher |

## 9. Export defaults and per-project overrides

Defaults cascade, most specific wins:

1. **Built-in** defaults (code).
2. **App** defaults (File → Settings): chapter heading level and the new-book template.
3. **Project template** (Settings → Projects → Templates): may carry its own chapter level and book template.
4. **Project** (`project.json` `overrides`): `chapterLevel`, and `book` — a map of only the **fields** the project sets (author,
   copyright page, front/back matter, export choices, fonts, trim size…, as `"export.pdf.chapterSink": 1`). Every other field
   follows the app. Seeded from the template's changes when the project is made; edited per field in **Project Settings**
   (each field shows "From app settings" until changed, with a Reset). Projects saved before this stored a whole book; it is
   converted to the fields it changes.
5. **Book** (`<name>.export.json`): the book's identity (title, subtitle, marked) and `overrides`, the fields the book sets itself.
   Everything else is read from the project and the app each time, so a changed project/app default reaches every book that has
   not set that field. The copyright year is pinned when the book is first set up. Excluded chapters and the cover image belong to
   the book alone. Files saved before this held a whole book; on first read they are converted (fields equal to what the book
   would inherit now follow it, the rest stay the book's own) and the old file is kept as `.v1.bak`.
6. **Export dialog** is the last check: it shows every setting with where it comes from (app / project / this book), lets you
   change or Reset any of them for this book, and lists the fields that don't simply follow the app. It opens from a file only.

The chapter heading level is per project (the workspace re-splits when you switch). Exports inside a project use that project's level.

## 10. Goals, progress and the history chart

**Goal** (per project): target words, start date, target date (optional).
**What counts:** Markdown files in the project except folders switched off (templates mark Characters, Worldbuilding, Research and Exports
as not counting; the user can toggle per folder in Project Settings).

**Tracking:** the app snapshots the project's counted word total on open, on every save (debounced) and on window focus, into
`.mdedit\progress.json`: for each local date `{ start, end }` (the first and latest total seen that day; `start` is the previous
day's `end` when there is one, so edits made while the app was closed count on the day they are first seen). Words written that day =
`end − start` (net: deletions subtract). Days the app was not used are zero days.

**Progress panel** (Project → Progress, status bar chip, Projects home cards):
* **Tiles:** total, written today, % of goal, remaining, days left, **words/day needed** to finish by the target date,
  **3-day average** and **5-day average** (calendar days up to and including today) each with an **estimated completion date**
  and "ahead / behind the target date by N days".
* **Chart (SVG, no library):** a bar per day for words written, a **burn-down** line of words remaining, the ideal straight line from
  the start total to zero at the target date, a today marker, and range buttons (14 days / 30 days / all). Hover shows the day's numbers.
* Estimates say "not enough data" for a window with no positive average; a goal with no target date shows averages and ETAs only.

## 11. Build order (supersedes section 6)

* **8a** Models + main-process project operations + progress maths (pure, heavily unit-tested) — templates, markers, names, create with rollback, rename, delete, convert, progress snapshots, averages, burn-down, ETA.
* **8b** Settings: Root Folder, Templates editor; Project Settings dialog (overrides, status, goal, counted folders).
* **8c** New Project modal, Projects home, switcher, Ctrl+K, breadcrumb, workspace project-awareness, defaults cascade into new books and the chapter level.
* **8d** First-run welcome, 0.2 migration, missing-root handling, focus refresh.
* **8e** Progress: snapshots wired to saves, the panel and chart, status chip, home cards.
* **8f** Polish, docs, changelog, e2e suite, version 0.3.0.
