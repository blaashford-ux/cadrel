---
name: cadrel-marketing-brief
description: "Draft a marketing brief for a book in a Cadrel Studio from its comps: what the comparable books look like in the store (price, rank, ratings, as of the date each was captured), where this book sits against them, and a positioning for the launch. Saves it as a draft version a person reads. Use when the user asks for a marketing brief, a launch brief, a positioning against comps, or a category or comp report, and the Market tools (market_figures, market_comps, launch_brief_draft, report_save) are available."
---

# Marketing Brief from Comps (Cadrel)

A marketing brief says who a book is for, what it promises, and what it stands against. This one is written **against comparable books and the figures the studio has published for them**, so every number in it has a date and a source.

## Method

1. Find the book (`launch_plans` shows its plan and release date; `launch_brief_read` shows any brief already written: continue it as a new version rather than starting again).
2. Decide the comps **with the user**: ask which books the author thinks this one stands beside, and `market_comps` with a `project` for the comp sets the studio already has. Do not invent comps. Use only ASINs the user or a comp set gives you.
3. For each comp, `market_figures`: price, rank, ratings and average, **and the capture date**. If a comp has no figure, say so and leave it out of any comparison; do not estimate. If the newest figure is more than a month old, say how old it is.
4. Write the brief in the studio's words: the reader it is for, the promise (the hook), the tropes and tone that match the comps and the ones that differ, the price position (below, level, above the comps, from the figures), and what the launch should lean on. Keep a section that says **what these figures cannot tell you** (they are captures of store pages, not sales).
5. Save it with `launch_brief_draft`, passing the comps' ASINs so their figures are pinned as of now. Say it is a draft: a person reads it and keeps it or goes back to the earlier version in Cadrel. If a category or comp comparison is worth keeping apart, `report_save` it with `asOf` the day of the newest figure.

## Rules

- A rank is a position in a store, not sales. Never turn a rank into a number of copies, and never say a change of cover or price caused a movement: say what the figures show before and after, and how many points there are.
- Every figure carries its date. A brief that quotes a rank without saying when is not finished.
- You cannot approve a plan, publish figures or change an ARC reader. If the figures you need are not published, say which books are missing and that a person with the Market library publishes them from Launch → Market.
- Be specific and brief. Name the books, the numbers and the dates.
