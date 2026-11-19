# M5: Art, assets and Preflight, implementation plan

Status: **built on `dev` and not yet released** (19 November 2026; server revision 11, database step 23). Planned against 0.19.0. The decisions below were taken on 19 November 2026 as recommended: a built-in EPUB inspector always, epubcheck in addition when installed; Amazon KDP and generic EPUB first; concepts from vault files only; an expired licence blocks new approvals only; built straight through to the exit test. Branch `dev`. Scope comes from [PLAN.md](PLAN.md) section M5; the asset records are in [ARCHITECTURE.md](ARCHITECTURE.md); file kinds and data cards in [FILES.md](FILES.md); the role matrix rows (Assets, art, covers; Preflight) in [PERMISSIONS.md](PERMISSIONS.md). Versions are not tied to milestones ([VERSIONING.md](VERSIONING.md)).

**Folded into this milestone:** the post-0.19.0 change already on `dev` (`0262228`): the Canon page follows the selected project instead of asking for a series, and the manuscript pickers on Continuity and Editing offer only the current project's files. It ships with M5's first release and is listed in its CHANGELOG entry. It also sets a rule M5's new pages follow (see "Scope rule" below).

**Exit (from PLAN.md):** a cover goes brief → concepts → approval → used in Preflight and visible to Launch.

## What was built, and where it differs from the plan

All ten slices are built and tested (kernel 384, service 196, MCP 118, shell 359 including `m5Exit.test.ts`; the Art and Preflight pages are also drawn and clicked in jsdom, `artPages.test.tsx`). The manual walk-through is [M5-EXIT-TEST.md](M5-EXIT-TEST.md) and has no recorded run. Where the build departs from the plan below, so the plan is not read as describing what shipped:

- **Feedback is its own record, not a Note.** Notes live in files beside the manuscript and are shared through Drive; feedback on a picture needs a permission check of its own (`asset.comment`) and an exact file version, so it is `asset_feedback` (region as fractions, version, state) rather than a `NoteTarget`. Same idea, different table.
- **Previews are read from the file, not derived and uploaded.** The Art page reads the picture from the vault file at that version (a PSD's saved composite is decoded in the app, shrunk, and written as a PNG with no image library). Nothing derived is stored on the server, so there is no thumbnail cache; a file over 12 MB (a PSD over 300 MB) is not previewed, and says why.
- **The assistant cannot run Preflight.** It reads the latest run (`preflight_read`), looks at covers (`asset_read` with a picture), reads briefs and where-used, and pins a note to a region (`asset_comment`). Running needs the EPUB inspector and the catalogue, which live in the app; it is not offered to the assistant. A person runs it on the Preflight page.
- **The EPUB inspector and the rules.** The inspector (zip, package, navigation, each content document's links and ids, cover, title page) is in the shell (`epubInspect.ts`); the rules are the kernel's (`preflightRules.ts`) and run over the facts. epubcheck is run in addition when `EPUBCHECK_JAR` or an `epubcheck` command is found, and the run says whether it was used.
- **The rule pack was read from KDP's pages on 19 November 2026.** The two KDP pages on cover images disagree on the minimum (500 pixels on the longest side, or 625 by 1,000), so the lower is an error and the higher a warning; the recommended 1,600 by 2,560 is a suggestion. Descriptions are limited to 4,000 characters, seven keywords, and 200 characters for title and subtitle together. The 50 characters a keyword is the Studio's own rule from the keywords skill, not read from a KDP page, and the pack says so.
- **Blurb and keywords come from the marketing files** (`Marketing/Blurb.md` before its structured block, `Marketing/Keywords.md` as bullet or numbered lines), because the catalogue holds neither. With none found, the run says so.
- **Names are compared only when the Studio's catalogue can be read.** A role given only on one book cannot read the catalogue (a Studio-wide permission), so for such a person Preflight does not compare names and says so, as the stage options need a Studio-wide `task.read` (a known limit, not new). The exit test's Editor holds the Studio and is assigned to the book.
- **Preflight run and waive need `preflight.run` on the book; reading needs `preflight.read`.** The default Editor and Art Director hold run; an Artist, a Director and a Series Lead read.
- **The Editor can read assets but not comment** (the matrix gives Editor read on art), so the assistant of an Editor cannot pin notes; the Art Director's can.
- **Art view for the Owner, Art Director and Artist.** The Director's Home also shows *assets in review* and *books not ready to upload*.
- **Not built:** offline use of the Art and Preflight pages on a server Studio; replicating thumbnails; retailers other than KDP; print covers; a Launch page (the contract is `assets.readiness` and `preflight.latest`, which M6 reads).

## What this is for

A book's cover, banners and ad art are made by people who are not the author, go through rounds, carry licences that expire, and end up on retailer listings nobody remembers to update. Today they are loose files in `Art\`. And before a book is uploaded, someone checks the EPUB, the cover size and the metadata by hand, or does not. M5 makes an **asset a governed record** (who approved which version, under what licence, used where), and makes **Preflight a repeatable check with graded results** so "ready to upload" is something the Studio can read, not a feeling.

Principles carried over: the assistant proposes and people decide; nothing replaces anything automatically (a replacement is *proposed*); measured is not estimated (a Preflight result says what was measured and against which rule); the files stay the artists' own and records point at exact versions of them.

## What already exists and is reused

| Piece | Where | Used for |
|---|---|---|
| Capabilities `asset.read / comment / write / approve / manage`, `brief.write`, `preflight.read / run`, and the role rows (Art Dir manages, Artist writes, Director and Series Lead approve; Editor runs Preflight) | `kernel/capabilities.ts`, PERMISSIONS.md | who may do what; **no new capability** |
| Vault files with exact versions, hashes, locks; file kinds `image`, `asset`, `brief`; areas | `kernel/vault.ts`, `kinds.ts` | an asset's bytes and versions are the vault's |
| References and where-used between files, data cards (trim size, licence, purpose, project) | `kernel/fileLinks.ts` | file-to-file uses ("this EPUB uses that cover") |
| Briefs: numbered, never overwritten, a stale revision refused | `kernel/brief.ts`, `0012_brief.sql` (`kind` is plain text, no CHECK) | cover and art briefs: add kinds `cover`, `art` |
| Notes on any record through a `NoteTarget(module, kind, id, anchor)` | `kernel/notes.ts` | feedback on a concept; gets a **region anchor** (below) |
| Records pinned to an exact version, append-only decisions, audit rows, one batch per change | `edit_pass`, `canon_proposal`, `continuity_check` | the shape of approvals, replacement proposals and Preflight runs |
| Workflow gate conditions as JSON; `editGate.ts`, `continuityGate.ts` | `kernel/workflow.ts` | optional gates `cover_approved` and `preflight_clear` |
| Catalogue: IP, series, books, editions with ASIN/ISBN, format, price, keywords | `kernel/catalogue.ts` | the metadata Preflight compares an EPUB against |
| EPUB export (assemble, layers, fonts) and the epubcheck test helper | `write/src/shared/export/*` | the EPUB Preflight inspects; epubcheck as an optional second opinion |
| The assistant's door, tools pattern and the per-project switch and policy | `mcp/modules/*`, `shell/main/assistantDoor.ts` | `asset_*` and `preflight_*` tools |
| Server Studios: every table through the Worker, backup and move, `RECORD_TABLES` | M2, 0.13.0, M4 | M5 records work on local and server Studios from the first slice |
| Lenses (director / editor / author) and role-derived Home | `kernel/lens.ts`, `shell/main/lens.ts` | a fourth, **art** lens for Art Director and Artist |

## Scope rule (from the change folded in)

Every M5 page **follows the selected project and book**; none asks the person to select again. Every file or asset picker offers **only files that belong to the project in view** (by the file's data-card project, within the subtree), and picks the lone candidate itself. The Art page, the Preflight page and the cover chooser in an edition are tested for this the way `canonPage.test.tsx` is.

## Design

### Records (database step 23, server revision 11, `0023_assets.sql`)

An asset is a vault file plus governance. The bytes and versions stay the vault's.

- `asset(id, studio_id, project_id /* the book or series */, file_id, kind: cover | banner | ad | interior | character | map | other, name, channel, state: draft | in_review | approved | retired, licence_kind, licensor, licence_ref, licence_expires, territory, credit_line, licence_file_id /* the licence document, optional */, created_by, created_at)`. One asset per file; the file is not copied.
- `asset_approval(id, asset_id, version, hash, state: approved | revoked, by, at, note)`. Append-only. Approval is **of an exact version and hash**: a new version of the file is not approved until someone approves it, so an approved cover cannot silently change underneath a listing.
- `asset_use(id, asset_id, version /* null = follows the latest approved */, user_kind: edition | listing | ad | banner | release | other, user_ref, label, note, state: current | needs_update | done, added_by, added_at)`. Declared uses of things that are not vault files (a retailer listing, a running ad, a banner on a site). File uses (an EPUB that embeds the cover) are read from `fileLinks`. **Where used** is the union.
- `asset_replacement(id, asset_id, from_version, to_version, reason, state: open | approved | rejected | withdrawn, proposed_by, decided_by, decided_at)`. Approving one **moves nothing**: it marks every use `needs_update` and lists them; each use's owner marks it `done`. The old version stays approved until the last use is done or someone revokes it.
- `art_brief` is the existing `brief` table with new kinds `cover` and `art` (same versions, same stale-revision refusal). A cover brief's body is free text plus a small structured header (book, trim, genre, comps, must-haves, must-avoids, due date).
- `concept(id, brief_id, brief_version, asset_id, file_version, by, state: submitted | shortlisted | chosen | rejected, note, decided_by, decided_at)`. A concept is **an exact version of a file against an exact version of a brief**. Choosing one makes its file an asset in review; it still needs an approval.
- Feedback: Notes with `target = { module: 'assets', kind: 'concept', id }` and a new **region anchor** `{ version, x, y, w, h }` (fractions of the image at that exact version, so a pin is never to the wrong pixels). A region note on a later version is shown as "on version 2" with the pin ghosted, never moved silently.
- `preflight_run(id, project_id, edition_id, subject_file_id, subject_version, subject_hash, cover_asset_id, cover_version, metadata_hash, pack_id, pack_version, run_by, at, counts_error, counts_warning, counts_suggestion)`. Pinned to the exact EPUB, the exact cover and the exact catalogue metadata it saw.
- `preflight_result(run_id, seq, rule_id, grade: error | warning | suggestion, what, where, measured, expected, state: open | waived, waived_by, waived_reason)`. A result says **what was measured and what the rule expects**. A waiver needs a reason and a person holding `preflight.run`, and is shown on later runs of the same rule against the same file, never hidden.

### Preflight: what is checked, and where it runs

Rules are **pure functions over extracted facts**, in the kernel (`preflight.ts`), so they run identically in the app, in tests and later on a server. Extracting facts needs the file, so it runs **on the computer that has it** (the shell, like the Editing page's reads), and the run is then recorded. The Worker never opens an EPUB (the CPU lesson from three earlier fixes).

| Group | Checks | Facts come from |
|---|---|---|
| EPUB validity | container, mimetype first and stored, OPF well-formed, manifest items exist, spine items in manifest, no dangling references, XHTML parses, IDs unique | a built-in structural inspector (zip + XML). **epubcheck is run in addition when Java is present** and its messages are folded in, graded the same way |
| Navigation | a nav document with every landmark target resolving; table of contents entries resolve and are in reading order; chapter count in the manuscript equals the chapters in the EPUB | the EPUB, plus the manuscript version it was built from |
| Front and back matter | title page, copyright page, dedication or epigraph if the template says so, "also by", about the author, a call to action to review | the export model and template |
| Name and series consistency | title, author or pen name, series name and number, edition and ISBN agree between EPUB metadata, title page, the catalogue record, and the cover's data card | EPUB + catalogue + data card |
| Cover | pixel dimensions and aspect ratio, resolution, colour model, file size and type for the target retailer; the cover in the EPUB is **the approved asset version** for the edition, not just any image | the cover file's header, the approved asset |
| Retailer metadata | required fields present and within length: blurb, keywords (seven, 50 characters, the rule the keywords skill already uses), categories, price, ISBN or ASIN, language, publication date | catalogue edition record |

Grades: **error** (the retailer will reject it or the file is broken), **warning** (accepted, likely a problem), **suggestion** (better practice). A run with any open error is "not ready".

**Rule packs are data with a version and a "last verified" date**, not constants buried in code. The first pack is **Amazon KDP** plus generic EPUB, which matches the studio's market and the keywords skill. Each limit in a pack names its source and the date it was read, and the build re-verifies each against the retailer's current help page before release rather than trusting memory; a pack older than a set age shows "rules last verified N months ago" on the Preflight page.

### Previews

- **Images** are thumbnailed on the computer that checks the file in, and the thumbnail is uploaded as a derived, content-addressed file (hash of source plus size). The Worker never decodes an image.
- **Photoshop sources**: read the flattened composite that a PSD stores when "Maximize Compatibility" is on, in pure TypeScript. When it is off, the asset shows "no preview in this file" and accepts a linked **preview image** (a normal reference) so the Art Director still sees something. No Adobe dependency.
- Previews never leave the permissions of the asset: a person without `asset.read` on the project gets no thumbnail either.

### Cover → Preflight → Launch (the exit)

The exit is a **contract**, not a screen: `assets.approvedFor(editionOrBook)` returns the approved cover version (or none) and `preflight.latest(edition)` returns the latest run's counts and whether it is ready. Preflight reads the first; Launch (M6) reads both, so "outstanding assets" and "not ready" in a release plan come from records. M5 shows the same two facts on the book's Home card and as an optional **gate** (below). Nothing in M5 builds Launch.

### Gates (optional, off by default)

Workflow conditions `cover_approved` (the book has an approved cover) and `preflight_clear` (the edition's latest run has no open error), added by an administrator like `continuity_clear`, never forced on an existing Studio.

### Who does what

| Action | Needs |
|---|---|
| See assets and previews | `asset.read` |
| Comment and pin feedback | `asset.comment` |
| Upload, check in versions, submit a concept, add a use | `asset.write` |
| Approve or revoke a version, decide a replacement, choose a concept | `asset.approve` |
| Licence, retire an asset, edit declared uses | `asset.manage` |
| Write a cover or art brief | `brief.write` |
| See Preflight results | `preflight.read` |
| Run Preflight, waive a result | `preflight.run` |

The assistant can read, raise Notes and propose, run Preflight, and **cannot approve, choose, waive or retire**.

## Slices

1. **Asset records (`0023_assets.sql`).** Tables above, kernel `asset.ts` (rules, validation, audit, one batch per change), approvals pinned to version and hash, uses, replacement proposals, licence fields with an expiry rule, region anchor type. Tests as for `canon` and `brief`.
2. **Service, server, backup and move.** `assets.*` and `preflight.*` on the service behind the capabilities above; the Worker namespaces; the remote proxy; `RECORD_TABLES`; the move and backup tables. **Server revision 11, schema step 23** (one Upgrade for every server Studio); the hand-synced `migrations.ts` mirror and the schema-step expectations updated.
3. **Assets page, approval, licence, where-used.** A vault file becomes an asset; approve a version; licence and expiry (a licence about to expire shows on the Art Director's Home); declared uses plus file references as one where-used list; a proposed replacement and its per-use checklist.
4. **Briefs, concepts and pinned feedback.** `cover` and `art` briefs; concepts side by side against the brief version; region notes; shortlist, choose, and the chosen concept becomes an asset in review.
5. **Previews.** Client-side thumbnails, the PSD composite reader, linked preview images, derived files in the store and on the server.
6. **Preflight engine.** Kernel rules and rule-pack format; the built-in EPUB inspector; epubcheck when available; the KDP pack with sources and dates; run and result records; waivers.
7. **Assistant tools and a skill.** `asset_list`, `asset_read` (metadata and, where the assistant can use it, the pinned preview), `asset_where_used`, `asset_comment` (region note), `brief_read`, `preflight_run`, `preflight_read`; a **Preflight review** skill in the AI Kit (read the results, explain each in the author's terms, propose fixes, never waive). Refused when the Studio has turned the assistant off; honours the per-project switch.
8. **Screens.** An **Art** page (assets for the project in view, brief, concepts, approval, where-used, licence) and a **Preflight** page (edition, run, results grouped and graded, waive, re-run, "last verified" notice). A fourth **art** lens so Art Director and Artist land on briefs due, concepts waiting, licences expiring; Director's and Series Lead's Home gain "covers awaiting approval" and "books not ready". Both pages follow the scope rule.
9. **Readiness contract and gates.** `assets.approvedFor`, `preflight.latest`, the two gate conditions, the Home cards.
10. **Exit test.** `packages/shell/test/m5Exit.test.ts` against the real Worker code, plus `docs/M5-EXIT-TEST.md` for the manual run on Windows.

Order: 1 and 2 are sequential. 3 follows 2. 4 and 5 can follow 3 in either order. 6 needs 2 and, for the cover check, 3. 7 needs 3, 4 and 6. 8 follows each page's records (the Art page after 3, completed by 4 and 5; Preflight after 6). 9 needs 3 and 6. 10 last.

**Releases.** First release **slices 1 to 5 and the Art page** (assets you can govern and briefs and concepts that work; with the folded Canon change). Second release **6 to 9** (Preflight, the contract and gates). If `packages/write` changes (the EPUB facts extractor may live beside the exporter), the release also bumps the Reader's version, as the release process requires.

## Exit test (slice 10)

Fixtures: a series with a book and an edition in the catalogue, three people (Art Director, Artist, Series Lead) plus an Editor, an exported EPUB with known defects, a PSD with a composite, a JPEG cover at the wrong size, a licence that has expired. A scripted stand-in plays the assistant.

The test proves:
1. a cover brief with two versions; two concepts are submitted against version 2; feedback pins to a region at an exact file version; the Art Director chooses one; **only `asset.approve` can approve it**, including for its own uploader, and the approval names the exact version and hash;
2. a new version of the approved cover is **not** approved until someone approves it, and a use that follows "latest approved" still shows the old one;
3. where-used lists a declared listing use and an EPUB that references the cover; a replacement is proposed, approving it moves nothing and marks each use `needs update`; the old version stays approved until the uses are done;
4. an expired licence is flagged, and an asset with an expired licence cannot be newly approved;
5. Preflight on the defective EPUB raises the planted errors (a dangling manifest item, a broken navigation target, a title that disagrees with the catalogue, a cover at the wrong size, a missing blurb), each **with what was measured and what was expected**; fixing the files and re-running clears them; a waiver needs a reason and shows on the next run;
6. Preflight's cover check uses **the approved asset version** and says so when the EPUB embeds a different one;
7. the readiness contract returns the approved cover and the run's counts, which is exactly what Launch will read;
8. the same on a server Studio through the Worker, including a person without `asset.read` getting no asset, no preview and no result;
9. the optional gates hold a stage move while there is no approved cover or an open error;
10. the Art and Preflight pages offer only the current project's files (scope rule).

Manual (`M5-EXIT-TEST.md`): on a real book, brief a cover, take two concepts to approval, export the EPUB, run Preflight, fix what it finds, and check that every result can be verified by looking at what it names.

## Risks and how the plan handles them

| Risk | Handling |
|---|---|
| Retailer rules change under the pack | Rules are versioned data with sources and a "last verified" date, re-verified before each release; the page says when they are old; a failed upload is never blamed on Cadrel because every result states what it measured against which rule |
| Preflight says "ready" and the retailer rejects it | Grades are honest: error / warning / suggestion; epubcheck is run when present; the first pack covers only what is checked and says what is not (the page lists "not checked") |
| An approved cover is swapped under a live listing | Approval is of an exact version and hash; replacement is a proposal that moves nothing and lists every use |
| Worker CPU from image or EPUB work | Neither is decoded on the Worker: thumbnails and facts are produced on the computer holding the file, and the Worker stores records |
| Large Art folders (hundreds of images) | Assets read per project and per page; thumbnails are small and content-addressed; one read per card, measured before release |
| PSDs without a composite | Say so and accept a linked preview, rather than parsing layers or adding a dependency |
| Licence data is wrong or stale | It is shown, not enforced, except the one hard rule (an expired licence blocks a *new* approval); `asset.manage` holders own it |
| Scope creep into design tools or marketing | Not in scope (below); campaign briefs and requests belong to M6 |

## Not in scope

- Editing or generating images; layer-level Photoshop work; colour management.
- Campaign briefs, ads as their own planning objects, ARC and release planning (**M6**); M5 only records that an ad uses an asset.
- Rights, agreements, credits and payments to artists (**M7**; the licence here is a usage licence on one asset).
- Uploading to retailers; Preflight only checks.
- Print interiors and print covers (spine width, bleed): ebook first; print is a later pack.
- Offline approval and offline Preflight on a server Studio: reads of the last-synced assets work, decisions need the server (as the Canon page today).
- A shared stock-art library across Studios.

## Open decisions (recommendation first)

1. **EPUB validity.** Built-in structural inspector always, epubcheck in addition when Java is installed (**recommended**); or built-in only (simpler, weaker); or require epubcheck (strongest, but a Java install for every author).
2. **First retailer pack.** Amazon KDP plus generic EPUB (**recommended**, matches the keywords skill and the studio's market); add Kobo, Apple and Google later as data.
3. **Concepts from outside.** Vault files only (**recommended**: an artist outside the Studio is a Guest with one project for a time, which already exists); or accept links to a design tool.
4. **Licence strictness.** Expired licence blocks new approvals only (**recommended**); or also warns on every use; or is advisory only.
5. **Release split.** Two releases as above (**recommended**), or one at the end like M4.
