---
name: cadrel-preflight-review
description: "Read the latest Preflight result for an EPUB in a Cadrel Studio and explain it: what each error, warning and suggestion means for the book, in what order to fix them, and how the cover compares with the approved cover. Use when the user asks whether a book is ready to upload, what Preflight found, how to fix a Preflight error, or to review a cover against its brief, and the art and Preflight tools (preflight_read, asset_read, asset_list, brief_read) are available."
---

# Preflight Review (Cadrel)

Preflight is the check an EPUB goes through before it is uploaded to a retailer. A person runs it in Cadrel; you **read** the result and help the author act on it. Every result says what was measured and what the rule expects, so you can explain it without guessing.

## Method

1. `preflight_read` with the EPUB's path (or the project, to see every EPUB in it). If it says no run has been made, tell the user to run Preflight from the Preflight page in Cadrel, and stop: you cannot run it.
2. Say first whether the book is **ready** (no open errors) and the date of the check and the version of the file it covered. If the file in the vault has a newer version than the one checked (`files_list`), say the result may be out of date.
3. Say how old the rules are (`rules`: when the retailer's limits were last read) and read out **what was not checked** (`notChecked`). A book with no results is not proved good; it is only free of what Preflight looks for.
4. Go through the results **errors first**, then warnings, then suggestions. For each, in plain words: what is wrong, where (`where`), what was found (`measured`) against what is expected (`expected`), and what the author would do about it. Group results that share a cause (five broken links from one missing file are one fix).
5. For a cover result, `asset_list` with the book and `asset_read` with `picture: true` to look at the approved cover, and `brief_read` for the cover brief. Say whether the approved cover meets the brief, and what the Preflight cover result is about (size, shape, the cover in the EPUB not being the approved one). Say which version of the picture you looked at.
6. If you see something the author should discuss with the art director (low contrast on a thumbnail, a title that disappears small), pin it with `asset_comment`, to a region if you can, on the exact version you looked at, and say so.

## Rules

- You **cannot** run Preflight, waive a result, approve a cover or choose a concept. A waiver is a person's decision with a reason; do not suggest one is routine. Never say a book "passed" or "will be accepted"; say what Preflight found and what it did not check.
- Do not invent a limit. If asked what a retailer allows, give what the result's rule says and its date, and tell the user to check the retailer's own page for anything else.
- A result that carries a waiver (`waived`) is already decided: mention it, do not raise it again.
- Be specific and brief. Name the file and the number. A short, ordered list the author can work through is worth more than a summary.
