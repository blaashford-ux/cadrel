# M3: Editorial, implementation plan

Branch: `ccr-7ecf360c-88oe1a`, cut from `dev` (0.6.1 at the time). Scope comes from [PLAN.md](PLAN.md) section M3 and the Editorial records in [ARCHITECTURE.md](ARCHITECTURE.md). Delivered as small PRs into `dev`, one per slice below, each with tests. Versions are not tied to milestones ([VERSIONING.md](VERSIONING.md)).

## Already in place
- Capabilities `edit.read`, `edit.respond`, `edit.approve`, `edit.run`, `edit.assign` (kernel `capabilities.ts`); `brief.write` sits under assets.
- Vault versions (`file_version`), approvals and the decision ledger, workflow gates with an `approved` condition, comments on projects.
- Editing skills and Cadrel Reader leave notes and comments, but nothing is tied to a version.
- Latest migration is `0011_server.sql`, so M3 starts at `0012`.

## Slices

1. **Briefs** (`0012_brief.sql`). `brief(kind: manuscript | edit, project, body, version)`, versioned and append-only. Kernel type and service methods, `brief.write` for edit briefs held by editorial managers. Home screen: a Brief tab on a book.
2. **Edit passes** (`0013_edit_pass.sql`). `edit_pass(kind: developmental | line | copy | proof, project, brief, file, version, editor, state)`. The pass pins the exact `file_version` it covers. States: planned, in progress, delivered, responded, closed. Assign with `edit.assign`, run with `edit.run`. Audit log entries on every transition.
3. **Anchored queries and comments.** `query(pass, anchor, text, author_response, state)`. An anchor is a version plus a text range with quoted context, so it survives re-opening a later version (re-anchored by quote; flagged when it cannot be). Cover Write's note format so existing editing-skill notes import as queries.
4. **Decisions.** `change_decision(query | change, accept | reject | defer, reason)`. Reason required for reject and defer. Writes to the decision ledger; defer carries a revisit date as a task.
5. **Compare and verification.** Side-by-side compare of two `file_version`s (paragraph-level diff, in the UI package). Revision verification: for each accepted change, mark made, changed or missed by matching against the new version; the result is stored on the pass.
6. **Gates.** New workflow gate conditions: `pass_closed(kind)` and `queries_resolved`. An approved pass (`edit.approve`) unlocks the next stage. Default workflow gains the conditions as optional, not forced on existing studios.
7. **Server and offline.** Same service runs in the Worker (checks stay on the server); migrations shared with the desktop cache; passes and queries readable offline, responses queued for reconnect.
8. **Screens and assistant tools.** Editor dashboard (passes assigned, queries open), Author view (respond, decide), MCP tools for reading a pass and adding queries so the editing skills can write structured queries instead of free notes.
9. **Exit test** (`docs/M3-EXIT-TEST.md` plus an automated two-client test): one book goes through developmental, line and copy passes; the author answers every query; compare shows the changes; verification flags a missed change; the gate opens only when all passes are closed.

## Order and dependencies
1 → 2 → 3 → 4 are sequential. 5 needs 3 and 4. 6 needs 2 and 4. 7 and 8 follow once the records are stable. 9 last.

## Open questions for the owner
- Do proof passes block publishing, or only advise?
- Should beta-reader (Reader) comments become queries, or stay a separate stream?
- Is compare limited to text manuscripts, or must it cover docx imports in the first cut?

## Not in scope
Canon and continuity checks (M4), art review (M5), any change to roles beyond using the existing editorial capabilities.
