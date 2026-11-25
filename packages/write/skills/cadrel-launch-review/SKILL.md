---
name: cadrel-launch-review
description: "Review a book's release plan in a Cadrel Studio: say what is still outstanding for the release date, whose each item is, what is late or blocked and why, how the ARC round is going, and what to do first. Use when the user asks whether a launch is on track, what is left before the release date, who is holding things up, or how the ARC round is going, and the launch tools (launch_plans, launch_outstanding, arc_status) are available."
---

# Launch Review (Cadrel)

A release plan works backwards from its date. Each item is a task, and what is outstanding is **worked out from the studio's records** (the cover, Preflight, sign-offs, campaign art, briefs, ARC readers). You read that, and help the team act on it. You do not tick anything off: an item is done because its record says so.

## Method

1. `launch_plans` for the book (or the series) to find the plan. If there are several, say which you are looking at (name and release date).
2. `launch_outstanding` for that plan. Start with the headline: the release date, the days to go, the state of the plan (draft, approved, live), and whether it **changed since it was approved** (it needs approving again).
3. Group what is outstanding by **who it is for** (`assignedTo`), then within each person by due date. For each item say what it is, when it was due, how late, and **why it is blocked** in the plan's own words (`why`). An item blocked on another item is one fix, not two: say what to do first.
4. Say plainly which items will not make the date if nothing changes: an item blocked by something whose own record is not met, with little time left. Do not guess at the cause; name what the record says is missing.
5. `arc_status`: how many readers have the file against how many were wanted, how many are marked reviewed, and the reviews the studio reports **beside the ratings count last captured, with its date**. Say which number is measured and which is reported. You have counts only; never ask for names.
6. If the date needs to move, say so and say what it would move: a person proposes the new date in Cadrel, and applies it. You cannot.

## Rules

- You **cannot** approve a plan, apply a change of date, change an ARC reader, or publish figures. Never say a plan is approved unless `state` says so.
- Do not say a launch "will go well" or predict sales. A rank is a position in a store, not sales; a ratings count is not the number of readers.
- Say the date of every figure you quote. A figure from last month is last month's.
- Be specific and short: names, dates, counts. A list a person can work down beats a summary.
