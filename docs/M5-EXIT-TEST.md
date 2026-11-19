# M5 exit test: a manual walk-through on Windows

M5's exit test in [PLAN.md](PLAN.md) is: *a cover goes brief → concepts → approval → used in Preflight and visible to Launch.* The automated half of it is `packages/shell/test/m5Exit.test.ts`: five people (an Art Director, an Artist, an Editor, a Series Lead and Finance) on a Studio running the real Worker code, and the Art Director's assistant played by the real MCP tools through the app's local door. It proves:

- a cover brief with two versions; three concepts offered against version 2, each an exact file version against an exact brief version; feedback pinned to a region at an exact version (a region outside the picture is refused); the Art Director chooses one, and **only a person who may approve** can approve, including the Artist who uploaded it;
- approval names one exact version and its hash; a newer version of the file is **not** approved until someone approves it; an expired licence blocks a new approval and nothing else;
- where-used lists a declared listing and the EPUB that references the cover; a replacement is proposed, approving it **moves nothing** and marks each use "needs update", and the old version stays approved until someone takes it back;
- Preflight on an EPUB with planted defects finds them, each with what was measured and what was expected, worst first; a cover that is not the approved one is said so; fixing the EPUB and checking again clears it; a waiver needs a reason and carries onto the next run of the same file;
- what Launch will read: the approved cover (and its version) and the newest run, from the book or from the series above it;
- a person with no asset role (Finance) sees no asset, no brief and no result;
- the assistant can read assets and Preflight results, look at a picture, and pin a note to a region, and has no tool to approve, choose, retire, run or waive anything;
- the two optional gates (an approved cover; no open Preflight error) hold a stage move and say why, and open when it is put right.

What that test cannot do is run in the real Electron app on Windows, with a real Photoshop file, a real KDP upload and a real Claude Desktop looking at a real cover. This is the checklist for that. It takes about an hour. Use a real book that has an EPUB, or a copy of one.

## Before you start

- Cadrel with M5 in it, and each server Studio upgraded to **server revision 11** (Admin → Studio Manager → Upgrade). Until it is, the Art and Preflight pages say they are unavailable.
- Your AI app connected to Cadrel (Extensions), with the new **Preflight Review** skill and the art tools (`asset_list`, `asset_read`, `brief_read`, `preflight_read`) showing.
- You, as the Owner, and (if you can) a second person with the Artist role on the book.
- An EPUB exported from Write, checked into the vault in the book's project (the file's data card names the book), and the book in the catalogue with an ebook edition linked to its project.

## 1. Brief and concepts

1. Select the book (project and book in the app's top bar). Open **Art** in the rail. It follows the book you selected: there is nothing to choose. Open **Briefs and concepts**.
2. **A new brief**: a cover brief with a title and what you want. Open it, change the text, and **Save as version 2**. Open **Earlier versions**: version 1 is still there.
3. In the vault, put two or three pictures for the book (a JPEG, and a layered PSD if you have one) and check them in. On the brief, **Offer as a concept**. Check: only this book's own design files are offered, and a lone file is picked for you.
4. Each concept shows its picture (for a PSD, the picture saved inside it; if it was saved without Maximize Compatibility the page says so and shows its size). **Drag on a picture** to mark a part, and comment. The mark stays where you drew it. Check in a new version of the file: the old mark is still on version 1, not moved.
5. Sign in as the Artist. She can offer concepts and comment, and has no **Choose this concept**.
6. As yourself, **Shortlist** one, **Reject** one (a reason is needed), and **Choose** one. It appears under **Assets** *In review*. Choosing is not approving.

## 2. Approval, licence and uses

1. Open the asset. **Approve version N**. The asset is *Approved*, and the list says *version N approved*. Check in a newer version of the file: the list says *newer version not approved*.
2. Fill in the **Licence** with an end date a few days away. The asset and the Home view say how many days are left. Change the end date to yesterday: you can still see the asset, and **Approve** on a new version is refused with the reason.
3. **Add a use** (a listing, an ad). Add a reference from the EPUB to the cover on the Files page: it appears under **Where it is used** as a file.
4. Approve the newer version, then **Propose** a replacement of the old version with it. As the approver, **Approve** the replacement: nothing is changed, the use is marked *needs update*, and the old version is still approved. **Mark updated** when you have changed the listing; take back the old approval with a reason.
5. As the Artist, check that **Approve** is not offered.

## 3. Preflight

1. Open **Preflight**. It lists this book's EPUBs only. Pick the EPUB and the edition (a lone one is picked for you) and **Run Preflight**.
2. For **every** result, verify by eye that it is true: open the EPUB (or Calibre, or Kindle Previewer) and look at what it names (*Found*, *Expected*, the file it is in). Write down any that is wrong, and any that you can see and Preflight missed. This is the number that matters: a result you cannot verify from what the page shows is a failure of this milestone.
3. Check the notes at the top: *Limits last read from the retailer's pages on …* with where each came from, and **What this does not check**. Open KDP's own pages for the cover and description limits and confirm they are what the pack says; if they have changed, the pack needs updating.
4. Plant a defect: export the EPUB with a different title, or swap in a small cover. Run again: the error appears, with what was measured. Fix it, check in a new export, **Check again**: it clears.
5. **Waive** a result (a reason is needed). Run again on a new version of the same file: it arrives already waived, marked as carried.
6. If Java and epubcheck are installed (`EPUBCHECK_JAR`), run again: *epubcheck's messages are included.* Without it the page says it is not used.
7. With the book's `Marketing/Blurb.md` and `Marketing/Keywords.md` in the vault, the blurb length and keywords are checked; remove them and the run says none were found.

## 4. Home, the assistant and the gates

1. As the Art Director (or the Owner, on **Art view**), Home shows what waits: assets in review, concepts to look at, licences to renew, uses to update. As the Director, it shows *assets in review* and *books not ready to upload*.
2. Ask your assistant: *"Is Book Four ready to upload?"* It should read the latest Preflight result, say when the check was made and what it did not check, order the results errors first, and look at the approved cover. It must not say it passed or will be accepted, and it cannot run or waive anything.
3. Ask it to pin a note on the cover's title. It appears on the asset with the version it looked at.
4. In **Admin → Workflows**, add *Its latest Preflight check has no open errors* and *It has an approved cover* to a stage move. The move is held with the reason until both are true.

## What to record

The number of Preflight results that were wrong, the number you could see and it missed, any limit in the pack that KDP's pages no longer say, and anything on the Art page that took more than one click you did not expect. The first two decide whether the pack is trusted.
