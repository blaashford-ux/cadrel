# Milestone 6.5 — Export to KDP (EPUB + print PDF)

Status: **implemented (6.5a–f).** The notes at the end list where the build differs from this plan.

Basis: the `format-for-kdp` skill. Its output rules (block paragraphs, Garamond 11pt, copyright-page order,
static TOC, recto chapter starts, mirrored margins with a page-count-driven gutter, EPUB3 structure) carry
over unchanged. What changes is *where the content comes from* (the app's marked files and a form, not a
conversation) and *how the files are built* (no LibreOffice on Windows).

## 1. What the user sees

1. **Mark for Export.** Right-click any `.md` file → *Mark for Export* (toggle). Marked files get a book badge in
   the tree. Unmarking keeps the saved details in case you re-mark it.
2. **Book Details** (appears for marked files: right-click → *Book Details…*, or from the Export dialog). A form:
   - **Title page** — Title, Subtitle (optional), Author / pen name. Captured verbatim: never auto-split, never
     auto-cased (skill rule). The Export dialog reads them back for confirmation.
   - **Copyright page** — Year (default: current), Edition label ("First Edition"), toggles for the fiction
     disclaimer, the 18+ mature-content notice, and a "Content Warning" notice (each with
     editable wording), plus optional Publisher / ISBN and extra free-text lines. Line order follows the skill.
   - **Other front matter** (each optional) — Dedication, Epigraph (text + attribution).
   - **Back matter** (each optional, each its own page) — *Continue the Story* / *Also by <Author>* (list of
     titles, each with an optional URL), *Links* (mailing list, Patreon, social: label + URL), *About the Author*
     (bio), *Custom page* (heading + text). **No link is ever added that you didn't type.**
3. **Export button** (toolbar, File menu, Ctrl+E) → modal:
   - Which book (if more than one is marked) and a read-back of title / subtitle / author to confirm.
   - **Output checkboxes**: EPUB (KDP ebook), Print PDF (KDP paperback), DOCX (Reedsy / Kindle Create import). Each ticked output reveals its own variables (section 4).
   - Output folder + file names (`<Title> - Ebook.epub`, `<Title> - Print Interior.pdf`, `<Title> - Ebook.docx`).
   - Unsaved edits to the book's file: Save first / Export the saved version / Cancel.
   - Progress per output, then results with *Open* / *Show in Folder*, and any warnings (e.g. page count under
     KDP's 24-page minimum).

## 2. Chapters and content rules (reused from the skill)

- A chapter is a Heading 1 (same rule as the editor). Text before the first H1 is dropped from the export with a
  warning (or can be tied to a front-matter field if you prefer — see Q-list).
- Heading text is used **verbatim** by default. The skill's EPUB form `Chapter <NumberWord>: <em>Title</em>` is
  available as an option.
- Scene breaks (`* * *`, `---`, or blank-line runs) become a centred `•  •  •`.
- Inline bold / italic / links are preserved; H2+ become sub-headings; images produce a warning (not supported v1).
- Straight quotes go through a smartypants pass **only if** the text doesn't already use typographic quotes.
- The table of contents lists real content only (chapters, back matter) — never Title Page / Copyright / Contents.

## 3. How the files are built (no LibreOffice, no Word, no Java required)

All building runs in Electron's main process behind one IPC call with progress events.

| Output | Method |
|---|---|
| **EPUB3** | Built directly (zip of XHTML): `mimetype` stored first and exactly 20 bytes, `META-INF/container.xml`, `OEBPS/` with CSS, `title`, `copyright`, one XHTML per chapter, back matter, `nav.xhtml` (EPUB3 nav, at the `OEBPS/` root), `toc.ncx`, `content.opf`. Skill CSS (block paragraphs, 1em gap, drop cap via `h1 + p::first-letter`, centred scene breaks). An in-app self-check enforces the skill's invariants; CI additionally runs **epubcheck** on generated fixtures. |
| **Print PDF** | Book is laid out as HTML in a hidden Chromium window with **Paged.js** (paged media: exact trim size, mirrored left/right pages, running footer at the outer edge, `break-before: right` for recto chapter starts with blank versos, TOC page numbers via `target-counter`). Exported with `printToPDF`; fonts are embedded. **Two passes:** pass 1 counts pages → pick the gutter from KDP's table (0.375" ≤150 pages, 0.5" ≤300, 0.625" ≤500, 0.75" ≤700, 0.875" beyond) → pass 2 is final (re-run once if the page count crosses a threshold). Front matter unnumbered, body numbered from 1. Block paragraphs, **no** gap between them (the confirmed print style). |
| **DOCX** | `docx` library, per skill: block paragraphs with a **non-breaking-space** blank paragraph between them (never empty), explicit page size, two sections, explicit centring, black Heading 1. TOC is a static list with internal links but **no page numbers** (we can't paginate a docx without Word/LibreOffice, and an ebook-import docx reflows anyway). A byte-level check for the nbsp mechanism runs after every build. |

**Font.** The app bundles **EB Garamond** (open licence) at 11pt body so PDFs embed a real Garamond on any machine.
"Garamond" itself ships only with Microsoft Office, so relying on it would give different output per computer.

## 4. Variables in the Export modal

Defaults reproduce the skill exactly; everything below is editable, remembered per book, and resettable.

- **EPUB:** language (default `en`), description, publisher, ISBN (optional), cover image (optional, embedded),
  drop caps on/off, scene-break glyph, paragraph gap, chapter-heading style (verbatim / skill's number-word form).
- **Print PDF:** **trim size dropdown**, gutter (auto from page count / manual), outer + top/bottom margins,
  chapters start on recto (on/off), page numbers on/off, running head (none / author / title), body font size,
  paragraph style.
- **DOCX:** page size, drop caps off, scene-break glyph, paragraph style.

**Trim-size list** (KDP paperback, no bleed, smallest 5 × 8 and 5.5 × 8.5 as requested): 5 × 8 · 5.06 × 7.81 ·
5.25 × 8 · **5.5 × 8.5 (default)** · 6 × 9 · 6.14 × 9.21 · 6.69 × 9.61 · 7 × 10 · 7.44 × 9.69 · 7.5 × 9.25 · 8 × 10 ·
8.5 × 11. I'll re-check this list against KDP's current published sizes before building.

## 5. Where the data lives

A **sidecar file beside each marked `.md`**: `book.md` → `book.export.json` (same folder, `<name>.export.json`).
It holds the Book Details (front/back matter) and the last-used export variables. A file is "marked for export"
exactly when its sidecar exists with `"marked": true`; unmarking sets it to `false` and keeps the details.
Nothing in your `.md` files changes — no front-matter pollution. The tree scanner only lists `.md`/`.markdown`, so
sidecars never show up as files. Housekeeping the app will do:

- **Rename** a marked file in the app → its sidecar is renamed with it. Rename outside the app → the sidecar is
  orphaned; the app notices (sidecar with no matching `.md`) and offers to re-link it.
- **Delete** a marked file in the app → its sidecar goes to the Recycle Bin with it.
- **Name clash** (`book.md` and `book.markdown` both exist) → the second one is flagged instead of sharing a sidecar.
- The JSON carries a `version` so the format can evolve; unknown or corrupt files fall back to defaults with a
  warning (never a crash, never silently overwritten).
- Saves are atomic (same temp-file + rename as the manuscript) and are picked up by the existing outside-change check.

## 6. Code layout

```
src/shared/export/        pure, unit-tested: manuscript parser (mdast), smart quotes, book model + defaults,
                          KDP trim sizes + gutter table, front/back-matter content builders
electron/export/          epub.ts · pdf.ts (+ paged.js assets, EB Garamond) · docx.ts · run.ts (IPC, progress)
src/renderer/             BookDetailsForm · ExportModal · tree badge · context-menu + File-menu + Ctrl+E
```

## 7. Build order (each step tested before the next)

1. **6.5a** Parser + book model + smart quotes + front/back-matter content (unit tests incl. every copyright-page
   permutation and "no unconfirmed links").
2. **6.5b** Mark for Export, persistence, Book Details form.
3. **6.5c** EPUB builder + self-check; CI epubcheck on fixtures.
4. **6.5d** Print PDF (Paged.js, fonts, two-pass gutter, recto starts, TOC). Verified by extracting the PDF: exact
   MediaBox for each trim size, odd/even text offsets mirror, footers at the outer edge, TOC numbers equal the real
   heading pages, page count vs gutter table.
5. **6.5e** DOCX builder (if kept) + nbsp byte check.
6. **6.5f** Export modal, progress, unsaved-edit guard, delivery, error handling; real-Electron end-to-end export of
   a full-length (~80k-word) manuscript, to measure time.

## 8. Risks

- **Paged.js speed on novel-length books** (it can take minutes at 80k+ words). Mitigation: progress UI, measure early
  in 6.5d; fallback is simpler pagination for the body with Paged.js only for front matter.
- **Chromium print fidelity** (widows/orphans, justification) is good but not InDesign; hyphenation off by default
  (matches the skill, which doesn't hyphenate).
- **Not included:** the paperback **cover** PDF (needs spine width from page count + paper type), ISBN barcode, and
  Kindle Previewer / live KDP upload testing. epubcheck validates the spec but not KDP's uploader.

## 9. Decisions

| Question | Answer |
|---|---|
| What is a "book"? | **Each marked file is its own book** (own Book Details, own export). |
| Where is the data stored? | **Sidecar file beside each `.md`** (`book.export.json`). |
| Outputs offered | **EPUB + Print PDF + DOCX.** |
| Editable variables | **All four groups:** font size + paragraph style; chapter-heading style; print layout (margins, recto starts, page numbers, running head); EPUB extras (cover image, language, publisher, ISBN, drop caps, scene-break glyph). Trim size and gutter mode are always editable. |
| Font | **EB Garamond bundled** (open licence), 11pt default, embedded in the PDF. |

Defaults I'm assuming unless you say otherwise (each is a one-line change):

- Text before the first Heading 1 is **left out of the export, with a warning** (it isn't silently included).
- Chapters can be **excluded** from an export with checkboxes in the modal (e.g. a scratch chapter), default all included.
- DOCX TOC has **no page numbers** (see section 3).
- Hyphenation **off**, orphans/widows control on, in the print PDF.
- Output folder defaults to an `Exports` folder beside the manuscript, created on first export.
- Cover image is optional and embedded in the EPUB only; the paperback **cover PDF** is out of scope here.

## 10. As built — differences from the plan

- **Main process is bundled with esbuild** (not `tsc`) so ESM-only dependencies (unified/remark) work; `assets/vendor/paged.polyfill.js`
  is copied from `node_modules` at build time and no runtime `node_modules` is shipped (asar ≈ 9 MB).
- **Offscreen window for the PDF layout.** A merely hidden window gets no animation frames and Paged.js waits on them (22 s for 25 pages);
  offscreen rendering lays out a 330-page book in ~16 s.
- **Page numbers and contents numbers are written after layout** by a small script (body pages counted from the first chapter, blank versos
  included), not by CSS counters: Chromium scoped `counter-reset: page` to a single page, and this Paged.js has no `leader()`. Dot leaders are a flex
  row. Running heads are set the same way so chapter openers can go without.
- **Export uses the saved manuscript and the saved Book Details** (the dialog saves its settings first). Unsaved edits prompt Save and export /
  Export saved version / Cancel.
- **Title, subtitle and author must be re-confirmed (read-back checkbox) for every export**, per the skill's "confirm before use" rule.
- Chapter headings in the print PDF are sunk 1.25 in from the top and have no drop cap (the drop cap is EPUB-only, as in the skill).
- A bad cover image or an unsafe link is a **warning**, never a failure; one failing output doesn't stop the others.
- Not done: a re-link flow exists for orphaned `*.export.json`, but there is no UI to create a *second* book from one file.

## 11. Later additions

- **Chapter heading level.** File → Settings → Chapters picks which heading level (H1–H6) starts a chapter. It is one global setting used by the
  editor, the tree and every export. Exports treat the level just below the chapter level as sub-headings; text above the first chapter heading
  is left out with a warning that names the level. Changing it re-splits open files (unsaved edits are resolved first; each tab stays on the text
  it was on). Files are never rewritten by the setting.
- **Settings template for new books.** File → Settings → Title & copyright / Front matter / Back matter / Export use the same forms as Book Details
  and Export. A file marked for export for the first time starts from that template (title from the file name; a blank copyright year means the
  current year). Existing books keep their own details. Stored in the app's `settings.json` (`appDefaults`), not beside your manuscripts.
- **Fonts.** EPUB and print PDF each have a Font dropdown: *Included with MDEdit* (EB Garamond — the default — Crimson Pro and Libre Baskerville, all SIL OFL 1.1,
  shipped as full static TTFs in `assets/fonts/<family>/`), then *Installed on this computer* (listed with the `font-list` package, cached per session).
  A bundled font is embedded in the EPUB (four faces, `font/ttf`, epubcheck-clean) and in the PDF. An installed font is embedded in the PDF by Chromium
  but only *named* in the EPUB, because we can't know that its licence allows redistribution (a warning says so). If a book's saved PDF font isn't installed
  on the machine exporting it, the export falls back to EB Garamond with a warning. DOCX still names Garamond (Word substitutes if it is missing).
  Defaults for new books are set in Settings → Export.
