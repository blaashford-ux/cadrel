# M6 exit test: a manual walk-through on Windows

M6's exit test in [PLAN.md](PLAN.md) is: *a release is planned, executed and reviewed from one record.* The automated half of it is `packages/shell/test/m6Exit.test.ts`: six people (Marketing, a Director, an Art Director, an Artist, an Author and Finance) on a Studio running the real Worker code, and Marketing's assistant played by the real MCP tools through the app's local door. It proves:

- a plan from the "Ebook launch" template gives each item a task due **exactly that many days from the release date**, with the template's dependencies, in the Planner;
- **what is outstanding is computed from the records**: with no approved cover the cover item is blocked and says why; approving a cover (M5) clears it and ticks its task with no one marking anything; a Preflight error holds the preflight item and the upload that waits for it;
- approval is of an **exact revision**; **moving the release date proposes** new due dates, leaves done items alone and changes nothing until it is applied, and applying it sends an approved plan back for approval;
- the campaign **asks Art for a banner** with a spec; a file of the wrong size is refused with **what was found**; the right one is delivered, and fulfils the request only once a version is approved, which also clears the plan's "campaign art" item;
- a marketing brief **pins its comps' figures as of their capture dates**; a later capture does not change it;
- the ARC round: the **Author sees counts and no names or emails**; Marketing sees the people; no rating is kept for any reader; erasing a reader removes their details and keeps the count; the reviews the studio reports sit beside the measured ratings count;
- for a book that has launched, the review is filled from published figures at days 7 and 30 **with their capture dates**, day 90 says it is not reached, the planned targets are kept apart, and what was late is listed;
- a change of cover is recorded with the figures before and after (with the number of points), the price change in the same window is listed, and nothing says it caused anything;
- a role with no launch access (Finance) sees nothing; the assistant reads outstanding items, counts only, and figures with dates, and has no tool to approve, apply a date, change a reader or publish;
- the optional `launch_ready` gate holds a stage move while a required item is late or blocked, and says a plan is needed when there is none.

What that test cannot do is run in the real Electron app on Windows, with a real Market library, a real ARC round and a real Claude Desktop. This is the checklist for that. It takes about an hour. Use a real upcoming launch, or a copy of one.

## Before you start

- Cadrel with M6 in it, and each server Studio upgraded to **server revision 12** (Admin → Studio Manager → Upgrade). Until it is, the Launch page says it is unavailable.
- Your AI app connected to Cadrel (Extensions), with the new **Launch Review** and **Marketing Brief from Comps** skills and the launch tools showing.
- The book in the catalogue with an ebook edition **that has its ASIN** and is linked to its project, and some captures of it in Market on the computer you are using.
- You, as the Owner, and (if you can) a second person with the Author role on the book, and one with the Artist role.

## 1. A plan

1. Select the book in the top bar and open **Launch**. It follows the book you selected. **Plan a release**: the Ebook launch template, the release date, who is Marketing and who is Art. Open the plan.
2. Check **every item against what you know**: each task's due date is the right number of days from the date, and each is in the **Planner** under the right person.
3. **Outstanding for the date** lists the required items not done, each saying why in words. For each one, check the reason is true. Write down any that is wrong or missing: this is the number that matters.
4. Approve the cover on the Art page. Open the plan again: *Cover approved* is done, and what waited for it is no longer blocked. Run Preflight on the EPUB: the preflight item follows its result.

## 2. A date that moves

1. **Move the release date**, with a reason. Check nothing changed. The proposal lists each open item's old and new date; items you had already done keep theirs. **Apply**.
2. If the plan had been approved, it goes back to *Draft* and says it **changed since it was approved**; the Director approves it again, as it now stands.
3. As an Author, check you can read the plan but are not offered Approve, Move the date, or the readers.

## 3. Asking Art

1. **Ask Art** for a banner with a width and a height. As the Artist, open **Art requests** and offer an asset of the wrong size: it is refused with what was found. Offer one of the right size: it is delivered but the request says it is waiting to be approved. Approve it on the Art page: the request is fulfilled and the plan's campaign art item clears.

## 4. Briefs and comps

1. **Briefs**: write a marketing brief, open it and **Pin these comps** (a few ASINs from your Market library). Each shows rank, price and ratings **with its capture date and how old it was**.
2. Publish newer figures (**Market → Publish from this computer**): the brief says a newer figure exists and still shows the old ones until you **Pin the newer figures**.
3. Ask your assistant: *"Write a marketing brief for Book Four against these comps."* It should read the figures, say how old each is, and save a draft version. Open it: it is a new version, the earlier one is still there.

## 5. ARC

1. **Start an ARC round** (readers wanted, reviews hoped for). **Show the readers (logged)**, add a few, and move them through *Has the file* and *Reviewed*. The counts update. Enter the reviews you count yourself.
2. Check the page says no star rating is kept, and that the reviews you report sit beside the ratings count last captured, each labelled and dated.
3. **Erase their details** for one reader: the name and email go, the count stays.
4. As the Author, open the plan: counts, no names.

## 6. After the date

1. On a book that has launched, **Mark it live** (the plan must have been approved at its current revision), then **Open the review**. Check each figure against Market: the day, the capture date, the rank, price and ratings; a day not yet reached says so. Write what worked and what did not; **Close the review**.
2. **Market → record a change** (a cover or a price). Open **What the figures did around it**: the points before and after, the other changes in the same days, and the caveats. Check it never says the change caused anything.

## 7. The assistant and the gate

1. Ask: *"What's left before the launch on the 14th?"* It should answer from the outstanding list, by person, with why each is blocked, and say what to do first. It must not tick anything off or promise how the launch will go.
2. In **Admin → Workflows**, add *Its release plan has no late or blocked required item* to a stage move. The move is held with the reason until the plan is clear.

## What to record

The number of outstanding items that were wrong or missing, the number of figures on the review that did not match Market, and anything on the page that took more than one click you did not expect. The first two decide whether the computed status is trusted.
