# M3 exit test: a manual walk-through on Windows

M3's exit test in [PLAN.md](PLAN.md) is: *one real book goes through a full edit inside Cadrel.* The automated half of it is `packages/shell/test/m3Exit.test.ts`: three people (an Author, an Editor and a Series Lead, each with their own role) on three computers against the real Worker code. That test runs a book through a **developmental, a line and a copy edit** and checks, at every step, that:

- the Editor's queries, comments and suggestions are anchored to the exact version of the manuscript they were shown;
- the pass cannot be marked responded while a query is unanswered, and the Author cannot close it (only someone with `edit.approve` can);
- the **Author's first round is made with no connection**: answers and decisions are kept on their computer, shown as made, and sent in order when the Studio is back;
- every decision is in the decision ledger, and a deferral makes a task dated for the revisit;
- the Author revises the manuscript in the vault and **misses one change they accepted**; the Editor compares the two versions and checks the revision, and the missed change is flagged;
- a workflow gate on Editing → Published holds the move until **all three passes are closed** and no query is unanswered, says what is missing at each step, and a **proofread never holds it** (a gate cannot even ask for one).

What that test cannot do is run in the real Electron app on Windows, with real fonts and a real e-reader, a real Claude Desktop, and a real Cloudflare account. This is the checklist for that. It takes about two hours with a real manuscript to hand.

**How to use it.** Work top to bottom; later parts use what earlier ones made. Tick each line. When something is wrong, note the part and line, what you did, what you expected and what happened, and a screenshot for a screen. Anything marked **(first time in Electron)** has been driven only in a Linux build under a virtual display, so look hardest there.

## 0. Before you start

- [ ] A Windows 10 or 11 PC with the build to test installed (a release candidate from `dev`).
- [ ] **A real manuscript**: a Markdown file of at least 20 000 words in at least five chapters (the longer the better; the comparison and scrolling are the parts that scale).
- [ ] A **second computer** (or a second Windows user) for the Author, and, if you can, a **real Cloudflare Studio** (Admin → Studio Manager). Parts 3 to 6 are meant for two people; Part 9 needs the real Studio.
- [ ] An **EPUB reader** you trust (Calibre, Apple Books, a Kobo) and a PDF viewer, for Part 1.
- [ ] Claude Desktop (or another MCP client) for Part 8.
- [ ] The build version (Settings): ______

## 1. Export fonts (Write)

*The heading font and body font are separate, and twelve fonts were added.*

- [ ] Open the manuscript in Write → **Export…** → the EPUB panel. There are two pickers: **Body font** and **Chapter heading font**. The heading font says "Same as body font" until you choose one.
- [ ] The body list includes Literata, Source Serif 4, Alegreya, Spectral, Merriweather, Lora, Gelasio, Crimson Pro, EB Garamond, and Libre Baskerville. The heading list includes Cormorant Garamond, Crimson Pro, Alegreya, Playfair Display, Marcellus, Fraunces, Spectral, Bodoni Moda. The preview line under each picker changes to the chosen face.
- [ ] Export an **EPUB** with body **Literata** and headings **Playfair Display**. Open it in two readers: chapter headings are in Playfair, body text in Literata. **(first time in Electron: the variable fonts)** If a reader shows a fallback font for Playfair Display, note which reader; it ships as a variable font, unmodified, because its licence names a Reserved Font Name.
- [ ] Unzip the EPUB: `OEBPS/fonts/` holds the font files **and an `-OFL.txt` for each** (`literata-OFL.txt`, `playfair-display-OFL.txt`). Open one: it begins with the font's own copyright line.
- [ ] Export a **print PDF** the same way. Open it in a viewer and check **File → Properties → Fonts** (or `pdffonts`): both families are listed and **embedded**.
- [ ] Choose **Marcellus** for headings (one weight): chapter headings look right (bold is synthesised, not missing).
- [ ] The installed app folder contains `assets\fonts\<family>\OFL.txt` for every family. Fonts are never offered on their own.

## 2. Rewrite mode (Write, desktop only)

- [ ] Open the project in Write. In the file tree, **right-click the manuscript**: the menu offers **Rewrite (Start From a Copy)** and **Rewrite (Start From a Blank Page)**, and no "Rewrite Mode".
- [ ] Choose **Start From a Copy**. A new file "`<name> (rewrite).md`" appears beside it, and two panes open: the original on the left labelled **Original, read only**, the rewrite on the right labelled **Rewrite**.
- [ ] Click in the original and type: nothing changes. Click in the rewrite and type: it does.
- [ ] **Scroll the original** a long way: the rewrite follows to the same paragraph. Scroll the rewrite: the original follows. Edit the rewrite so it is much longer than the original, then scroll both ways: they stay roughly level (matched by paragraph, then proportionally).
- [ ] Press **Linked** in either header: scrolling stops carrying across. Press it again: it carries again.
- [ ] Go to another chapter in one pane: the other pane goes to the same chapter.
- [ ] Press **Rewrite** in the header: back to one pane. Right-click the **original** in the tree: **Rewrite Mode: Turn On** brings both back. Turn it off from the **rewrite's** menu.
- [ ] **Rename** the original: the link follows (turn the mode on from the new name). **Delete** the rewrite: the link and the mode end and the original stays.
- [ ] Start a rewrite of a file that has **unsaved edits**: it asks Save / Don't Save first, and the copy matches what was on screen.
- [ ] Narrow the window to about 1000 px: the pane headers wrap and Save is still reachable.

## 3. Briefs (Projects)

- [ ] **Projects** → open a book → scroll to **Briefs**. As the Owner: **New brief**, kind **Edit brief**, a title, some text. Save. It shows "version 1".
- [ ] **Revise…**, change the text, add "What changed", **Save as version 2**. **Earlier versions** shows both, with who and when.
- [ ] Open the same book in a **second window** and revise from both with the same starting version: the second save is refused ("Someone else has revised this brief since you opened it").
- [ ] Sign in as an **Author** (second computer): the Briefs card shows the briefs of the book. **New brief** offers only the **manuscript** kind (an Author may write the manuscript brief but not an edit brief), and **Revise…** appears only on the manuscript brief.

## 4. Plan a pass and raise items (Editing)

- [ ] Put the manuscript in the vault (**Files** → add → check in) so it has a version, and make a **second version** (check out, change a few sentences, check in).
- [ ] **Editing** → **Plan a pass…**: choose the book, the manuscript, **Version to cover: Version 1**, kind **Line edit**, an editor, the edit brief. **Plan the pass.** The pass says "version 1, brief version 2" and "Planned".
- [ ] **Start.** Open **Read it and raise items**: the text is **version 1**, not the newest.
- [ ] **Select a passage** with the mouse, choose **A suggestion**, give replacement text, **Add to the pass**. It appears as item 1 with that passage quoted. Select a passage and raise a **query**; raise a **comment** ticking "About the whole pass".
- [ ] Try to raise a suggestion with nothing selected: the button stays off.
- [ ] **Deliver to the author.**

## 5. The Author's turn, and offline (two computers)

- [ ] On the Author's computer, **Editing** → "Waiting for you" lists the pass with "1 to answer" and "1 to decide". "Mark as responded" is greyed and says why.
- [ ] Open the pass so it is read once while connected. Then **turn the network off** (Wi-Fi off / unplug). The page says the Studio cannot be reached and shows what was last known.
- [ ] **Answer the query, and Accept, Reject… (with a reason) and Defer… (a reason and a date)** the suggestions. They show as made. The banner says "N answers and decisions are waiting to be sent".
- [ ] Try **Mark as responded**: it is refused (it needs the Studio).
- [ ] **Close and reopen Cadrel** (still offline): the waiting answers are still there.
- [ ] Turn the network on and press **Send now**. The banner goes away. On the Editor's computer, the answers and decisions are there, and the deferral has made a **task** on the Planner dated for the revisit and an entry in the book's **Decisions**.
- [ ] While offline, have the Editor **call off the pass**, then send the Author's waiting answer: the Author sees "The Studio did not accept an answer you made while away", with the reason and **their own words** to copy.
- [ ] **Mark as responded.**

## 6. The revision and the gate

- [ ] On the Editing page, the pass now shows **The revision**: a later version (version 2). Choose it, **Compare with version 1**: changes are shown side by side, a reworded phrase struck through and replaced, and long unchanged stretches as "N unchanged paragraphs". On your 20 000-word manuscript it appears in a second or two.
- [ ] **Check the accepted changes**: each accepted suggestion shows **Revision: made** or **Revision: missed**. Make sure at least one is missed (do not make one of the accepted changes in version 2).
- [ ] **Close the pass** as someone with approve rights (Series Lead, Director or Owner). The Author's page has no Close button.
- [ ] Repeat Parts 4 to 6 for a **developmental** and a **copy** edit (they can cover versions 2 and 3).
- [ ] **Admin → Workflows**: add a move **Editing → Published** with the gate **The developmental edit is closed**, **The line edit is closed**, **The copy edit is closed** and **Every editor's query has been answered**. There is no "proofread" gate and the page says why.
- [ ] On the book, try to move it to Published **before** the last pass is closed: it is refused and says "Needs a closed copy edit" (or "…is still under way"). Plan a **proofread** and start it: the move is **not** held for it. Close the copy edit: the move is allowed.

## 7. The Editing page itself

- [ ] The rail shows **Editing** after Planner. With no passes it says so and offers "Plan a pass…" only to someone who may plan.
- [ ] A role that cannot see passes (an Artist, Analyst or Finance role: they hold no editorial rights) gets "Your role does not let you see editorial passes", not an error. A Guest can read the passes of the one book they were given and nothing else.
- [ ] The list groups **Waiting for you**, **Under way**, **Done**, and each row says what it needs next. Click a book name: it goes to the book.
- [ ] Resize the window from wide to narrow: nothing is cut off.

## 8. The assistant (Claude Desktop)

- [ ] Install the Cadrel extension (Extensions → Claude Desktop). Ask Claude: "What editorial passes are under way?" → it lists them with project, kind, state and counts (`edit_passes`).
- [ ] "Read the text of the line edit and raise a comment about the second paragraph" → it reads with `edit_read` and raises with `edit_raise` on a pass that is **in progress** and **yours**. The item appears on the Editing page, anchored to the right passage.
- [ ] Ask it to **answer the author's query**, **accept a suggestion**, **deliver** or **close the pass**: it **refuses** and says those are for the person. (It has no such tool.)
- [ ] Ask it to quote something that is not in the text: it says the quote was not found. Ask it to quote a word that occurs many times: it asks for the words before or after.
- [ ] This works only for a Studio whose records are **on this computer**. Note that on a joined Studio the assistant has no editorial tools: this is known.

## 9. A real Cloudflare Studio (first time against Cloudflare)

*Everything so far in M3 has been tested against a stand-in for Cloudflare that runs the real Worker code, never a real account.*

- [ ] On a **real Cloudflare Studio** with the Studio's records on its server, repeat Part 4 (plan, raise) and Part 5 (offline and send) with two people on two computers.
- [ ] Admin → Studio Manager → **upgrade** the Studio's Worker: the schema version moves to 16. An app from before M3, opened against it, refuses and says to update Cadrel (a newer Studio is left alone on purpose); the upgraded app opens it normally.
- [ ] **Back up** the Studio's records, then **restore** them: the passes, items, decisions, briefs and revision checks are all back, with the exact versions they cover.
- [ ] Look at the Cloudflare dashboard's D1 read count over an hour of the Editing page being open: it should be small (the page does not poll).

## 10. What is not built

So a gap is not mistaken for a failure:

- Assistant tools for a Studio whose records are on its server.
- Unlocking the original in Rewrite mode, and showing rewrite links in the file tree.
- The Brief is not shown inside the pass view (only its version number).
- Beta-reader comments from Cadrel Reader stay a separate stream and do not become queries.
- Compare covers text manuscripts only (no `.docx`).
- **An Editor can approve and close their own pass**: the Editor role sits at the top editorial tier, which includes `edit.approve`. If a different person must approve, give the Editor a lower level or add a gate that needs a sign-off.

## 11. Result

- [ ] Every line above ticked, or each failure noted with part, line, expected and actual.
- [ ] Build version tested: ______  Tester: ______  Date: ______
