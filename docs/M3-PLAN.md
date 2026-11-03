# M3: Editorial, implementation plan

Branch: `ccr-7ecf360c-88oe1a`, cut from `dev` (0.6.1 at the time). Scope comes from [PLAN.md](PLAN.md) section M3 and the Editorial records in [ARCHITECTURE.md](ARCHITECTURE.md). Delivered as small PRs into `dev`, one per slice below, each with tests. Versions are not tied to milestones ([VERSIONING.md](VERSIONING.md)).

## Already in place
- Capabilities `edit.read`, `edit.respond`, `edit.approve`, `edit.run`, `edit.assign` (kernel `capabilities.ts`); `brief.write` sits under assets.
- Vault versions (`file_version`), approvals and the decision ledger, workflow gates with an `approved` condition, comments on projects.
- Editing skills and Cadrel Reader leave notes and comments, but nothing is tied to a version.
- Latest migration is `0011_server.sql`, so M3 starts at `0012`.

## Slices

1. **Briefs** (`0012_brief.sql`). **Built (records, service, server, backup/move); the Brief tab on a book is not built yet.** Read with `task.read` / `edit.read`, written with `task.edit` / `edit.assign` by kind; each revision is a new numbered version and a revision made from a stale version is refused. `brief(kind: manuscript | edit, project, body, version)`, versioned and append-only. Kernel type and service methods, `brief.write` for edit briefs held by editorial managers. Home screen: a Brief tab on a book.
2. **Edit passes** (`0013_edit_pass.sql`). **Built (records, service, server, backup/move); no screens yet.** One live pass of each kind per file; moves are atomic; the editor must be assigned to the project. `edit_pass(kind: developmental | line | copy | proof, project, brief, file, version, editor, state)`. The pass pins the exact `file_version` it covers. States: planned, in progress, delivered, responded, closed. Assign with `edit.assign`, run with `edit.run`. Audit log entries on every transition.
3. **Anchored queries and comments.** **Built (`0014_edit_query.sql`, `kernel/src/anchor.ts`, `editQuery.ts`; no screens yet).** Queries, comments and suggestions in a pass; the author answers after delivery and a pass cannot be marked responded with a query unanswered. Whether the quoted text really is in the pinned version is checked by the caller that holds the text (the screen or the MCP tool), not by the records. `query(pass, anchor, text, author_response, state)`. An anchor is a version plus a text range with quoted context, so it survives re-opening a later version (re-anchored by quote; flagged when it cannot be). Cover Write's note format so existing editing-skill notes import as queries.
4. **Decisions.** **Built (`0015_edit_decision.sql`, `kernel/src/editDecision.ts`; no screens yet).** One batch writes the decision, its ledger entry and a deferral's revisit task; a changed mind supersedes the old decision and cancels the old task; a pass cannot be marked responded while a suggestion has no decision. `change_decision(query | change, accept | reject | defer, reason)`. Reason required for reject and defer. Writes to the decision ledger; defer carries a revisit date as a task.
5. **Compare and verification.** **Built (`kernel/src/compare.ts`, `editVerify.ts`, `0016_edit_verification.sql`; no screens yet).** The compare engine is in the kernel, not the UI package, so the screens, the Worker and the assistant tools share it. The caller supplies the text of each version, because the records hold none. Side-by-side compare of two `file_version`s (paragraph-level diff, in the UI package). Revision verification: for each accepted change, mark made, changed or missed by matching against the new version; the result is stored on the pass.
6. **Gates.** New workflow gate conditions: `pass_closed(kind)` (developmental, line, copy) and `queries_resolved`; proof passes advise only. An approved pass (`edit.approve`) unlocks the next stage. Default workflow gains the conditions as optional, not forced on existing studios.
7. **Server and offline.** Same service runs in the Worker (checks stay on the server); migrations shared with the desktop cache; passes and queries readable offline, responses queued for reconnect.
8. **Screens and assistant tools.** Editor dashboard (passes assigned, queries open), Author view (respond, decide), MCP tools for reading a pass and adding queries so the editing skills can write structured queries instead of free notes.
9. **Fonts and Rewrite mode** (sections A and B below).
10. **Exit test** (`docs/M3-EXIT-TEST.md` plus an automated two-client test): one book goes through developmental, line and copy passes; the author answers every query; compare shows the changes; verification flags a missed change; the gate opens only when all passes are closed.

## Order and dependencies
A (fonts) is built (see PROVENANCE.md). A is standalone. B (Rewrite) reuses the compare and scroll mapping from 5. 1 → 2 → 3 → 4 are sequential. 5 needs 3 and 4. 6 needs 2 and 4. 7 and 8 follow once the records are stable. 10 (exit test) last.

## Decided
- Proof passes only advise; they never block a stage gate (slice 6 leaves `pass_closed(proof)` out of the default gate).
- Cadrel Reader beta-reader comments stay a separate stream and do not become queries.
- Compare covers text manuscripts only; no docx import comparison.

## Added to M3: export fonts and Rewrite mode

These two are Write features, independent of the editorial records, so they can ship in any order. Suggested slots: A before 1 (small, self-contained), B after 5 (reuses the compare/scroll-link work).

### A. Separate heading and body fonts in export settings, more bundled OFL fonts
Today (`packages/write/src/shared/export/fonts.ts`, `model.ts`) each of EPUB and PDF has one `font`, and three families are bundled: EB Garamond, Crimson Pro, Libre Baskerville (under `packages/write/assets/fonts/<slug>/`, four faces each).

- **Settings:** add `headingFont` beside `font` (which becomes the body font) for EPUB and PDF, defaulting to the body font so saved settings keep working. Sanitise with `cleanFamily`; thread through the EPUB CSS, print HTML and docx. Export settings UI gets two pickers.
- **Heading list** (bundled): Cormorant Garamond, Crimson Pro, Alegreya, Playfair Display, Marcellus, Fraunces, Spectral, Bodoni Moda.
- **Body list** (bundled): Literata, Source Serif 4, Crimson Pro, Alegreya, EB Garamond, Spectral, Merriweather, Lora, Gelasio.
- Libre Baskerville stays available so existing books do not change. Any installed font can still be named for the print PDF only, as now.
- `BundledFont` gains `roles: ('heading' | 'body')[]`; each list is derived from it. Fonts with a missing weight or italic (Marcellus and Bodoni Moda have fewer faces) declare what they have, and the embedder falls back rather than faking bold or italic. Variable fonts (Fraunces, Literata, Source Serif 4 and others) are instanced to the four static faces at build time so EPUB embedding keeps working.
- **Licence rules (SIL OFL 1.1), enforced by a test:**
  - Every bundled family ships with its original copyright notice and the OFL text, in its folder (`OFL.txt`, with the upstream copyright line).
  - Those files are copied into the installer and into every EPUB that embeds the font, and listed in an in-app "Font licences" page.
  - Font files are never sold on their own; they are only distributed inside the app and the books it exports.
  - Fonts are not modified, so Reserved Font Name restrictions do not bite. If a font is ever subsetted or instanced, a test checks the Reserved Font Name list for that family first, and the result is renamed if the licence requires it.
  - A test fails the build if a bundled family has no licence file or its licence is not OFL.
- Add an entry to `docs/PROVENANCE.md` per font family (source URL, version, licence).

### B. Rewrite mode (desktop only)
Goal: make rewriting a manuscript easy by keeping the old and the new draft side by side.

- **Entry point:** right-click a chapter or file in the tree, choose "Rewrite". It creates a new file (a copy, or an empty one, asked once), and records a link between the two files.
- **Link:** a `file_link` pair stored with the project (the vault already has `0009_file_links.sql`; reuse it with a `rewrite` kind rather than adding a table). The link is symmetric, so from either file the menu shows "Rewrite mode" as a toggle, and the mode can be turned on or off later from either side.
- **View:** with the mode on, the editor shows the two files side by side, original on the left (read-only by default), the rewrite on the right. Desktop only: the mobile build and Reader show the files singly.
- **Linked scrolling:** scrolling one pane scrolls the other. Positions are matched by paragraph index with proportional interpolation between anchors, so the panes stay roughly aligned when paragraph counts differ; a per-pane "unlink scroll" switch pauses it.
- **Rules:** deleting either file removes the link only; the other file stays. A file can be in one rewrite link at a time. Rewrite files obey vault check-out like any other file, and rewrite counts as a version of the same chapter in the chapter list (shown nested under it).
- **Tests:** link creation and symmetry, toggle from both ends, scroll mapping (equal and unequal paragraph counts), deletion, and desktop-only gating.

## Not in scope
Canon and continuity checks (M4), art review (M5), any change to roles beyond using the existing editorial capabilities.
