# M4: Canon and continuity, implementation plan

Status: **built and released as 0.19.0** (server revision 10, database step 22). The decisions below were made on 18 November 2026: canon lives in records; embeddings are left out; anyone holding `canon.propose` (or `canon.approve`) on the book may run a check; built straight through to the exit test. "What was built, and where it differs from the plan" is just below. Branch `dev`. Scope comes from [PLAN.md](PLAN.md) section M4 and the Canon records in [ARCHITECTURE.md](ARCHITECTURE.md) (the Canon records). Versions are not tied to milestones ([VERSIONING.md](VERSIONING.md)); each slice below is releasable on its own, but the exit test needs them all.

**Exit (from PLAN.md):** Book 4's manuscript is checked against Books 1 to 3 and the findings are specific and checkable.

## What was built, and where it differs from the plan

All nine slices are built and tested (kernel 343, service 192, MCP 111, shell 310 including `m4Exit.test.ts`; the Canon page is also drawn and clicked in jsdom, `canonPage.test.tsx`). The manual walk-through is [M4-EXIT-TEST.md](M4-EXIT-TEST.md) and has no recorded run. Where the build departs from the plan above and below, so the plan is not read as describing what shipped:

- **Facts have no `proposed` status.** A proposal carries the payload and a fact is created only when it is approved, so a fact is `canon` or `retired`. Fewer states, and nothing half-true in the list.
- **One page, three tabs.** The rail gets one **Canon** page (Canon, Proposals, Continuity checks) rather than two pages, and a Series Lead's Home shows how many proposals wait on them. There is no read-only canon panel in Write beside the manuscript yet.
- **The series is the top project of a book's path** (a book with no parent is its own series). Canon is read and proposed by anyone who holds the capability on the series or on any book in it; approving needs `canon.approve` on the series itself.
- **Approving implies proposing.** A Series Lead holds `canon.approve` but not `canon.propose` in the default roles, so approval counts for both (and for starting a check). Someone who may approve changes canon in one step (`apply`: proposed and approved together, both in the audit log).
- **Who decides a finding:** whoever may change the manuscript (`manuscript.write` on the book) or approve canon, so an Editor as well as the Author. What they can do is dismiss, or *propose* a canon change; only `canon.approve` makes anything canon.
- **Seeding** (`canon_seed`) proposes entries first and facts for entries that already exist, so it is run twice with an approval between. It reads the series' tracker ledgers from the manuscript folder on the computer the assistant runs on.
- **Offline is not built.** The plan said the Canon and Continuity pages would read from a local copy and queue the Author's decisions as the Editing page does. They do not: they need the Studio's server (or the local records). Not in this release.
- **Not built:** the canon panel in Write; a ledger citation in a finding (a finding cites canon facts, and seeding is how ledger content becomes facts); semantic search (left out on purpose, decision 2).
- **Known limit, not new:** `workflows.stageOptions` needs a Studio-wide `task.read`, so a role given only on one series cannot ask what stage moves are open. The exit test's Series Lead is Studio-wide and assigned to the series, as in M3's.

## What this is for

A series is written over years by several hands. The facts that make it hold together (a character's eye colour, the day a battle happened, what magic costs) live today in prose files (series bible, character sheets, worldbuilding) and in the two tracker ledgers (timeline, LitRPG). Nothing says which statement is *canon*, where it was established, who agreed, or whether Book 4 contradicts it. M4 makes canon a **record the studio governs**, and makes continuity checking **specific enough to verify**: every finding quotes the passage it is about and cites the fact it conflicts with.

Principles carried over: the assistant proposes and people decide (principle 5); measured is not estimated (a finding says how sure it is); the prose files stay the authors' own and records point back to them (FILES.md: "a character sheet is a file; a fact extracted from it is a record that points back").

## What already exists and is reused

| Piece | Where | Used for |
|---|---|---|
| Capabilities `canon.read`, `canon.propose`, `canon.approve`, `canon.manage` and the role matrix row (Owner manage, Series Lead approve, Author and Editor propose, others read) | `kernel/capabilities.ts`, PERMISSIONS.md | who may do what; no new capability needed |
| File kinds with a `canon` flag (character, world, premise, outline, style, reference) | FILES.md | which files feed canon and the checker |
| Anchors: a quote plus context, re-found in a later version (`makeAnchor`, `locateAnchor`) | `kernel/anchor.ts` | a fact's source passage; a finding's passage |
| Records pinned to an exact `file_version`, append-only versions, audit rows, one batch per change | `edit_pass`, `brief_version` | the shape of a check and of a versioned entry |
| Author decisions with reasons, a ledger entry, a revisit task | `edit_decision`, the decision ledger | accepting or dismissing a finding; approving a proposal |
| Workflow gate conditions stored as JSON | `kernel/editGate.ts`, `workflow.ts` | an optional "no open continuity findings" gate |
| The assistant tools pattern: look up, read the pinned text, quote exactly, raise; cannot decide or close | `mcp/modules/editorial.ts`, `edit_raise` | `continuity_*` tools |
| Tracker ledgers per series (timeline, LitRPG) with a carried timeline and a per-chapter record | `write/shared/agent/timeline.ts`, `litrpg.ts`, `chapterRecords.ts` | seeding facts, and "what is true as of chapter N" |
| Server Studios: every table through the Worker, the remote client, backup and move, offline reads | M2, 0.13.0 | M4 records work on both local and server Studios from the first slice |
| Text search over project files (`search_text`) | Write's MCP tools | finding where a name or term is used |

**Not reused, on purpose:** Market's embedder (MiniLM, downloaded on first use) is built for book research, not manuscripts, and ties M4 to a model download. See decision 2.

## Design

### Records (database step 22, server revision 10)

Series-level, as the UI model already puts canon at the Project (series) level and books read it.

- `canon_entry(id, studio_id, project_id /* the series */, kind: character | place | rule | event | term, name, aliases[], state: active | retired)`. A name is unique per series and kind, so "Mara" cannot be two characters by accident.
- `canon_entry_version(entry_id, n, summary, by, at)`. Append-only: a revision is a new numbered version and a stale revision is refused (as for briefs).
- `canon_fact(id, entry_id, text, status: proposed | canon | retired, source: { fileId, version, anchor } | null, established_in: { bookProjectId, chapter } | null, supersedes, decided_by, decided_at)`. The source anchor is a quote in an exact version of a file, so the fact can be shown with its passage and re-found later; if it cannot be found in a later version the fact is flagged **source moved**, never silently dropped.
- `canon_proposal(id, by, change: add_fact | edit_fact | retire_fact | add_entry | edit_entry | retire_entry, payload, reviewer, state: open | approved | rejected | withdrawn, reason)`. Nothing becomes canon except through an approved proposal. A Series Lead's own change is a proposal they approve in the same step, so the record is the same either way.
- `continuity_check(id, project_id /* the book */, file_id, file_version, canon_stamp /* the canon version it was run against */, run_by, state: running | delivered | reviewed | closed)`. Pinned to the exact manuscript version and the exact canon, so a later edit never makes an old finding point at the wrong text.
- `continuity_finding(id, check_id, seq, kind: contradiction | timeline | name | rule | thread | other, severity: low | medium | high, confidence: low | medium | high, anchor, fact_ids[], body, state: open | fixed | accepted_as_canon | dismissed, response, decided_by)`. A finding **must** have an anchor into the pinned version and **at least one cited fact** (or a cited ledger entry); the caller that holds the text checks the quote is really there, exactly as `edit_raise` does.

### Who does the checking

**The person's own assistant, through the MCP server**, as the plan already decided (decision 6: each person's own Claude through MCP first). Cadrel does not call a model itself. Cadrel's job is to make the check *possible and checkable*: give the assistant the right facts for a chapter, accept findings only in the strict form above, and keep the human in charge of every outcome. This is the same split that made the editorial passes work. It also means no model cost, no manuscript leaving the machine except through the assistant the author already chose to use, and the per-project assistant switch and the Studio's assistant policy (0.13.0) apply unchanged.

### What "specific and checkable" means, concretely

A finding is accepted by the records only if: its quote is found exactly in the pinned version (or disambiguated by before/after text); it cites a fact or ledger entry that exists in the pinned canon; it says what the conflict is in one sentence; and it carries a severity and a confidence. A finding without a passage or without a cited fact is refused with the reason, so a vague "this feels inconsistent" cannot enter the record. The screen shows the passage and the cited fact side by side with their sources.

### Decisions on a finding (the author controls what becomes canon)

- **Fix the manuscript:** the author edits and checks in a new version; the finding is marked *fixed* when a re-check no longer finds the passage (re-anchoring and the revision-verification idea from M3).
- **Accept as canon:** the manuscript is right and the canon was wrong or silent. This creates a *proposal* (edit or add a fact, sourced from the passage in this book), which the Series Lead approves; the finding closes when the proposal does.
- **Dismiss:** with a reason, which is required, and recorded in the ledger. Dismissed findings are not raised again by a re-check against the same text.

## Slices

1. **Canon records (`0022_canon.sql`).** Tables above, the kernel module (rules, validation, audit, one batch per change), unique names, versions, source-anchor re-finding. Tests as for `brief` and `editQuery`.
2. **Service, server, backup and move.** `canon.*` on the service behind `canon.read/propose/approve`; the Worker namespace; the remote proxy; `RECORD_TABLES`; the tables list in move and backup. Server revision 10, schema step 22 (one Upgrade for every server Studio).
3. **Proposals and review.** Propose, approve, reject, withdraw; approval writes the fact and a ledger entry in one batch; a rejected proposal needs a reason; the Series Lead's inbox is a "waiting on you" list (and a Home lens card for the Director/Series Lead view).
4. **Seeding from what the studio already has.** Import proposed facts from the series' tracker ledgers (timeline: dated events; LitRPG: rules, abilities, stat facts) and from character and world files (an assistant-assisted extraction that *proposes*, never auto-approves). This is the adoption path: a studio with three books and a ledger must not start from zero.
5. **Continuity checks and findings (records and service).** `continuity_check` pinned to a manuscript version and a canon stamp; findings in the strict form; decisions; the re-check that closes fixed findings.
6. **Assistant tools and a skill.** `canon_entries`, `canon_facts`, `canon_search` (a name or alias across canon and the series' canon-kind files), `canon_for_chapter` (the canon plus ledger state that applies as of a chapter, built on `chapterRecords`), `canon_propose`, `continuity_start`, `continuity_read` (the pinned text), `continuity_raise`. It cannot approve a proposal, decide, dismiss or close, and it is refused when the Studio has turned the assistant off. A **Continuity check** skill in the AI Kit tells the assistant how: read the canon for the chapters in order, compare, quote exactly, say how sure.
7. **Screens.** A **Canon** page at the series level (entries, facts with their sources, proposals, a source-moved list) and a **Continuity** page (checks, findings with the passage and the cited fact side by side, accept as canon, fix, dismiss). Plus a read-only canon panel in Write beside the manuscript. Offline reads from the local copy, as for editing.
8. **Gate (optional, off by default).** Workflow condition `continuity_clear` (no open high-severity findings on the book's latest check), added by an administrator like the editorial conditions; never forced on an existing Studio.
9. **Exit test.** `packages/shell/test/m4Exit.test.ts` against the real Worker code, plus `docs/M4-EXIT-TEST.md` for the manual run on Windows.

Order: 1, 2, 3 are sequential and make canon usable by hand. 4 (seeding) can follow 3. 5 needs 1 and 2; 6 needs 3 and 5; 7 follows 3 and 5 (the Canon page can ship after 3 and the Continuity page after 5). 8 needs 5. 9 last. A sensible first release is **slices 1 to 3 and the Canon page** (canon you can govern), then **4 to 7** (continuity you can check).

## Exit test (slice 9)

Fixtures: a series with three finished books and a fourth manuscript, three people (Author, Series Lead, Editor), canon seeded with about 30 facts from a ledger and character sheets, and **five contradictions planted in Book 4** of known kinds (a character's eye colour, a dated event placed on the wrong day, a rule of the magic broken, a name used for two people, a dead character appearing). A scripted stand-in plays the assistant (the same technique as `m3Exit.test.ts`), so the test is deterministic.

The test proves:
1. every finding raised quotes a passage that is exactly in Book 4's pinned version, and cites a fact that exists in the pinned canon (a finding with no passage, or a quote not in the text, or no cited fact, is refused);
2. a finding the assistant cannot ground is refused, and the assistant cannot approve a proposal, dismiss or close a finding;
3. the Author **fixes** one (re-check closes it), **dismisses** one (reason required, not raised again), and **accepts one as canon**, which creates a proposal the Series Lead approves, after which the fact is canon with this book's passage as its source;
4. an Editor or Author cannot approve a proposal (only `canon.approve` can), including their own; a role without `canon.read` sees nothing;
5. the same on a server Studio, through the Worker, with the Author's decisions made offline and sent in order;
6. the optional gate holds a stage move while a high-severity finding is open.

Manual (`M4-EXIT-TEST.md`): on a real series, seed canon, run the assistant over a real Book 2 against Book 1, and check that each finding can be verified by reading the two passages.

## Risks and how the plan handles them

| Risk | Handling |
|---|---|
| The assistant produces plausible but wrong findings | Strict form: a passage, a cited fact, severity and confidence; the author decides; dismissal needs a reason and is remembered. Cadrel never auto-fixes or auto-promotes. |
| Canon seeded wrongly poisons every later check | Seeded facts are *proposed*, reviewed by the Series Lead; canon is versioned and a fact can be superseded, never edited in place. |
| The series changes its mind (a retcon) | A retcon is a proposal that supersedes a fact with a reason; checks pinned to older canon keep their stamp, so history stays truthful. |
| Large series (hundreds of chapters, thousands of facts) cost the server | Facts and findings are read per series and per check, never studio-wide; the Worker lesson from three earlier CPU fixes applies: one read per card, measured before release. |
| Manuscript text sent to a hosted model | Only through the assistant the person already uses, subject to the per-project switch and the Studio's assistant policy. Cadrel adds no new route out. |
| Scope creep into a writing assistant | Not in scope (see below); the plan's "deliberately not built" list stands. |

## Not in scope

- Automatic extraction of canon by a model Cadrel runs itself, or any continuity judgement made without a person's decision.
- Style or prose-quality checks (the editing skills and M3 cover those).
- Checks across different series or a shared universe (one series is the unit).
- Translation or multi-language canon.
- Embedding-based retrieval in this milestone (decision 2): name, alias and full-text search first; semantic search later if findings are missed for lack of it.

## Decided (18 November 2026)

1. **Where the truth lives: records.** A fact is a record with a source passage; the series bible and character files stay the authors' writing, and seeding proposes facts from the ledgers.
2. **Embeddings: not in M4.** The assistant does the reasoning and Cadrel supplies exact, bounded context per chapter. Semantic search can come later if a real series shows missed findings.
3. **Who may run a check:** anyone holding `canon.propose` on the book (Author, Editor) and, since approval implies it, a Series Lead; only `canon.approve` approves canon.
4. **First release:** build straight through to the exit test and ship it together.
