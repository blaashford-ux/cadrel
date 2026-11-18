# M4 exit test: a manual walk-through on Windows

M4's exit test in [PLAN.md](PLAN.md) is: *Book 4's manuscript is checked against Books 1 to 3 and the findings are specific and checkable.* The automated half of it is `packages/shell/test/m4Exit.test.ts`: three people (an Author, an Editor and a Series Lead) and a Finance role, the Editor's assistant played by the real MCP tools through the app's local door, a Studio on the real Worker code, and **five contradictions planted in Book 4** (an eye colour, a date, a broken rule of the magic, a name given to the wrong office, a dead character who walks in). It proves:

- every finding the records hold quotes a passage found at the place it says in the exact version of Book 4 that was checked, and cites canon facts that exist; one whose passage is not in the text, whose fact does not exist, that cites no fact, or that says nothing is **refused**, and not one of a refused batch goes in;
- the assistant's tools have no way to approve, reject, dismiss, accept or close anything, and none to add findings once a check is handed over;
- the Author **fixes** a finding (a later version of the manuscript is checked in, a re-check finds the passage gone), **dismisses** one (a reason is required), and **accepts one as canon**, which makes a proposal the Editor and the Author cannot approve and the Series Lead can; approving it makes the new fact canon with Book 4's passage as its source and retires the old one;
- the Series Lead, who may approve canon, decides the rest;
- a role without canon access (Finance) sees nothing of it;
- a workflow gate on Editing → Published holds while a high-severity finding is open, says how many, and opens when they are all decided; and a second check of the same manuscript **does not raise again** what a person dismissed, while the gate waits for it to be finished.

What that test cannot do is run in the real Electron app on Windows, with a real Claude Desktop reading a real manuscript. This is the checklist for that. It takes about an hour. Use a real series, or a copy of one: three finished books and a fourth.

## Before you start

- Cadrel 0.19.0 or later, and each server Studio upgraded to **server revision 10** (Admin → Studio Manager → Upgrade). Until it is, the Canon page says canon is unavailable.
- Your AI app connected to Cadrel (Extensions), with the new **Continuity Check** skill and the canon tools showing.
- You, as the Owner, and (if you can) a second person with the Author role on Book 4.

## 1. Canon

1. Open **Canon** in the rail. Choose the series. It is empty.
2. Ask your assistant: *"Propose canon for Dragon Rider from its tracker ledgers"* (`canon_seed`). It first says what it would propose; ask it to apply. Open the **Proposals** tab: entries are waiting. **Approve** them. Ask it again: now the facts are proposed. Approve a few and reject one with a reason.
3. Add an entry yourself with **Add an entry…** (it says *Add to canon* because you may approve), and add a fact to it with **Add a fact…**, saying the book and chapter it was established in.
4. Check: each fact shows where it was established; a fact with a source passage shows the quote and the file and version it is in. **Replace** a fact: the old one disappears from the list and the new one is there. Open Proposals: both changes are in *Decided*.
5. Sign in as the second person (Author on Book 4 only): they can read the whole series' canon, can **Propose** (the buttons say Propose, not Add to canon), and cannot Approve.

## 2. A check

1. Ask your assistant: *"Run a continuity check of Book Four, book4.md, against the series' canon."* It should start a check, read canon chapter by chapter, and raise findings.
2. Open **Canon → Continuity checks**. The check is *Waiting for decisions* once it is handed over (until then: *The assistant is checking*). Open it. For **every** finding verify by eye, in under a minute:
   - the passage shown (marked) is really in the manuscript, in its surroundings;
   - the canon fact beside it is really the fact it conflicts with, with where it was established;
   - severity and confidence are plausible.
3. Note how many are real, how many are wrong, and whether any were missed. This is the number that matters: a finding that cannot be verified from what the page shows is a failure of this milestone, so write it down.
4. Ask the assistant to raise a finding with a made-up quote. It must be refused with a reason.

## 3. Decisions

1. **Fix**: correct one passage in Book 4 (check it out, edit, check in). In the check, **Re-check version N**: the finding becomes *Fixed* ("No longer in version N").
2. **Dismiss** one: a reason is required. Start a second check of the same manuscript and ask the assistant to run it again: that finding is not raised again.
3. **The manuscript is right…** on one: choose the fact it replaces, say what canon should now say, **Propose the change**. As the Series Lead, open **Proposals**: it is there, marked as from a finding. Approve it. Back in the check, the finding shows the proposal as approved; in Canon the new fact shows Book 4 as where it was established.
4. **Close the check** is disabled while any finding is open, and works when none is.

## 4. The gate (optional)

1. In **Admin → Workflows**, add the condition *Its latest continuity check has no open high-severity finding* to Editing → Published. 
2. Try the move on Book 4 with no check: it says *Needs a continuity check*. With a check being made: *still being made*. With a high finding open: *N high-severity continuity findings are still open*. When all are decided: the move is allowed.

## 5. On the Studio's server

Repeat 1 to 3 as a member on a second computer (and on your phone, to see that canon is not offered there, since it is a desktop page). Check that a person with only a role on Book 4 can read and propose canon but not approve, and that a role with no canon access sees the page say so.

## What to write down

For the record (the plan has no recorded run of this): the series and books used, how many findings, how many were real, any real contradictions it missed, any finding that could not be verified from the page, and anything on the screens that was confusing.
