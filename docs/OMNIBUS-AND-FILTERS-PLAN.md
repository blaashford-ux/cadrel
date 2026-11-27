# Omnibus, Set as Manuscript, and file filters

Status: **built on `dev`, not yet released** (27 November 2026). Built from one request: an omnibus creator in Write that opens a window to pick several manuscripts, pulls their Book Details, and makes one export; a **Set as Manuscript** item in the right-click menu; a **Manuscripts only** limit wherever all files can be browsed; a **project filter** on the Files tab; and a look for other places the filters would help. The decisions below were taken as recommended; none was confirmed with the owner, so each is a place to say "no, the other way".

## Decisions

1. **"Manuscript" is a setting of the project, not of the file.** It is a list (`manuscripts`) in the project's own metadata, beside the existing `activeManuscript`. Why: Write and the Files page must agree, a project's metadata already travels with the project and already names manuscripts by relative path (goals, rewrite links, edited chapters follow renames the same way), and the Studio's own file "kind" is only a permission class (every `.md` is a "manuscript" in it) so it cannot say which text is a book. Cost: a file is a manuscript only in the project whose folder it is in.
2. **Set as Manuscript is separate from Active Manuscript.** Active is one file that goals follow; a set can be any number. The active manuscript counts as set, so nobody has to mark their existing one again; taking a file out of the set also clears it as active.
3. **Pickers narrow only once a project has set any.** Editing, Canon and the Editing desk used to offer every text file (or, for the desk, the `Manuscript/` folder). With a project's set manuscripts they offer those and only those; with none set they behave as before. So upgrading empties nobody's list, and setting the first manuscript is what switches a project over.
4. **An omnibus is one composed book.** The books' Markdown is joined into one source with a title page (made like a chapter, so it is in every output's contents) before each book, plus one set of Book Details for the omnibus, and that goes through the **same export** as any book. Nothing about EPUB, print or Word was changed, so every setting and every check applies, and a later change to the export reaches the omnibus for free. Cost: the contents are flat (a book's title page is an entry among the chapters), not nested.
5. **Whose settings.** Title, subtitle, author, ISBN and cover are the omnibus's own and asked for in the window. Layout, fonts, trim and output folder come from the **first** book; front and back matter pages from the **last** (the newest also-by and about). No book's ISBN, dedication or epigraph is carried onto the omnibus's own pages. Each book's own chapters-left-out stay out.
6. **Back matter.** A manuscript often ends with its own About the Author or Acknowledgements; joined, they would repeat. Only the last book's are kept, unless the person asks for all.
7. **Remembered per project** (`omnibus` in the metadata: the books, their order, the title and options), so making it again is two clicks. It follows renames and forgets deleted files.

## Where it is

| Piece | Where |
|---|---|
| The set, the recipe, their upkeep | `write/src/shared/projects.ts` (`manuscripts`, `omnibus`, `manuscriptPaths`, `withManuscript`), `renderer/workspace.ts` (`setManuscript`, renames, deletes) |
| Composing the omnibus | `write/src/shared/export/omnibus.ts` (pure) |
| Planning and running it | `write/electron/export/run.ts` (`omnibusBooks`, `planOmnibus`, `runOmnibus`), `electron/module.ts`, `preload.ts` |
| The window, the menu, the tree filter | `write/src/renderer/OmnibusDialog.tsx`, `App.tsx`, `Tree.tsx`, `treeRows.ts` (`keepFiles`) |
| The Files page, and the pickers | `shell/src/main/vaultHost.ts` (`ManuscriptSource`, `manuscripts()`, `setManuscript`), `renderer/Files.tsx`, `main/editingDesk.ts` |

Tests: `omnibus.test.ts` (the composing, and that the result assembles into a real book), `run.test.ts` (a real EPUB of two books, with the cover), `OmnibusDialog.test.tsx` (the window), `workspace.test.ts`, `projects.test.ts`, `treeRows.test.ts` (Write: 1,331 pass); `vaultHost.test.ts`, `filesPage.test.tsx`, `editingDesk.test.ts` (Cadrel: 506 pass).

## The other places a filter would help

Looked at every place that lists files to pick or browse:

| Place | What it lists | Done |
|---|---|---|
| Write's file tree | every file in the project | **Manuscripts only** box (remembered) |
| Files page | every file of every project | **Project** filter, **Manuscripts only**, the marker, right-click Set as Manuscript |
| Editing → plan a pass | text files with a version | follows the set (decision 3) |
| Canon and continuity checks | text files with a version | follows the set |
| Editing desk | the `Manuscript/` folder's files | follows the set |
| The omnibus window | the project's manuscripts | manuscripts first; "show every Markdown file" |
| Art, concepts, Preflight | pictures, or EPUBs, of the project in view | nothing to add: already limited to the project and to the kind |

**Worth doing next, not done:**
- **Files page → "Use another file…"** (the references list on a file) offers every file in the Studio; limiting it to the same project, with a way to widen, would stop the wrong file being picked.
- **A status filter on the Files page** (checked out by me, a newer version waiting, changed without a check-out): the same row of controls, and the most common reason to open that page.
- **Write's relink dialog** lists every Markdown file in the folder for an orphaned export-settings file; manuscripts first would be quicker.
- **A "no manuscripts set" nudge** for a project with several long Markdown files and none set, since decision 3 only helps once one is set.

## Not built
Nested parts in the contents; a different layout per book; an omnibus across projects; the omnibus window and the tree filter on Android (the code is shared, but the export is desktop-only there); the assistant's file tools reading the set (they list non-manuscript files on purpose).
