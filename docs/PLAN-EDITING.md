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

## Things you did not ask for but I recommend

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

1. Foundations: move shared pieces (review model, `docxToMarkdown`, analysis) to shared packages; no behaviour change; tests green.
2. Workspace: new Editing page with manuscript picker (filtered), reading pane, shared Notes panel, add comment/suggestion, accept/reject. MCP parity test: an `add_notes` call shows up live.
3. Upload: docx and md into the Manuscript folder, open in workspace.
4. Report: auto sections, manual sections, attach analysis, live updates.
5. PDF export, snapshots, client-facing mode.
6. Archive tab for old passes; retire the old UI; docs (`docs/FILES.md`, `UI-MODEL.md`), CHANGELOG, version bumps.

Each phase ships on its own with typecheck and tests passing.
