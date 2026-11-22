# Plan: Editing workspace overhaul

Status: proposal, nothing built yet. Decisions already made: replace the pass workflow (keep its data), design for a professional editor with client authors, uploads convert into the project's Manuscript folder, the report is living (auto sections plus typed text).

## Goal

Editing becomes a place where an editor opens a manuscript, leaves comments and one-click suggestions the way they do in Write, attaches a text analysis, and hands the author a polished, current Editing Report as a PDF. AI edits through MCP go through the exact same path as human notes.

## What exists (so we reuse it)

- Notes: `ReviewItem` in `.cadrel/review/<reviewerId>.json` (`packages/write/src/shared/review/comments.ts`); anchors (`makeAnchor`/`locateAnchor`); one-click suggestions (`applySuggestion`). UI in `packages/write/src/renderer/ReviewPanel.tsx`, `useReview.ts`, `reviewPlugin.ts`.
- MCP: `read_chapter`, `search_text`, `get_notes`, `add_notes`, `reply_to_note` in `packages/write/src/shared/agent/tools.ts`, registered in `packages/write/mcp/server.ts`, wrapped by `packages/mcp/src/modules/write.ts`.
- Text analysis: `analyzeManuscript`, `renderReport`, `renderReportHtml`, `embedAnalysis` in `packages/write/src/shared/analysis/`. PDF via `report:save` (Electron `printToPDF`) in `packages/write/electron/module.ts`.
- docx to Markdown: `docxToMarkdown` in `packages/write/src/shared/importDocx.ts`.
- Project link: `projectFor(tree, 'write', folder)` maps a Write folder to a Cadrel project.
- Today's Editing page: `packages/shell/src/renderer/Editing.tsx`, `main/editorial.ts`, kernel `editPass/editQuery/editDecision/editVerify`, MCP `edit_*`.

## Design

### 1. Notes work exactly like Write (the key decision)
Editing does not get its own note model. It reads and writes the same review files through the same code, so human notes, Write notes and AI notes (`add_notes`) all appear in both places and `edit_raise`/pass items are no longer needed for new work.

- Extract the review UI (notes list, accept/reject/reply, anchor highlighting, selection to "add note") from `packages/write` into a shared package (`packages/ui` or a new `packages/review-ui`), used by both Write and Editing. Write keeps behaving as now.
- Editing's centre pane is the manuscript rendered read-only, with Write's anchor decoration, selection to comment or suggestion, and the right-hand Notes panel. Editors never alter the author's text; accepting a suggestion is the author's action (in Write, or in Editing if the author opens it).
- No new MCP tools needed for notes. Add one thin one, `editing_report`, to read and add to the report (see 4), so AI can contribute a summary the same way.

### 2. Manuscript picker
- Only items classified as manuscripts (the `Manuscript(s)` folder, Markdown/converted docx). Exclude `- Analysis.md`, reports, outlines, bible, exports.
- Filtered by the project/book scope already used elsewhere (`PageScope`, `projectFor`). Fixes the current gap where the list is not filtered by project.
- Shows word count, chapter count, open note count and last edited.

### 3. Upload for outside editing
- "Upload document" accepts .docx (and .md/.txt). Converted with `docxToMarkdown` into the project's Manuscript folder as a new file ("<name> (edited by <editor>)"); original .docx stored beside it in the project.
- Name collisions are numbered. Result opens straight in the Editing workspace.
- Needs a shell-side file picker plus a move of `docxToMarkdown` to a shared package (the shell cannot import from Write today).

### 4. Editing Report (living)
Stored as a project file: `Editing/<manuscript> - Editing Report.md`, with the structured data embedded as a trailing comment (same trick as `embedAnalysis`), so it syncs, backs up and versions like any file.

Sections:
- Auto, always current: summary header (manuscript, editor, round, dates); counts by status and category; suggestions accepted/rejected/open; top recurring themes from the notes (grouped by category/topic); per-chapter heat map of note density; open items list.
- Feedback analysis: themes derived from the notes text (AI-assisted via MCP or deterministic grouping by category as a fallback), editable.
- Attached Text Analysis: one-click "Attach analysis" runs or reuses the manuscript's analysis and embeds its findings (readability, dialogue, adverbs, filter words, repeated phrases, POV/tense) as a section.
- Manual sections: typed rich text (overall assessment, strengths, priorities, next steps). Auto sections are regenerated; manual text is never overwritten. Edited auto text becomes pinned so it is not clobbered.
- Updates on activity: note added/resolved/accepted, analysis re-run, manuscript changed.
- Export PDF: reuse the `report:save` approach, but available in the shell (HTML template plus `printToPDF`), with a cover page, table of contents and page numbers.

### 5. Passes data
- Existing passes stay readable in an "Earlier passes" archive tab; records, permissions and `edit.*` capabilities remain in the kernel. The new Editing page does not create passes. Nothing is deleted.

## Confirmed scope (after review)

In: editing rounds; handling of moved or cut notes; Word export with real comments and tracked changes (accepted suggestions-in-waiting become Word tracked changes the author can accept in Word); tagging notes by edit type (developmental, line, copy, proof) and by source (human, AI, which editor). Roles as proposed: editors add notes and edit the report, authors read and accept.
Also in: Word tracked-changes and comments IMPORT. An outside editor's .docx is read with its tracked insertions/deletions/replacements and comments; each becomes a note (a replacement or deletion becomes a one-click suggestion, an insertion or comment a comment), tagged source=outside editor, with the author name and date from the docx. Imported text is the accepted-or-original base, so anchors match the converted Markdown.
Out: client-facing mode, report snapshots, style sheet, sign-off (revisit later).

Implementation notes for the confirmed items:
- Round, edit type and source are fields on the note (`round`, `editType`; source is the existing `origin` plus `author`). They are optional so existing review files still load, and `add_notes` gains optional `editType` and `round` so AI notes carry them too.
- Moved or cut notes: reuse `locateAnchor` statuses (same-place, moved, reflowed, gone). The notes panel gets a "Needs attention" filter; a cut note can be re-anchored by selecting new text, or resolved.
- Word export: build on the existing `docx` library (`packages/write/src/shared/export/docx.ts`). Comments become Word comments anchored to the quoted range; a suggestion becomes a tracked deletion plus insertion attributed to its author. Needs a LibreOffice round-trip check, which the repo already uses for docx tests.

## Other ideas considered (not in scope unless you say so)

1. Rounds: group notes and the report by editing round (First read, Second read) so progress between rounds is visible. Small cost: a `round` label on the report, notes filter by date range.
2. Stale-anchor handling: when the manuscript changes after notes were written, show "moved/reflowed/gone" states (the anchor code already computes these) and offer re-anchor.
3. Client-facing mode: the report hides internal-only notes and AI origin labels, with a preview before export. This matters for a professional editor with clients.
4. Report snapshots: each PDF export saved as a dated snapshot so you can show what was delivered when.
5. Export notes to the author as a .docx with real Word comments, for authors who live in Word.
6. Style sheet: a per-manuscript list of spellings and decisions (names, hyphenation, UK/US) used by copy-edit passes and shown in the report. The copy-edit skill already needs this.
7. Edit type tagging per note (developmental, line, copy, proof) so the report can split by type; existing categories can map onto it.
8. Sign-off: the author's accept/reject summary (counts and who) at the end of the report.

## Open risks / needs your call later

- Shared review UI extraction is the biggest piece; Write must keep working (its tests: `ReviewPanel.test.ts`, `reviewPlugin.test.ts`, `noteChapter.test.ts`).
- Word tracked-changes import (outside editor's changes become suggestions) is not in scope. It is a separate parser and is where "outside editing" gets most useful; say if you want it.
- Roles: who may add notes, edit the report or export? Proposal: editor and above add notes and edit the report; the author reads and accepts. Reuse `edit.*` capabilities rather than new ones.
- Any change under `packages/write` requires raising the Reader version (`scripts/check-reader-version.sh`), plus the usual VERSION and CHANGELOG bump.

## Phases

1. Foundations (revised after checking the code): no package move needed. The shell already imports Write code directly (`@cadrel/write/src/...`, e.g. Admin.tsx, Settings.tsx), and `ReviewPanel.tsx` is presentational, driven by `ReviewState` from `useReview(api: WriteApi)`. So Editing reuses `ReviewPanel`, `useReview`, `reviewPlugin`, `docxToMarkdown` and the analysis modules in place. Phase 1 becomes: (a) add the optional note fields (`round`, `editType`) to `ReviewItem` and `add_notes`, with tests; (b) give the shell a thin `WriteApi` adapter over the project folder so `useReview` runs there; (c) a Reader version bump because `packages/write` changes.
2. Workspace: new Editing page with manuscript picker (filtered), reading pane, shared Notes panel, add comment/suggestion, accept/reject. MCP parity test: an `add_notes` call shows up live.
3. Upload and import: docx and md into the Manuscript folder; tracked changes and comments in the docx become notes. Needs a new parser for w:ins, w:del and comments.xml on top of the existing `docxToMarkdown`, with the base text taken as the document before the outside editor's changes so quotes anchor exactly.
4. Report: auto sections, manual sections, attach analysis, live updates.
5. PDF export, snapshots, client-facing mode.
6. Archive tab for old passes; retire the old UI; docs (`docs/FILES.md`, `UI-MODEL.md`), CHANGELOG, version bumps.

Each phase ships on its own with typecheck and tests passing.

---

# Separate workstream: Rewrite mode fixes (Write)

Unrelated to Editing, tracked here so it is not lost. Reported behaviour: Rewrite mode only turns on from the original, and then opens both files; from the rewrite file it does nothing; and the panes open either both blank or both full.

## Wanted behaviour
- From the rewrite file, one click on Rewrite shows the dual view directly. It must not need the original opened first, and it must not open or switch tabs the user did not ask for.
- The original pane is always present and always shows the original text (read only).
- Only the rewrite pane differs by how it was started: a blank page, or a copy of the original. It never shows blank in the original pane, and the two panes never mirror each other's content by accident.
- Works the same from either file, on and off.

## Where it lives (checked, not yet reproduced)
- Link rules: `packages/write/src/shared/rewrite.ts`. State and actions: `packages/write/src/renderer/workspace.ts` (`startRewrite` ~698, `setRewriteMode` ~730, `followChapter` ~762, `rewritePair` ~662). View: `packages/write/src/renderer/App.tsx` (`rwShown` ~222, panes ~1300-1320, toolbar button ~1406), scroll sync `useRewriteScroll.ts`.
- Suspects to confirm before changing anything:
  1. `rwShown` needs the active tab to be in the pair AND both tabs open, but turning on only opens the partner, and `setRewriteMode` toggles on `!(rwShown && inPair)`. From the rewrite file a stale or half-open state can make the click a no-op.
  2. `setRewriteMode` opens the partner first and the clicked file second, at the same chapter index. A blank rewrite has one chapter while the original has many, so the index is clamped and the panes can show the wrong chapter or the same document; `followChapter` then reloads the other pane (`reloadKey`), which may be how both end up blank or both full.
  3. The original pane is locked only by `isOriginal` (path equals `rwPair.original`), so if the pair resolves wrong, the wrong pane is read only.
- Existing coverage: `packages/write/src/shared/rewrite.test.ts`, `workspace.test.ts`, `packages/shell/test/rewrite.e2e.test.ts`.

## Plan
1. Reproduce with a failing test first: start a rewrite (copy and blank), close tabs, turn on from the rewrite file, turn on from the original, assert both panes' text and which is read only.
2. Fix state so rewrite mode is a property of the link and the active file, not of which tabs happen to be open: turning it on from either file opens whichever of the two is missing, in the right pane, without changing the active tab or chapter more than needed.
3. Make the original pane load the original's text regardless of chapter clamping; align chapters by position with a clamp only for the rewrite.
4. Tests for each of the above; Reader version bump (`packages/write` changes), plus VERSION and CHANGELOG.

Question for you: when the rewrite is blank, should the original pane still scroll with the rewrite (by chapter), or sit on the chapter you were reading?
