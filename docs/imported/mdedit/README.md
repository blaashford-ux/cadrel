# MDEdit

Windows desktop Markdown editor for book projects: keep each book in a **project** (a folder with the subfolders you choose), browse its `.md` files, and edit them one chapter (Heading 1 by default) at a time.

## Develop
```
npm install
npm test          # chapter engine tests
npm run dev       # Electron + Vite
npm run dist      # Windows installer (run on Windows / CI)
```

## Status
- [x] **Projects** (0.3): a project is a folder with a hidden `.mdedit` marker, living in your **Root Folder** (default `%USERPROFILE%\MDEdit`, chosen on first run and changeable in Settings). The Projects home shows every project as a card (status, words, goal progress); **New Project** (Ctrl+Alt+N) makes one from a **template** — folders, starter files and export defaults, all editable in Settings → Projects. Ctrl+K switches project; rename, duplicate, archive, delete (to the Recycle Bin) and status (planning → published) are on each card. Folders outside the Root still open with File → Open Folder, and can be converted to projects
- [x] **Project settings and defaults**: each project can override the chapter-heading level and the export defaults (author, copyright page, fonts, trim size…); everything inside a project uses them. Order of precedence: built-in → app Settings → template → project → the book's own export settings
- [x] **Goals and progress**: set a word-count goal (and deadline) per project, choose which folders count; the Progress window (status bar or switcher) shows a day-by-day bar chart with a burn-down line, the words per day needed to finish on time, and the estimated finish date at your 3-day and 5-day averages
- [x] Scaffold (Electron, Vite, React, TypeScript, Vitest, CI Windows build)
- [x] Chapter engine (`src/shared/chapters.ts`): lossless split/join by heading (H1 by default; the level is a setting)
- [x] Folder picker, recursive file tree, chapters listed under each file (read-only preview)
- [x] WYSIWYG chapter editor (Milkdown Crepe), dirty tracking, Ctrl+S atomic save
- [x] Save / Don't Save / Cancel on chapter/file/folder switch and on window close
- [x] External-change detection (auto-reload when clean, conflict banner when dirty, overwrite check on save)
- [x] Reopens the last folder on startup
- [x] Change Folder and Refresh (buttons, F5, menu); custom menu without Reload
- [x] Tabs: one per open file, swapping never prompts, closing a tab with unsaved edits does
- [x] Remembers folder, open tabs, expanded folders, sidebar width, window size/position and theme
- [x] Window title and status bar (chapter n of m, word count, saved state, line endings)
- [x] Dark mode (follows Windows; View > Theme to override)
- [x] Chapter navigation (Ctrl+PgUp/PgDn), word counts in the tree, Source/Visual toggle per tab
- [x] Tree: arrow-key navigation, file filter (Ctrl+P), resizable sidebar
- [x] Empty folders are shown; New Folder (toolbar, right-click, Ctrl+Shift+N)
- [x] New file, rename, delete (Recycle Bin), show in Explorer; new/move/delete chapter from the sidebar
- [x] Autosaved drafts: unsaved edits survive a crash and are offered back on next start
- [x] **Export for KDP** (milestone 6.5): mark a file for export, fill in Book Details (title page, copyright page, dedication, epigraph, back matter), then Export to **EPUB**, **print-interior PDF** and **DOCX** from one dialog
- [x] **Custom title bar**: frameless window with the logo, the File/Edit/Go/View/Help menus (mouse, arrow keys, Alt+letter), the open chapter and file, and window buttons. On Windows the OS draws the minimise/maximise/close buttons over the bar (keeping Win 11 snap layouts); on other systems the app draws them
- [x] **Undo Last Action** (Edit menu, Ctrl+Alt+Z / redo Ctrl+Alt+Y, or the Undo button in the status bar): reverses the last 5 delete / move / add-chapter actions and whole-file Replace All. Typing keeps its usual Ctrl+Z. Available until the file is changed again; not kept across restarts
- [x] **Find & Replace**: Ctrl+F / Ctrl+H, F3 / Shift+F3 (also Edit menu). Highlights matches in the formatted editor, works in Source mode, with match case, whole word and regular expressions (`$1`, `$&` in the replacement). Search *this chapter* or the *whole file* (carries on into other chapters; Replace All asks first and saves to the file)
- [x] **Fonts** for the ebook and the print PDF: three open-licence fonts ship with the app (EB Garamond, Crimson Pro, Libre Baskerville), then every font installed on your computer. Bundled fonts are embedded in the EPUB and the PDF; installed fonts are embedded in the PDF and only named in the EPUB
- [x] **Settings** (File → Settings, Ctrl+,): choose which heading level starts a chapter (H1–H6), and set the template new books start from — author, copyright page, dedication/epigraph, back matter — plus default export choices (outputs, trim size, margins, fonts, quotes, scene-break symbol, output folder)
- [x] Scene-break navigation: Ctrl+↑ / Ctrl+↓ (or the ↑ Scene / ↓ Scene buttons) jump between `* * *` / `---` breaks in Visual and Source mode
- [x] Packaging (milestone 7): app icon, installer, single instance, open-with / double-click `.md`, CI build with a smoke test of the packaged app
- [ ] Code signing (needs a certificate — see Packaging)

## Shortcuts
| Key | Action |
|---|---|
| Ctrl+S | Save |
| Ctrl+Alt+N / Ctrl+K | New project / Switch project |
| Ctrl+O / Ctrl+N / Ctrl+Shift+N | Open a folder / New file / New folder |
| Ctrl+W | Close tab |
| Ctrl+Tab, Ctrl+Shift+Tab | Next / previous tab |
| Ctrl+PgDn, Ctrl+PgUp | Next / previous chapter |
| Ctrl+↓, Ctrl+↑ | Next / previous scene break (in the editor) |
| Ctrl+, | Settings |
| Ctrl+Shift+M | Toggle Source / Visual |
| Ctrl+Alt+Z / Ctrl+Alt+Y | Undo / redo the last chapter or file action (5 deep) |
| Ctrl+P | Filter files |
| Ctrl+F / Ctrl+H | Find / Find & Replace in the open chapter or file |
| F3, Shift+F3 (or Ctrl+G) | Next / previous match |
| Alt+C / Alt+W / Alt+R | (in the find bar) match case / whole word / regular expression |
| F5 | Refresh |
| F2 / Del / Alt+Up / Alt+Down | Rename / delete / move chapter (in the tree) |

## Export for KDP

1. Right-click a `.md` file → **Mark for Export**. It gets a 📕 badge and a `<name>.export.json` beside it (title page, copyright page,
   back matter and your last export choices). Your manuscript is never modified.
2. **Book Details…** (opens automatically when you mark a file): title, subtitle, author; copyright page (year, edition, publisher, ISBN, fiction
   disclaimer, 18+ notice, content warning, extra lines — shown in a live preview in the skill's fixed order); dedication; epigraph; back matter
   (Continue the Story, Also by, About the Author, a custom page). Only links you type are ever added.
3. **Export…** (toolbar, File menu, Ctrl+E) → confirm the title/subtitle/author read-back → pick outputs and their variables → Export.

| Output | How it is built |
|---|---|
| EPUB 3 | Direct XHTML + NCX + OPF following the format-for-kdp structure; passes epubcheck 5.3 with no errors or warnings |
| Print PDF | Paged.js in an offscreen Chromium window, bundled EB Garamond (embedded), exact KDP trim size, mirrored margins with KDP's page-count gutter table (two-pass), chapters on recto pages, outer-edge page numbers counted from chapter 1, dot-leader contents |
| DOCX | `docx` library; non-breaking-space blank paragraphs (importers strip empty ones), two sections, explicit centring, static linked contents (no page numbers) |

Trim sizes offered: 5 × 8 up to 8.5 × 11 in (nothing below 5 × 8). Not included: the paperback **cover** PDF, ISBN barcodes, live KDP upload testing.

### Tests

`npm test` runs everything. Some suites use external tools and skip themselves if they are missing:

- PDF integration (real Electron + Paged.js): needs `xvfb-run` and the Electron binary (`node node_modules/electron/install.js`).
- epubcheck: needs Java and `pip install epubcheck`.
- DOCX → LibreOffice round trip: needs `libreoffice-writer` (a bare `soffice` install can't open documents).

## Packaging and installing (Windows 10)

```
npm ci
npm run dist          # → release/MDEdit-Setup-<version>.exe  (run on Windows or in CI)
```

- **Installer:** NSIS, per-user (no admin rights needed), lets you choose the folder, creates Desktop and Start-menu shortcuts. Uninstalling
  leaves your settings and drafts in `%APPDATA%\MDEdit`.
- **Icon:** `assets/branding/app-icon-source.jpg` is the master. `python scripts/make_icons.py` (needs `pip install pillow`) regenerates
  `build/icon.ico`, `build/icon.png` and `assets/icon.png` with rounded corners.
- **Open with / double-click:** the installer registers MDEdit as an editor for `.md` and `.markdown` (it appears in *Open with*; Windows
  decides the default). Opening a file starts MDEdit on that file's folder; if MDEdit is already running, the file opens as a tab in the
  existing window instead (**one window per user**). If it is in another folder and you have unsaved edits, you get the usual
  Save / Don't Save / Cancel prompt first.
- **Smoke test:** `MDEdit.exe --smoke-test=result.json` exports a small book to EPUB, PDF and DOCX with the bundled fonts and layout engine
  and exits 0 on success. CI runs it against the freshly built Windows package, which is the only way to prove the installed app can export.
- **Code signing:** the installer is **unsigned** until you provide a certificate, so Windows SmartScreen will say "unknown publisher" the first
  time. To sign, add the repository secrets `WIN_CSC_LINK` (a base64 `.pfx`, or a URL) and `WIN_CSC_KEY_PASSWORD`; the workflow signs automatically
  when they exist. A standard code-signing certificate removes the "unknown publisher" name; SmartScreen reputation still builds up over time
  unless you use an EV certificate.
- **Not included:** auto-update, a portable build, other platforms.

## Releases

Download the latest Windows installer from
[Releases](https://github.com/blaashford-ux/MDEdit/releases/latest). Pushing a version tag
(`npm version 0.3.0 && git push origin HEAD --follow-tags`) builds, tests and publishes a release
automatically. See [docs/RELEASING.md](docs/RELEASING.md).

## Changelog

### 0.3.0
**New**
- **Projects**: a project is a folder (with subfolders) marked by a small hidden `.mdedit` folder. MDEdit works out of a **Root Folder** (default `%USERPROFILE%\MDEdit`; chosen on first run, changeable in Settings, with an offer to move your projects). A welcome screen sets this up the first time, and offers the folder you last used as a project.
- **Projects home** with a card per project (status, word count, goal progress, last edited), search, sort, archive, and a context menu to open, rename, duplicate, change status or delete (to the Recycle Bin, after typing the name).
- **New Project** dialog (Ctrl+Alt+N): name + template with a live preview of the folders it will create. Built-in templates: Novel, Series book, Short story, Blank.
- **Project templates** (Settings → Projects): edit the folder tree, which folders count toward word goals, starter files and the export defaults each template carries.
- **Project switcher** in the sidebar and **Ctrl+K quick switcher**; File → Open Folder still opens any folder, and other folders in the Root can be converted to projects.
- **Per-project overrides**: chapter-heading level and export defaults can be set per project; the template's values are copied in when the project is made.
- **Project status** (Planning, Drafting, Revising, Editing, Published, On hold) and notes.
- **Word-count goals and progress**: target and optional deadline; Progress window with a day-by-day bar chart, burn-down against a steady-pace line, words per day needed, and estimated completion at the 3-day and 5-day averages; running total in the status bar.

- **Series template** (replaces Series Book): a Manuscripts folder for several books (no book files created) plus a series bible.
- **Active Manuscript**: right-click a file → *Active Manuscript* to make word-count goals and progress follow that single file (one at a time; choosing another swaps without asking). A target marker shows on the file in the browser, the Progress chart and tiles are labelled with its filename, and each manuscript keeps its own goal and writing history.

**Changed**
- The sidebar's folder button became the project switcher; File → Change Folder is now **Open Folder**.


### 0.2.0 — 2026-10-05
**New**
- **Find & Replace** (Ctrl+F / Ctrl+H, F3 / Shift+F3, Edit menu): highlights in the formatted editor, works in Source mode, match case / whole word / regular expressions (`$1`, `$&` in replacements); search this chapter or the whole file (Replace All in the file asks first).
- **Undo Last Action** (Ctrl+Alt+Z, redo Ctrl+Alt+Y, Edit menu, status-bar button): reverses the last 5 delete / move / add-chapter actions and whole-file Replace All.
- **Settings** (File → Settings, Ctrl+,): choose which heading level starts a chapter (H1–H6), set the template new books start from (author, copyright page, dedication, epigraph, back matter) and the default export choices.
- **Fonts for export**: EB Garamond, Crimson Pro and Libre Baskerville (all open-licence) ship with the app and are embedded in EPUB and PDF; any font installed on your computer can be used for the print PDF.
- **Scene-break navigation**: Ctrl+↑ / Ctrl+↓ or the ↑ Scene / ↓ Scene buttons jump between scene breaks, in Visual and Source mode.
- **New look**: borderless, tonal, rounded design with a palette drawn from the app icon, in light and dark, with line icons.
- **Custom title bar**: frameless window with in-window File / Edit / Go / View / Help menus (mouse, arrows, Alt+letter), the open chapter and file, and window buttons (drawn by the OS on Windows).
- The chapter heading and toolbar stay pinned while you scroll.
- The copyright page has an optional **Content Warning** notice (default text “Add Content Warnings here”).

**Changed**
- Export files (`<name>.export.json`) use the field names `contentWarning` / `contentWarningText`; older files are tidied automatically the first time they are read.
- Exports record the chosen fonts; a missing font falls back to EB Garamond with a warning.
- Clicking Undo / Cut / Copy / Paste in the menu now acts on the editor (the menu no longer takes focus).

**Release pipeline**
- Pushing a version tag, or running the *release* workflow from the Actions tab, builds, tests and publishes the Windows installer with checksums (see `docs/RELEASING.md`).

### 0.1.0 — 2026-10-05
- First release: folder browser with expandable folders and empty folders, chapter-at-a-time WYSIWYG editing (Milkdown), Save / Don't Save / Cancel prompts, external-change detection, tabs, session restore, crash-recovery drafts, dark mode, Source mode, file and chapter management.
- **Export for KDP**: mark a file for export, fill in Book Details (title page, copyright page, dedication, epigraph, back matter), export to EPUB 3, KDP print-interior PDF (trim sizes from 5 × 8, automatic gutter) and DOCX.
- Windows installer with app icon, single instance and `.md` file association.
