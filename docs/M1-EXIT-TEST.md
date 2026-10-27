# M1 exit test: a manual walk-through on Windows

Everything in M1 is covered by automated tests except the one thing those tests cannot do: run inside the real Electron app on Windows. This is the checklist for that. It takes about 90 minutes with a real KDP report and a real MDEdit project to hand.

It follows the exit test in [PLAN.md](PLAN.md): *create a series of three books, assign people and deadlines, see the pipeline and calendar, see the same book's manuscript progress and KDP earnings on its record, and open that book from My Books to reach its Market and Finance records and save them; back up a Studio, restore it on a clean profile, and import a real MDEdit project with its chapters, goals, notes and settings intact.* The extra parts (vault, sign-off gates, assistant) cover what was built along the way and has only been tried in a browser or in tests.

**How to use it.** Work top to bottom; later parts use what earlier ones made. Tick each line as you go. When something is wrong, note the part and line number, what you did, what you expected and what happened, and a screenshot if it is a screen. "Expected" is written so that a deviation is obvious. Anything marked **(first time in Electron)** has never run in the real app, so look hardest there.

## 0. Before you start

- [ ] A Windows 10 or 11 PC with the build to test installed (a release candidate from the `dev` branch).
- [ ] A **clean profile** for Part 9: a second Windows user, or a PC that has never had Cadrel. Part 1 to 8 use your normal profile.
- [ ] A **real KDP royalty report** (the `.xlsx` from KDP Reports), and, if you have one, the Payments report.
- [ ] A **real MDEdit project** with chapters, a word-count goal, a few review notes and at least one chapter marked edited. Keep the MDEdit original: nothing here should change it.
- [ ] Claude Desktop (or another MCP client) for Part 10.
- [ ] Note the build version (Settings) here: ______

## 1. Start-up and the Studio

- [ ] Cadrel starts without an error dialog. The rail shows Home, My Books, Dashboard, Planner, Projects, Files, Notes, then Write, Market, Finance, then Extensions, Admin, Settings.
- [ ] Home says "Here is where your studio stands" and shows the one-line summary (open tasks, late, due in two weeks), possibly all zeros.
- [ ] Settings → folders shows a Cadrel folder, the Studio folder inside it, and Projects, Write and Market folders. Nothing asks you to set anything up first.
- [ ] Admin opens (you are the Owner). It has People and roles, Workflows and the manuscript templates.

## 2. People, roles and the workflow (Admin)

- [ ] **People and roles → People:** you are listed as Owner. Add two people, "Bo Lin" (employee) and "Cy Dunn" (contractor). Give Bo the **Editor** role and Cy the **Series Lead** role for the whole studio.
- [ ] **Roles:** the twelve default roles are there. Open Editor: the capability checklist shows plain-language descriptions. The Owner role cannot be edited.
- [ ] **Explain access:** pick Bo, the action "Assign tasks to other people" and the studio. It says not allowed and names why. Pick Cy: allowed.
- [ ] **Workflows:** one workflow, "Writing and publishing", is the default for projects and for subprojects. Its stages are Planning, Drafting, Revising, Editing, Published, On hold, in that order.
- [ ] Create a second workflow "Series flow" with three stages (Concept, Running, Complete). Add the moves Concept → Running and Running → Complete.
- [ ] On Running → Complete, open the gate and require **"The project needs: no open tasks"** and a **sign-off** labelled "Series complete". Save.
- [ ] Make "Series flow" the default **for new projects** only. In the list, "Writing and publishing" now shows it is the default for subprojects.

## 3. A series of three books (Projects)

- [ ] New project "Dragon Rider": the New project dialog has a **Workflow** list, preset to "Series flow", and says it cannot be changed later. Kind "Series". Create it.
- [ ] Select it → **Add subproject** three times: "Lead Me", "Follow Me", "Hold Me", kind "Book", manuscript folder template "Novel". The Workflow list is preset to "Writing and publishing" for subprojects.
- [ ] Each book has a manuscript folder in `<Cadrel folder>\<Studio>\Projects`. The Projects page shows the tree with a coloured stage dot on each project.
- [ ] Open a book's page: the **Stage** card shows "Planning" and says the workflow was fixed when the project was made. There is no way to change the workflow.
- [ ] **Open in Write** opens the book's manuscript folder in Write. Write shows the project's stage as a read-only chip and has **no status control of its own** (also check Write's project settings).
- [ ] In Write, write a few hundred words in one book and set a word goal. Back in Cadrel the book's page shows its words and goal.

## 4. Tasks, deadlines, sign-offs, decisions

On "Lead Me":
- [ ] **Tasks and deadlines → Add:** task "Edit pass" assigned to Bo, due 7 days ago (type the date). It appears marked **late**.
- [ ] Add a deadline "Launch day" with a date 20 days ahead, assigned to yourself.
- [ ] (The page has no control for making one task wait for another; that is available to the assistant in Part 10 and is covered by tests.)
- [ ] Tick "Edit pass" done. It leaves the open list; **Show finished** shows it.
- [ ] **Sign-offs:** ask Bo and Cy for "Cover approved". The sign-off is pending and lists both names.
- [ ] You cannot answer it yourself (no Approve button for you). *If you want to test answering, use a second Windows user signed in as Bo: not possible in M1, so this is covered by tests only.*
- [ ] **Decisions:** record "Price" → "$4.99", context "Launch price". Use **Replace…** to record "$3.99". Only "$3.99" shows; **Show replaced decisions** brings the first back, marked replaced.

On "Dragon Rider" (the series):
- [ ] The Stage card lists the move to Running as open. Move it. Then the move to Complete is **closed** and lists both reasons (open tasks across its subprojects, and "Needs sign-off: “Series complete”"). Nothing moves.
- [ ] Ask yourself for a "Series complete" sign-off (you can now answer your own: you are the one asked). Approve it. The reason about the sign-off disappears; the open-tasks reason stays until Lead Me's tasks are done or cancelled. Cancel or finish them, and the move opens. Move the series to Complete.

## 5. Home, Dashboard, Planner

- [ ] **Home → Waiting on you** lists your deadline and any sign-off asked of you. The summary line counts match.
- [ ] **Dashboard:** the Work card's counts and the Late / Coming up lists agree with what you made. Pipeline shows projects per stage for each workflow. Books and Recent decisions show the decision you recorded. The project table has a Stage column.
- [ ] **Planner → Pipeline:** choose each workflow; cards sit in the right columns; a card opens its project.
- [ ] **Planner → Calendar:** this month shows "Launch day" in bold and the late "Edit pass" in the Late list. Previous/Next month and Today work. Switching **Whose work** to Mine hides Bo's task.

## 6. Market, Finance and My Books (first time in Electron)

- [ ] **Finance:** import your real KDP report. The royalty months appear. (If you have it, import the Payments report too.)
- [ ] **My Books** shows a banner: "N books from your KDP reports and Market are not in the catalogue yet." Click **Add them all**. They appear in the list, standalone.
- [ ] Create a series "Dragon Rider (published)" if you prefer the three real books there: open one, set **Series** and **Position** and press Move. Positions are unique: a taken position is refused with a message.
- [ ] Open a book. **In the catalogue:** change the subtitle, Save. **Editions:** the ebook edition has your ASIN; add a paperback edition with an ISBN: a wrong check digit is refused, a correct one accepted.
- [ ] **Project and manuscript:** link the book to the matching project from Part 3. The list and the book show its stage and manuscript progress. Unlink and relink works; linking a project already linked to another book is refused.
- [ ] **Listing and market / Sales and royalties / Splits / Payments** show the book's figures; they agree with Finance's own book page for the same book (open it with **Open in Finance**). Months resting on an estimated rate say so.
- [ ] **Open on Amazon** opens the book's Amazon page in your browser. **Open in Market** opens the Library at that book.
- [ ] **Save everything for this book…:** choose a folder. A new folder for the book appears with the Market exports, the earnings CSV, the payments files and each author's statement as CSV and PDF. Open one PDF and one CSV: they match what Finance's own Save buttons produce.
- [ ] A role without royalties (test later with a second profile, or note as untested) would see no Finance sections.
- [ ] Back on **Dashboard → Books:** the counts and last month's royalties agree with My Books.

## 7. The vault and Files (first time in Electron)

- [ ] **Files** opens and says where the working folder is (`<Cadrel folder>\<Studio>\Vault`). **Open the folder** opens it in Explorer.
- [ ] Copy `chapter-1.md` and `cover.psd` (any image/binary) into the folder. Files lists both as **Not in the vault**.
- [ ] **Add to the vault** for both. They show **Latest**, version 1. In Explorer, right-click one → Properties: **Read-only** is ticked. Try to edit and save it in an editor: Windows refuses.
- [ ] **Check out** `chapter-1.md`: state "Checked out by you", the file is writable. Edit it and save. Files shows "changed".
- [ ] **Check in…** with a comment. It becomes version 2, read-only again. Expand the file → **Versions** lists both with your comment. **Save a copy** of version 1 as `chapter-1-v1.md`: it appears beside the file with the old text.
- [ ] Check out and check in with **no change**: no new version is made.
- [ ] Check out, edit, then **Undo check-out**: the edit is gone and the file is back to the vault's version.
- [ ] Remove the read-only flag in Explorer, edit `cover.psd` outside Cadrel, save. Files says **Changed without a check-out** and **Get latest** reports it as left alone. **Discard changes** restores the vault's copy.
- [ ] **Uses and used by:** on `chapter-1.md`, add a reference to `cover.psd` (latest). Open `cover.psd`: it shows `chapter-1.md` under Used by. Check out and check in a new version of the cover: the reference's owner shows "newer version exists" and **Update to it** works.
- [ ] **Data card:** add fields "Licence" and "Trim size" to the cover, Save card, reopen: they are kept.
- [ ] **Force release** is offered (**Release…**) only on a lock held by someone else, so it cannot be tried with one person. Confirm there is no Release button on your own checked-out file. Releasing between two people is covered by tests and is exercised for real in M2.

## 8. Backup and restore (Settings → Backup and import)

- [ ] **Back up this Studio…** → choose a file. It reports the number of files and says it was read back and checked.
- [ ] **Open a backup…** on that file: it shows the Studio name, date, file count and the projects in it.
- [ ] **Restore into this Studio** for one project: it comes back as a new name (never overwrites). Open it on the Projects page.
- [ ] **Restore everything as a new Studio** named "Restore test": the Studio menu on Home now offers it. Switch to it: the projects, notes and settings are there. Switch back.
- [ ] Confirm the backup file contains no keys or tokens (open it with a zip tool and search for "token" and "secret": nothing but names of things).

## 9. A clean profile: restore and MDEdit import (first time in Electron)

On the clean Windows profile, with Cadrel installed:
- [ ] Start Cadrel: it creates its folders without a setup wizard.
- [ ] **Open a backup…** (copy the backup file there) → **Restore everything as a new Studio**. Switch to it. Projects, notes, settings and the Studio's records are present: the people (you as Owner under your original name), workflow definitions, catalogue books, tasks and sign-offs, decisions, and Files with its version history. A file you had checked out with unsaved work comes back checked out, with that work in the Vault folder.
- [ ] **Import from MDEdit → Choose MDEdit projects…**: choose your real project's folder (or the Root Folder). The preview lists its chapter files, size, "with a goal", review files, and what is **not** carried over.
- [ ] **Import**. The project appears on the Projects page. Open it in Write and check against the MDEdit original: **chapters** identical, **word-count goal** and deadline kept, **active manuscript** kept, **review notes** present, **edited chapters** still marked, **style sheet and book settings** kept.
- [ ] The project is in the **default workflow's first stage** (MDEdit's own status is not carried over: note whether that surprises you).
- [ ] The MDEdit original folder is **untouched** (compare modified dates, or open it in MDEdit).
- [ ] Importing the same project again offers **Import another copy** and does not overwrite.

## 10. The assistant (first time in Electron)

- [ ] **Extensions:** install the Cadrel extension into Claude Desktop (or connect another client). Restart the client.
- [ ] In the client, ask: "What are my open tasks, and which are late?" It uses `work_tasks` and answers with the tasks from Part 4.
- [ ] Ask: "Add a task 'Proof the blurb' to Lead Me due next Friday, assigned to me." It is added (check on the project's page). The audit log records that it was made through the assistant; the app has no audit screen yet, so this is covered by tests only.
- [ ] Ask it to **approve** the "Cover approved" sign-off, to **record a decision**, to **move the series to Complete** and to **check out a file**. For each it says it cannot and the person must do it in Cadrel.
- [ ] Ask: "List my books and the project each is made in." It matches My Books. Ask for the vault's files: it lists `chapter-1.md` and `cover.psd` with the reference between them.

## 11. Things that must not happen

Tick if you saw **none** of these during the whole walk:
- [ ] A crash, a blank page or an unhandled-error dialog.
- [ ] A refusal with no explanation (every refusal should say why).
- [ ] A file overwritten without being asked (vault, backup restore, MDEdit import).
- [ ] A number on Home or the Dashboard that disagrees with the page that owns it.
- [ ] Anything labelled "status" in Write (it should show Cadrel's stage only).
- [ ] The Windows window controls hidden or overlapped by page content.
- [ ] A save, import or backup that reports success but leaves the file missing or empty.

## Results

| Part | Passed | Failed / notes |
|---|---|---|
| 1 Start-up | | |
| 2 People, roles, workflow | | |
| 3 Series of three books | | |
| 4 Tasks, sign-offs, decisions | | |
| 5 Home, Dashboard, Planner | | |
| 6 Market, Finance, My Books | | |
| 7 Vault and Files | | |
| 8 Backup and restore | | |
| 9 Clean profile, MDEdit import | | |
| 10 Assistant | | |
| 11 Must-not-happen | | |

M1 is done when every line passes, or each failure is either fixed or written down as a known limit with a reason, and Part 11 is clear. File each failure as an issue titled `M1 exit test, part N: <what>`.

## What this does not cover (and why)

- **Two people at once**: a second person's sign-off, a force-release between two machines, role views as another person. One local Studio has one person; the multi-person flows run in tests and are exercised for real in M2, with the server.
- **Authors seeing only their own books**: needs agreements (M7).
- **Moving Write's manuscripts into the vault**, read-only workflow states for files, and syncing the vault: later milestones.
- **Contributions, credits, rights and revenue shares**: records and service only, with no screens until M7. Their tests are in `packages/kernel/test/business.test.ts` and `packages/service/test/business.test.ts`.
- **Performance** with hundreds of books or thousands of files.
