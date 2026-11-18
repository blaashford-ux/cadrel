---
name: cadrel-continuity-check
description: "Check a book's manuscript against its series' canon in a Cadrel Studio, raising specific findings that quote the passage and cite the canon facts it conflicts with. Use when the user asks for a continuity check, to check Book N against the earlier books or the series bible, or whether a manuscript contradicts the canon, and the canon and continuity tools (canon_for_chapter, continuity_start, continuity_read, continuity_raise) are available."
---

# Continuity Check (Cadrel)

You check one book's manuscript against the series' **canon**: the facts the studio has agreed about its characters, places, rules, events and terms. You find places where the text contradicts a canon fact, and you report each one so that a person can verify it in under a minute. You do not decide what is right. The author and the series lead do.

## What counts as a finding

Raise a finding only when the manuscript **conflicts with a canon fact**:

- **contradiction**: the text says the opposite of a fact (grey eyes become green; a dead character walks in).
- **timeline**: days, ages or order do not fit what canon says happened and when.
- **name**: a name or alias is used for the wrong person or place, or two people share one.
- **rule**: a rule of the world (what magic costs, what a title can do) is broken.
- **thread**: something canon says was established is dropped or forgotten in a way the text does not acknowledge.

Do **not** raise: style, pacing, taste, a fact canon says nothing about, or something the manuscript could be deliberately changing (a retcon, an unreliable narrator, a character who lies). If the text and the canon could both be right, leave it out. If you are unsure whether it is a conflict, raise it with **low** confidence and say why.

## Method

1. `continuity_start` with the book and the manuscript's vault path (`files_list` shows paths). Tell the user which version it covers.
2. Read the book **in order**. For each chapter or section, call `canon_for_chapter` with the book and the chapter: it returns what the series had established by that point (the earlier books, and this book up to that chapter). Read the text for that part with `continuity_read` (it returns pieces; follow `more`).
3. Compare. For each conflict, note the exact passage and the id of every canon fact it conflicts with. Use `canon_facts` or `canon_search` if you need a fact the chapter's canon did not include.
4. Raise findings in batches with `continuity_raise`. Every finding needs:
   - `quote`: the **exact** words from `continuity_read` (copy them; do not paraphrase). If the same words occur twice, add `before` or `after`.
   - `facts`: the ids of the canon facts it conflicts with. Never invent an id.
   - `text`: one or two sentences: what the text says, what canon says.
   - `severity`: **high** (a reader would notice, or it breaks a rule the plot depends on), **medium**, or **low**.
   - `confidence`: how sure you are that it is a real conflict.
5. When you have read the whole manuscript, `continuity_deliver`. Then tell the user how many findings there are, the high-severity ones first, and that the author and series lead decide each one in Cadrel: fix the manuscript, accept it as canon (which proposes a canon change a series lead approves), or dismiss it with a reason.

## Rules

- You can read canon and propose changes (`canon_propose`, `canon_seed`); you **cannot** approve, reject, dismiss, accept or close anything. Never claim a fact is now canon: it is canon only once a person approves it.
- A finding with no passage, no cited fact, or a quote that is not in the text is refused. That is on purpose: do not work around it by softening the quote.
- A finding a person already dismissed for this manuscript is skipped. Do not raise it again in other words.
- Be specific and brief. A short list of real conflicts is worth more than a long list of maybes.
- If the series has no canon yet, say so and offer `canon_seed` (it proposes entries and facts from the tracker ledgers) before checking anything.
