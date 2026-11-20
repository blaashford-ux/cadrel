# M6: Launch and market, implementation plan

Status: **built on `dev` and not yet released** (20 November 2026; server revision 12, database step 24). The decisions below were taken on 20 November 2026 as recommended: ARC is tracked, not sent; market numbers are published to the Studio from a computer with the library; moving the date is a proposal; reader details are kept for managers and erasable; no rating is stored per reader; two releases. Planned against `dev` with M5 built. Scope comes from [PLAN.md](PLAN.md) section M6; roles in [PERMISSIONS.md](PERMISSIONS.md) (the Launch and Market rows); the connected book record in [ARCHITECTURE.md](ARCHITECTURE.md). Versions are not tied to milestones ([VERSIONING.md](VERSIONING.md)).

**Exit (from PLAN.md):** a release is planned, executed and reviewed from one record.

## What was built, and where it differs from the plan

All ten slices are built and tested (kernel 419, service 203, MCP 124, shell 386 including `m6Exit.test.ts`; the Launch page is also drawn and clicked in jsdom, `launchPage.test.tsx`). The manual walk-through is [M6-EXIT-TEST.md](M6-EXIT-TEST.md) and has no recorded run. Where the build departs from the plan below, so the plan is not read as describing what shipped:

- **A request's state is open, delivered or cancelled; "approved" is computed.** Whether it is fulfilled (delivered, meets the spec as measured, that version approved) is worked out when it is read, and its task is ticked then.
- **An ARC round's minimum is part of the template.** The plan's "send ARC copies" item asks for ten readers (fifteen for a series launch) to have the file; a manager edits the template to change that. The round's own target is separate.
- **The review is opened by a manager, not on a schedule.** The launch view on Home lists launches more than a month past release that have none.
- **The Market figures carry price, rank, ratings count and average, not categories.** The library's history does not hold them per capture; the column is there for when it does.
- **Names are compared and editions listed only when the catalogue can be read.** A role given only on one book cannot read the catalogue (a Studio-wide permission), as for Preflight; the exit test's Marketing holds the Studio and is assigned to the series.
- **`launch_ready` holds until every required item is done**, since an item that is only waiting counts as blocked. A plan needs to exist for it to pass.
- **Marketing can approve a plan** (managing launches includes approving them in the default roles) as well as the Director.
- **Not built as screens:** editing a template (the calls exist), creating a comp set or saving a report by hand (the assistant saves reports; the calls exist), and a Home calendar of releases beyond the Planner's tasks.
- **Not built:** offline use; ARC copies sent by Cadrel; retailer integration; money (M7).

## What this is for

A launch is a few dozen small jobs that depend on each other and on things other people make: a cover that is approved, an EPUB that passes Preflight, ARC readers who have a file, ad art the Art Director has asked for, a blurb, a price. Today they live in a spreadsheet and in people's heads, and nobody can answer "what is still outstanding for the 14th, and whose is it?" M6 makes the **release a record** that works backwards from its date, shows what is outstanding from the records M1 to M5 already hold, tracks the ARC round, asks Art for what the campaign needs, and, after the date, **reviews what happened against what was planned**, with the measured numbers kept apart from the estimated ones.

Market (research only since M1) becomes studio-facing: the comps a brief was written against, the category reports, and the history of changes to a book's cover, blurb, keywords and price, each with what happened after.

Principles carried over: the assistant proposes and people decide; measured is not estimated (every figure says where it came from and as of when); nothing replaces anything automatically (moving a release date *proposes* new dates); records point at exact versions (a plan's cover is a version of an asset, an ARC copy is a version of a file).

## What already exists and is reused

| Piece | Where | Used for |
|---|---|---|
| Capabilities `launch.read / comment / approve / manage`, `market.read / capture / manage` and their role rows (Marketing manages Launch, Director approves, Series Lead, Art Dir and Artist comment, Author reads; Analyst manages Market) | `kernel/capabilities.ts`, PERMISSIONS.md | who may do what; **no new capability** |
| Tasks, deadlines and dependencies (a task cannot finish while something it depends on is open; no loops), assignees, due dates, the Planner | `kernel/work.ts` | **a plan's items are tasks**, so they already appear in the Planner, the Dashboard calendar and each person's Home |
| Sign-offs by label ("Cover approved", "Ready to publish") that a workflow gate can ask for | `kernel/work.ts` (`approvedLabels`) | a plan item can require a sign-off |
| The decision ledger: never edited, a later decision supersedes it | `kernel/work.ts` | the reasoning behind a change of cover, blurb, keywords or price |
| Briefs: numbered versions, never overwritten, a stale revision refused | `kernel/brief.ts` | marketing and campaign briefs: add kinds `launch` and `campaign` |
| **The readiness contract of M5**: a book's approved cover (exact version), the newest Preflight run | `assets.readiness`, `preflight.latest` | "cover approved" and "ready to upload" on a plan, from records |
| Assets, concepts, approvals, licences | M5 | a campaign asset request is fulfilled by an approved asset |
| Catalogue: editions with ASIN, ISBN, price, `publishedOn` | `kernel/catalogue.ts` | the release date lives on the edition; a plan is for an edition |
| Figures published to the Studio's server by whoever holds the sales data (0.15.0: book finance months, read by authors for their own books) | `kernel/bookFinance.ts`, `shell/main/bookFinance.ts` | **the pattern** for Market figures: compact, dated, derived on the computer that has the library, published to the Studio |
| Shared captures: pages sent to the Studio's file store, each computer rebuilds its own index | `shell/main/sharedCaptures.ts` | the raw research stays as it is; M6 adds only compact figures to the records |
| Role-derived working views and their Home panel | `kernel/lens.ts`, `shell/main/lens.ts` | a fifth **launch** view for Marketing |
| Workflow gate conditions as data | `kernel/workflow.ts` | an optional `launch_ready` gate |
| The assistant's door, tools pattern, per-project switch and the Studio policy | `mcp/modules/*` | launch tools and two skills |
| Beta reading (invited, authenticated readers shown only the chapters switched on) | M2 | **not reused** for ARC: ARC readers are outside the Studio, have no account, and get a finished file |

**Not reused, on purpose:** the Market library's pages and parsing stay on each computer. The Studio's records hold **figures**, not captured pages.

## Design

### Records (database step 24, server revision 12, `0024_launch.sql`)

- `release_template(id, studio_id, name, version, items JSON, created_by, archived_at)`: the phases of a launch as offsets from the release date. An item is `{key, title, offsetDays (negative before the date), role hint, required, requires: [..], dependsOn: [keys]}`. Two ship as defaults ("Ebook launch", "Series launch"); a person who manages launches edits them (a revision is a new version, as for briefs).
- `release_plan(id, studio_id, project_id /* the book */, edition_id, template_id, template_version, release_date, state: draft | approved | live | reviewed | cancelled, approved_revision, approved_by, approved_at)`. **Approval is of an exact revision** (a hash of the items and dates), so changing a plan after approval shows it as changed and asks again, as a replacement does for an asset.
- `release_item(id, plan_id, key, task_id, offset_days, required, requirement JSON)`: each item **is a task** (title, assignee, due date, dependencies, done), plus what it needs: `{kind: cover_approved | preflight_clear | approval(label) | asset_request(id) | brief(kind) | arc(minReaders) | manual}`. Evaluating a requirement is a pure function of the records, so "outstanding" is computed, never typed in.
- `date_proposal(id, plan_id, new_date, changes JSON, state: open | applied | rejected, by, at)`: moving the release date makes a proposal listing each item's old and new due date; applying it changes tasks in one batch. Done items keep their dates.
- `market_figure(id, studio_id, asin, captured_at, price, currency, rank, ratings, rating_avg, categories JSON, source: capture | kdp, published_by, published_at)`: one row per ASIN per capture time, **idempotent by (asin, captured_at)**. Derived on a computer with the library and published to the Studio, as book finance is. It carries no page text.
- `comp_set(id, project_id, name, asins JSON, note, created_by)` and `brief_comp(brief_id, brief_version, asin, role: comp | competitor | self, figure_id, note)`: a marketing brief names its comps and pins the figures it saw (as of those captures).
- `market_report(id, project_id, kind: category | keyword | cover_blurb, title, as_of, payload JSON, created_by)`: an immutable saved report (a person or the assistant compiled it); a later one is a new row.
- `asset_request(id, project_id, brief_id, kind: banner | ad | social | cover_variant | other, spec JSON {width, height, formats[], maxBytes, channel}, due, requested_by, assignee_id, task_id, state: open | in_progress | delivered | approved | cancelled, asset_id, delivered_version)`: asked of Art from the brief. **Fulfilled** when an asset (M5) exists, its file meets the spec as measured (size, format, bytes, read from the file's header), and a version is approved.
- `arc_campaign(id, plan_id, name, target_readers, review_target, send_by, review_by, file_id, file_version, state)` and `arc_reader(id, campaign_id, name, email, source, state: invited | sent | received | reviewed | declined | bounced, sent_at, reviewed_at, review_url, note, erased_at)`. The file is **an exact version** (the one Preflight cleared, by default). Reader details are personal data: see "ARC, privacy and retailer rules" below.
- `launch_review(id, plan_id, due_at, state: open | done, measured JSON, planned JSON, worked, did_not, next, by, at)`: the post-launch review. `measured` is copied from published figures at set days after release (7, 30, 90) with their dates; `planned` is what the plan expected (rank target, reviews target, readers); nothing is blended.
- `market_decision(id, edition_id, kind: cover | blurb | keywords | price | category | other, from_value, to_value, reason, asset_id, brief_id, decision_id /* the ledger entry */, decided_by, decided_at)`: the change that was made and why. **Outcomes are not stored as a verdict**: the page computes, for a decision, the published figures in the N days before and after (rank, price, ratings), shows the number of points on each side, and lists other decisions for the same book in the window, so a reader can see a cover change that coincided with a price change.

### Release plans, worked backwards

Creating a plan from a template for an edition with a date turns each template item into a task due `releaseDate + offsetDays`, with the template's dependencies as task dependencies and each item's requirement attached. The plan page shows items by phase with a status that is **computed**: *done*, *late* (open and past due), *blocked* (a dependency or requirement is not met), *outstanding* (open, not yet due). "Outstanding for the 14th" is one list: required items not done, each with whose it is and why it is blocked.

Requirements read the records M1 to M5 hold:

| Requirement | Met when |
|---|---|
| `cover_approved` | `assets.readiness` returns an approved cover for the book (and says if its licence has run out) |
| `preflight_clear` | the newest Preflight run on the book's EPUB has no open error |
| `approval(label)` | the book stands approved under that sign-off label |
| `asset_request(id)` | the request is fulfilled (above) |
| `brief(kind)` | the book has a marketing or campaign brief of that kind |
| `arc(minReaders)` | the campaign has that many readers with the file sent |
| `manual` | someone marks it done (the task is done) |

**Moving the date** creates a proposal, not a change: each open item's new due date is listed with the old, items already done are untouched, and anything that would now fall before something it depends on is flagged. The person applies or rejects it. **Approval** of a plan (go/no-go) is by someone holding `launch.approve` (the Director), and is of an exact revision.

### Marketing briefs from Market comps

A marketing brief is a `launch` brief (versioned text) with `brief_comp` rows: the comps chosen, and for each the **figures as of a capture date** (price, rank, ratings, categories) copied from published figures, so the brief reads the same later. A brief shows when its figures are older than a set age ("these comps were last captured 40 days ago"). The assistant can compile a brief draft from comps and cover/blurb research (a new brief version a person reads and keeps or reverts); it cannot publish figures or change a plan.

### ARC, privacy and retailer rules

- **Track, do not send (decision 1).** Cadrel records who was invited, who has the file, who has posted a review and when. Sending stays in the tool the studio already uses (an email, a distribution service). What the studio gets from Cadrel is the one record: how many readers, how many have the file, how many reviews against the target, which version of the file they hold.
- **No ratings are stored per reader, and nothing is gated on them.** A reader is `reviewed` or not, and when; the record never holds a star rating, and the plan never asks for a positive review. Retailers prohibit conditioning an ARC on a favourable review, and a tracker that stores ratings invites it. The page says so.
- **Reviews posted are reported by the studio, and cross-checked by a measured figure.** There is no retailer API. A count the studio enters is labelled "reported"; the ratings count in published Market figures is labelled "measured, as of its capture date", shown beside it.
- **Reader details are restricted.** Names and emails are read and changed only with `launch.manage` (Marketing, Owner); everyone who may read the plan sees **counts**, not people. A reader can be **erased** (name and email removed, the count kept, the erasure in the audit log). Reads of reader details are logged, as for royalties.

### Post-launch review and decision history

The review is opened by the plan on a set day after release and filled from published figures: rank and price points at 7, 30 and 90 days, ratings count, the ARC result against its target, and what was late. Each figure shows its capture date and whether it was measured or reported. The people write what worked and what did not. A change of cover, blurb, keywords or price is recorded as a `market_decision` (and in the ledger); the page then shows the before and after windows with their point counts and the other changes in the same window. It never says a change *caused* anything.

### Who does what

| Action | Needs |
|---|---|
| See plans, items, outstanding, counts of ARC readers, briefs, comps, reports | `launch.read` (and `market.read` for Market figures and reports) |
| Comment on a plan or item | `launch.comment` |
| Approve a plan, apply a date proposal for an approved plan | `launch.approve` |
| Create and edit plans, templates, ARC campaigns and readers, requests, reviews, decisions | `launch.manage` |
| Read or change reader names and emails; erase a reader | `launch.manage`, logged |
| Publish market figures from this computer's library; save a report | `market.capture` / `market.manage` |
| Fulfil a request (offer an asset against it) | `asset.write`, as in M5 |

The assistant can read everything its person can, draft a brief and a report, and pin a comment; it cannot approve a plan, apply a date proposal, change a reader, or publish figures.

## Slices

1. **Records (`0024_launch.sql`).** Tables above; kernel `launch.ts` (templates, plans, item requirements, date math, date proposals, revision hash), `arc.ts`, `marketing.ts` (figures, comps, reports, decisions, windows), `request.ts` (requests and the fulfilment check); briefs gain kinds `launch` and `campaign`. Tests as for `canon` and `asset`.
2. **Service, server, backup and move.** `launch.*` and `marketing.*` namespaces behind the capabilities above, the Worker namespaces, the remote proxy, `RECORD_TABLES`, move and backup. **Server revision 12, schema step 24**; the hand-synced migration mirror and the step expectations updated.
3. **Release plans.** Default templates, create from a template for an edition and date, items as tasks, computed status and outstanding, requirements from the M5 contract, date proposals, approval of an exact revision.
4. **Campaign asset requests.** Ask Art from a brief with a spec; fulfilment by an approved asset that meets the spec as measured; a Requests tab on the Art page; the request is a task for the assignee.
5. **Market figures, comps, reports and marketing briefs.** Publish figures from this computer's library (idempotent, dated); comp sets; saved reports; a marketing brief with pinned comps and a staleness note; a **Market** tab on the Launch page (the Market app's own view is unchanged).
6. **ARC.** Campaigns on a plan, readers with restricted details, the file as an exact version, states and dates, counts for everyone and people for managers, erasure, the reported-vs-measured review count.
7. **Post-launch review and decision history.** The review opened on schedule and filled from figures; decisions with before and after windows and the confounders listed.
8. **Screens.** A **Launch** page (plans for the project in view, each plan's timeline and outstanding list, ARC, requests, brief and comps, review, decisions) that follows the selected project and offers only its own files and editions; a **launch** view on Home for Marketing (launches in the next 30 days with what is late or blocked, ARC reviews short of target, requests waiting, reviews due) and "launches at risk" on the Director's Home.
9. **Assistant, skills and gate.** Tools `launch_plans`, `launch_outstanding`, `arc_status` (counts only), `market_figures`, `market_comps`, `brief_read`/`brief_draft`, `report_save`; skills **Launch plan review** and **Marketing brief from comps**; an optional gate `launch_ready` ("Its release plan has no late or blocked required item").
10. **Exit test.** `packages/shell/test/m6Exit.test.ts` against the real Worker code, plus `docs/M6-EXIT-TEST.md` for the manual run on Windows.

Order: 1 and 2 are sequential. 3 follows 2. 4, 5 and 6 can follow 3 in any order (4 needs M5's assets; 5 needs nothing of 4; 6 needs 3). 7 needs 3, 5 and 6. 8 follows each page's records. 9 needs 3 to 7. 10 last.

**Releases.** First release **slices 1 to 4** (plans that work backwards, outstanding from real records, and asset requests to Art). Second release **5 to 9** (Market in the Studio, ARC, review, the views and the assistant). If `packages/write` changes (new skills), the Reader's version moves with the release.

## Exit test (slice 10)

Fixtures: a series with a book and an ebook edition with a release date, five people (Marketing, Director, Art Director, Artist, an Author) and Finance, the M5 cover and EPUB fixtures, published market figures for the book and three comps, and a scripted stand-in for the assistant.

The test proves:
1. a plan from the "Ebook launch" template for a release date gives each item a task due **exactly that many days before the date**, with the template's dependencies, in the Planner;
2. "outstanding" is computed from the records: with no approved cover the cover item is blocked and says why; approving a cover (M5) clears it with no one marking anything; a Preflight error blocks the upload item until fixed or waived;
3. **moving the release date proposes** new due dates, leaves done items alone, flags a date that falls before a dependency, and changes nothing until applied; approval of the plan is of an exact revision and a change afterwards shows it as changed;
4. the campaign **asks Art for a banner** with a spec; the Artist offers an asset; a file of the wrong size is **not** fulfilment, with what was measured and expected; an approved asset of the right size is;
5. a marketing brief names three comps and **pins their figures as of their capture dates**; publishing newer figures later does not change the brief;
6. ARC: readers, states and dates; the **Author sees counts and no names or emails**; Marketing sees them and the read is logged; erasing a reader removes the details and keeps the count; no rating is stored; reported reviews sit beside the measured ratings count;
7. after the date the review is filled from published figures at 7 and 30 days with their capture dates, the planned and measured kept apart; a late item is listed;
8. a cover change is recorded as a decision with before and after windows, the point counts, and the price change that fell in the same window;
9. a person with no launch role sees nothing; the assistant's tools cannot approve a plan, apply a date, change a reader or publish figures; the same on a server Studio through the Worker;
10. the optional gate holds a stage move while a required item is late or blocked;
11. the Launch page offers only the project in view's files and editions (scope rule).

Manual (`M6-EXIT-TEST.md`): on a real upcoming launch, build the plan, run the ARC round and the asset requests, and check the outstanding list against what you know is actually left to do.

## Risks and how the plan handles them

| Risk | Handling |
|---|---|
| A plan that nobody trusts is worse than none | Status is computed from records, never typed; each blocked item says what blocks it; dates only move by a proposal a person applies |
| Market data lives on whichever computer captured it | Only compact figures are published, idempotently, with their capture date; the raw pages stay as today; a brief or review says how old its figures are |
| A before/after number is read as proof | Windows show point counts and the other changes in the window; the page never says "caused"; figures are labelled measured or reported |
| ARC readers' personal details leak | Counts for everyone, people for `launch.manage` only, reads logged, erasure supported, no ratings kept |
| ARC tracking becomes review gating | No per-reader rating stored; no plan item asks for a favourable review; the page states the retailers' rule |
| Templates drift from how the studio actually launches | Templates are data a manager edits, versioned; a plan keeps the template version it came from |
| Scope creep into email, social posting, ad buying | Not in scope (below) |
| The Launch page grows into a project-management tool | Items are tasks and appear in the Planner; the Launch page adds the release, not another task list |

## Not in scope

- **Money**: ad spend, budgets, returns on a campaign (**M7**). A request or a decision may mention a cost in words; nothing is summed.
- Sending email, running a newsletter, posting to social media, buying ads, uploading to a retailer; Cadrel tracks, it does not send or publish.
- Scraping reviews or any retailer API.
- Retailers other than those Market already captures.
- Print launches and audiobook launches (the template system allows them later).
- Offline use of the Launch page on a server Studio: reads of what was last synced work, changes need the server (as the Canon and Art pages).
- Anything that ranks or scores a launch.

## Open decisions (recommendation first)

1. **ARC delivery.** Track only (**recommended**); or Cadrel sends the file by email with a personalised copy per reader (needs Cloudflare Email Service, bounce handling, and per-reader files: a milestone of its own).
2. **Where market numbers come from.** Compact figures published to the Studio from a computer with the library, as book finance is (**recommended**); or each person reads only their own computer's library (a plan would show different numbers to different people).
3. **Moving a release date.** A proposal a person applies, listing each item's old and new date (**recommended**); or dates move automatically.
4. **Reader details.** Names and emails kept for managers, erasable (**recommended**); or counts only (no way to know who still needs a nudge).
5. **Ratings.** None stored per reader (**recommended**); or recorded, with the risk described above.
6. **Release split.** Two releases as above (**recommended**), or one at the end like M4 and M5.
