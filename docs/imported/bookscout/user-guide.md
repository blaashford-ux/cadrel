# BookScout user guide

BookScout is a private research notebook for Amazon Kindle books. You browse amazon.com as usual; a Chrome extension sends the pages you choose to the BookScout app on your own computer, which keeps them, reads them, and lets you (and Claude or GPT) analyse what makes books succeed in a category. Nothing is uploaded anywhere.

## 1. Install

1. Run **BookScout-Setup-x.y.z.exe**. Windows may show a "SmartScreen" warning because the installer is not code-signed: choose *More info → Run anyway*.
2. Start BookScout. On first run it asks for a **library folder**. This is where every captured page, cover, text and the index are kept. Choose a folder on a local drive with room to grow (a few GB is plenty for thousands of pages). Network drives are refused: the database needs a local disk.
3. Install the browser extension (Chrome):
   - In BookScout, open **Settings → Pair the browser extension → Open the extension folder**.
   - In Chrome open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked**, and choose that folder.
   - Pin the BookScout icon to the toolbar.
4. Pair it: in BookScout click **Show a pairing code**; in Chrome click the BookScout icon and type the 6 digits into **Pairing code**, then **Pair**. The code works once and expires after two minutes. (You can also paste the token by hand under *Enter a token by hand*.)

BookScout must be running for the extension to send pages. By default closing its window leaves it running in the system tray; use the tray icon to quit.

## 2. Capture pages

Only amazon.com Kindle pages are supported. You stay in control: BookScout never browses for you.

- **A bestseller list** (for example *Kindle Store → … → Humorous Fantasy → Top 100*): right-click the page → **Send to BookScout**. The extension scrolls to the bottom first so all 50 rows are loaded. Capture the **Paid** and **Free** tabs and page 2 separately if you want them.
- **A book page**: right-click → **Send to BookScout**. The page text, ranks, price, reviews on the page and the cover image are stored. Capturing the same book again later adds a new snapshot, which is how rank, price and review-count history builds up.
- **A search result page** (a Kindle Store search on amazon.com, for example from a *Amazon ↗* link on the Keywords tab): right-click → **Send to BookScout**. This is how the Keywords tab learns how crowded a phrase is.
- The toolbar icon shows ✓ when saved, ! on a problem (hover for the reason), ? if it is not paired.

### The queue

After you capture a list, the **Queue** tab shows the books on it that you have not captured yet, best rank first. **Open next** opens the next one in your browser (the default browser: make it the Chrome you capture from). Capture it with the right-click, then press Open next again. **Skip** only hides a book from the queue: the analyses and the MCP still count it as part of the category. If a book on a list is the wrong genre, use **Remove from category** instead: it is taken out of that category's lists, analyses, search and MCP results for good (it stays out when you capture the list again), and the **Removed from categories** table under the queue lets you **Restore** it. A book you captured stays in the library either way. To delete a book you captured by mistake, open it from the Library and use **Remove**: *Remove from library* deletes its pages, cover, text, notes and files, and *Remove from library and all categories* also takes it off every list so it does not come back into the queue. Analyses are computed from the library each time you open them, so they update straight away; the cover measurements and search-index entries of a deleted book are cleared at the same time.

## 3. The free sample (Look Inside)

Amazon shows the sample in a window whose content cannot be copied directly, so BookScout photographs it page by page and reads the pictures on your computer.

1. Open the book's page in Chrome.
2. Click the BookScout icon → **Start sample capture**. (This must be started from the icon: Chrome only allows screenshots after you click it.)
3. Click **Read Sample** on the Amazon page. A small black BookScout bar appears at the bottom left.
4. Turn the pages at a normal reading pace. Each page is saved once it has **stopped moving** (about two seconds). If a page is missed, press **Alt+Shift+S** to save the one on screen.
5. Click **Finish** on the bar. BookScout reads the pictures (a few seconds per page) and attaches the text to the book.

The book's **Text of the book** card shows how many pages were read, the reading confidence, and whether the "end of sample" page was reached. A sample is about the first tenth of a book, so everything built on it says so. Recognition on Amazon's real reader has not been tested; if a page reads badly, the card says so, and you can attach the real book file instead.

## 4. Add the whole book

Open a book in the **Library**, then drop a **PDF, EPUB, Word or text/Markdown** file onto the *Text of the book* card (or use **Choose file…**). Your original is kept. Scanned PDFs without a text layer are detected and flagged but cannot be read yet.

## 5. Read the results

- **Library**: every captured book in a table whose columns all sort (click the heading) and filter (the box under it; number columns accept `>100`, `10-50`, `blank`), with a *Rank* column (last rank on a captured list) and a *Store rank* column. Open a book for its history charts (rank, price, ratings), ranks, the description, the cover, and the text analysis.
- **Analysis**: pick a category and how many books count as "the top". It compares the top with the rest on price, length, freshness, series, packaging (titles and blurbs), tropes, what readers write about, covers, and the text itself, and gives each book a **success score**. The yellow-edged box at the top tells you what the numbers cannot yet show (for example how many books lack detail pages). Every chart has a *Show as table* link. **Export CSV** and **Export report** save the same figures for a spreadsheet or to read offline.
- **Community sources** (Analysis tab, under the category picker): type a subreddit (for example `cozyfantasy`) and press **Add**; add as many as you like. **Sync last 7 days** reads that week's threads and comments from the Arctic Shift archive, a day at a time, and adds them to your library; a progress bar shows the day, the step and the counts. **Stop** ends it and keeps the days already read, and **Resume sync** carries on after them. Run it again later to add more weeks. Only text, scores, post flair and dates are stored, never usernames. Once stored, the text can be searched here and by Claude through the MCP server, with a link to each thread. **Remove** deletes the subreddit's stored text (unless another category uses it).
- **Parser health**: a weekly view of how many captures had fields the reader could not find. If Amazon changes a page layout this is where it shows up first. After an update that fixes the reader, **Re-read all pages** repairs old captures (every page is kept in full).

A fair warning about the numbers: they describe what top books *have in common*, not what *caused* their success. Single captures cannot show trends; capture the same lists on different days to build history.

### Keywords

The **Keywords** tab helps you choose the words readers actually use. **Suggest Keywords**, at the top, offers five phrases for any category you have captured (pick it from the drop-down; click a phrase to search it): tropes its listed books carry, words that recur in their titles, and, if you have synced Reddit, tropes readers ask for. Amazon already reads the words of your category, title, subtitle and blurb, so suggestions leave out the category's words, and, if you pick one of your books under **Avoid words in**, that book's title, subtitle and blurb words too. Tropes tied to one readership are not offered to the other (reverse harem / why choose is women's romance, so it is skipped for a category whose name or subreddits are aimed at men). Below them, **Seven keyword strings for KDP** gives one string for each of KDP's seven keyword boxes (50 characters each, with a Copy button): a few related terms a reader would search together, with no word repeated across the boxes, none of the category's (or the chosen book's) words, no filler or words KDP does not allow ("best", "free", "new"). Terms readers ask for come first. Or type a phrase yourself and press **Look up**. Every search you run is kept under the **Search History** sub-tab, newest first: click one to return to its results without asking the services again. BookScout asks the Amazon Kindle-store search box, Google and Bing what people type after it, and shows one column per source:

| Column | What it is | What it is not |
|---|---|---|
| Amazon / Google / Bing | The phrase's place in that service's suggestions (`#1` is the most popular suggestion) | A search volume |
| Listed by | How many of those three suggest it | |
| Reddit | Mentions of the phrase in the subreddits you synced under Analysis → Community sources (hover for threads and per-1,000 rate) | How many people search for it |
| Trends | Google Trends' relative interest (100 = peak of the terms compared), from a CSV you import | Searches per month |
| Amazon results, Top-10 median ratings, Est. sales/day | From a search you captured: the result count, how many ratings the first ten organic books have, and estimated sales from the store ranks of those whose book pages you captured (a floor: books you did not capture are not counted) | A complete market size |

For the last two groups, use **Amazon ↗** beside a phrase (or **Search … on Amazon**) to open the search in your browser. The extension captures that page by itself once it loads (no click needed), and the columns fill in. Searches you open yourself still need the extension button or right-click "Send to BookScout". For Trends press **Compare top 5 in Google Trends**, use its Download button, then **Import Trends CSV**.

Lookups happen only when you press the button, and answers are kept for 7 days, so asking again costs nothing; **Refresh** forces a new request. If a service refuses requests it is left alone for ten minutes and the page tells you. Switch sources off in Settings. These are undocumented endpoints that can change without notice.

### Reader Community

Under **Analysis**, after you link a subreddit to a category and sync it (Community sources), the **Reader Community** tab turns that text into a basic analysis: the threads where people ask for books and the tropes they name; the phrases that keep coming up; which tropes are praised and which complained about; clauses where readers say what they avoid; which of the category's listed books they recommend; and, for each trope, how much it is talked about against how many of the listed books carry it (*talked about, few books* is where reader interest outruns what is on offer). Open any example to read the thread on Reddit.

It counts words, so read it as a pointer to threads worth reading, not as a verdict: a trope is counted wherever its words appear (including in "I don't like it"), praise and complaint are judged a sentence at a time, and the sample is one week per sync from people who chose to post. Each sync adds a week, so syncing on several days builds a bigger picture. Claude and GPT can read the same analysis with the `community_insights` tool.

### My Books

**Library → My Books** is your own catalogue. Import your KDP **Orders** and **KENP Read** reports there (kdpreports.amazon.com → the report → Download report; pick both files at once if you like) and every title in them is added, even before you have captured a single page. The table has the same columns as All books (title, author, rank, store rank, rating, ratings, price, captures, text), with **Pen Name** in place of the Mine star (the author name KDP reports each book under) and two more from your reports: **Orders** (paid units) and **KU pages read**. Every column sorts and filters; Pen Name has a drop-down of your pen names, which is the quickest way to look at one name's books. A book with 0 captures is one you have not yet sent from Amazon. For a collaboration both Author and Pen Name list every author (editors, illustrators and other roles Amazon credits are left out), and picking a pen name in the drop-down also shows the collaborations that name appears in.

To bring a book in, open it from the list, press **Open on Amazon**, and on the page that opens right-click → **Send to BookScout**. The book fills in, and its rank is used to calibrate your sales estimates (below). *Open next not captured* steps through the ones still waiting. A book that is not on a report can be added by ASIN, or marked as yours from its own page. Removing a book from My Books keeps its captured pages and imported sales.

### Charts, the Month view, and royalty splits

My Books has four tabs: **Books** (the table above), **Charts and analysis**, **Month** and **Royalties and splits**. They are fed by the KDP report workbook (kdpreports.amazon.com → Download report), whose royalty sheets hold the money; import a fresh one each month. Months overlap safely: a re-import replaces the months it covers.

- **Charts and analysis**: pick a range (last 6 or 12 months, this or last year, or any months). You get royalties by month split into eBook, print and Kindle Unlimited, units and pages read per day, every book's earnings and share, and breakdowns by marketplace, royalty rate (35%, 70%, 60%) and kind of sale (standard, Countdown Deal, free promotion, pre-order).
- **Month**: one month with everything in it: totals compared with the month before and the same month last year, every book with its change from last month, the daily charts, the breakdowns, and the Kindle Unlimited rate for the month.
- **Royalties and splits**: add the people who are paid, give each book a split (percentages that add up to 100; one split per book, covering eBook, print and Kindle Unlimited), and produce an **Author statement** for a month, quarter, year or custom range, with shortcuts for last month, this and last quarter, and this and last year. Save it as CSV (one author or all) or as a PDF (one author, or one PDF per author in a folder you choose). When you change a book's split, BookScout asks from which month it applies; earlier months keep the split they had. A book with no split belongs wholly to the author KDP reports it under. A paperback has its own ASIN but counts as the same book as the eBook with the same title.

**Payments.** Amazon does not pay each month's royalties when they are earned. It pays one lump sum in USD, two months or more after the sales, once a balance passes its minimum, and withholds tax. Download the **Payments** report from KDP Reports and import it on the **Payments** tab (or with the Import button on Books): every payment line (a sales month and either *Sales* or *Kindle+ Royalties*) is matched to the royalty reports, so BookScout knows which months are paid, the tax taken from each, and which are still waiting. It also fixes the Kindle+ rate of each paid month to the cent. Months in other currencies (pounds, euros, Canadian and Australian dollars, rupees) appear as *Earned but not paid yet* until Amazon pays them. Importing the same payment again (for example when your bank has reported the exchange rate and payout, which show as "pending" until then) replaces it.

**Author statements** have two bases, chosen above the period buttons. **Paid by Amazon in the period** (the default) splits every payment dated in the month, quarter or year, line by line using each line's sales month and the split for that month, on the net after tax: this is what you can pay out. **Earned in the period (by sales month)** shows what the books made; sales Amazon has paid are owed, and the rest are shown in brackets as estimates that are not owed yet. Authors are paid in USD, Amazon's figure; the conversion to your bank currency is on the Payments tab for checking the deposit. Without a payment report, statements fall back to royalties by sales month, marked as not checked. Lines where Amazon revised a month after paying it, and payment lines for months with no royalty report, are called out.

**Paying the collaborators.** Two more tabs turn what Amazon paid into what you owe each author.
- **Payments → open a payment → *Owed to collaborators from this payment***: the calculator. Every line of the payment is split by the percentages for the month it was earned in, after tax, and you see what each author is owed from that one payment (open an author for the lines). **Allocate this payment** freezes the amounts, so a later change of split cannot rewrite what was already worked out; allocate again to take a new split. Save the result as CSV or as a PDF per author.
- **Pay authors**: the quarterly roll-up (pick Last quarter, or any month, year or range). For each author it shows what is **unpaid from before**, what Amazon paid **in the period** (their share, before tax, the tax withheld, and what is owed), what you have **paid out** for the period, and **Due now**. Payments dated after today are not counted until they are received. Use **Allocate all** for the period's payments, **Record a payout** when you pay an author (it counts against the period, and any unpaid balance carries into the next one), and save a CSV or a payout statement (PDF) for each author.

How money is counted: eBook and print royalties are exact, in each marketplace's currency, and shown in USD at that month's exchange rate. The app ships with approximate rates; enter the rate you were actually paid at under **Exchange rates used** and it is kept and carries forward. Kindle+ (Kindle Unlimited) is pages read times a rate per page. KDP fixes a month's rate around the 15th of the next month; once your report includes the finalized month, BookScout works the exact rate out of it (the Summary sheet's royalty minus the royalty sheets'). Until then the last known rate is used and the lines are marked *estimated*. Kindle Unlimited for the current month is left out of statements entirely ("pending") until the month is over. You can override a month's rate on the Month tab. No expenses are deducted: statements split what KDP reports.

### Sales estimates and calibrating them

Estimated sales from a rank (on the Keywords tab and in Claude via `estimate_sales`) are shown as a range, because the published rank-to-sales rules disagree by a factor of two or more. To replace that with a range based on your own sales (**Settings → Sales estimates**):

1. **Download your sales once** from KDP Reports (kdpreports.amazon.com): choose the **Orders** report, set the dates (the longer the better), and **Download report**. If your books are in Kindle Unlimited, do the same with the **KENP Read** report. Drop each .xlsx or .csv in with **Import KDP reports…** under Library → My Books or here (a workbook that holds both works too). Importing also creates your books under My Books. There is nothing to enter daily; import a newer report now and then, and days that overlap are simply replaced.
2. **Ranks come from what you already do.** Each time you capture one of your own book pages with the extension, its Kindle Store rank is paired with your sales over the three days before. Spread your captures over good and bad days, and over several books if you have them. If you use a tool that exports rank history (a Date and a Rank column), **Import rank history…** adds that too.
3. **Check the fit and press Apply.** The table sets your fit beside the published methods at ranks 100, 1,000, 10,000 and 100,000, and the readings used are listed. *Reset to defaults* undoes it.

A few readings give a rough fit, so the range will be wide at first and narrows as you add captures and longer reports.

**Kindle Unlimited.** Borrows move a book's rank, but KDP reports pages read, not borrows. So BookScout estimates borrows as pages read ÷ the book's page count in KU (**KENPC**, shown in your KDP Bookshelf) ÷ the share of the book the average borrower reads. Enter each book's KENPC in the table that appears once a KENP report is imported (until you do, the print length from the page you captured is used and marked as a stand-in). The share defaults to 100%, which gives the *fewest* borrows the pages could mean, since many borrowers stop early; lower it if you know your read-through. With **Count Kindle Unlimited borrows as sales** ticked, the fit and all estimates then mean *sales plus borrows per day*: that is what a rank reflects, but it is not paid sales, so it will overstate revenue for a KU-heavy book. Untick it for a paid-only fit; the table shows both. Older author reports say Amazon counts a borrow like a sale for ranking; Amazon does not document it, so treat that as an assumption.

## 6. Use Claude or GPT with your library

1. **Settings → Search index → Download model and build index.** The first time this downloads a small language model (about 25 MB, once, from huggingface.co) so searches match meaning as well as words. *Build basic index* needs no download but matches less well. The index updates itself after later captures.
2. **Settings → Connect Claude or GPT**.
   - *Claude Desktop*: press **Install in Claude Desktop**: BookScout creates `BookScout.mcpb` and shows it in its folder. In Claude Desktop open Settings → Extensions, drag the file into the window (or Advanced settings → Install Extension…), click Install, then restart it. Don't open the file with "Claude" from a list of programs: that attaches it to a chat instead of installing it. If the extension reports that it couldn't start, `logs\mcp-launcher.log` in BookScout's settings folder says what happened. By hand instead: pick *Claude Desktop* below the button and paste the setting into `claude_desktop_config.json` (Settings → Developer → Edit Config).
   - *Claude Code*: run the command shown.
   - *Codex*: paste into `~/.codex/config.toml`.
3. Ask things like: "Use BookScout: what do the top 10 in Humorous Fantasy have in common?" or "Search the blurbs for found-family tropes." Answers cite the book and capture date.

Text from Amazon (blurbs, reviews) is passed to the AI as quoted material and labelled as such, so instructions hidden in a review are not followed.

## 7. Look after your library

**Settings → Library care**: *Check the library* (integrity, missing files), *Back up…* (a copy of everything except the downloaded model into an empty folder), *Move to another folder…* (copies, verifies, switches; the old folder is left for you to delete), *Show the log file*.

Everything lives in the library folder: `books/<ASIN>/` (pages, covers, text, screenshots), `lists/`, `user/user-data.json` (your tags, notes, queue state), `scout.db` (an index that can always be rebuilt from the files: *Settings → Rebuild index*).

### Updating
**About → Check for updates** looks for a newer release on GitHub; **Update now** downloads the installer, starts it and closes BookScout (your library and settings stay where they are). The releases are in a private repository, so first paste a read-only token on the About page: on GitHub go to Settings → Developer settings → Fine-grained tokens, choose only the BookScout repository, and grant **Contents: read**. The token is stored encrypted by Windows. If something goes wrong, `logs/updates.log` in the settings folder (shown on the About page) says what happened; the sample capture has its own `logs/sample-capture.log`.

## 8. Troubleshooting

| Problem | What to do |
|---|---|
| Extension icon shows ? | Not paired yet: Settings → Show a pairing code, then enter it in the extension. |
| "BookScout is not running" | Start BookScout (or its tray icon). If the port is taken, the app header says so: change the port in Settings and re-pair. |
| "bad token" | The token was regenerated. Pair again. |
| "BookScout is re-reading the library" | A rebuild is in progress; try again in a minute. |
| Fewer than 50 rows on a list | The list lazy-loads. Let the extension finish scrolling (a few seconds) before it captures; recapture if the page was slow. |
| Parser health shows many missing fields | Amazon changed a layout. Captures are kept; wait for an update, then Re-read all pages. |
| A sample page reads badly | Use a bigger browser window or zoom the reader in before capturing; or attach the book file. |
| The index "could not download the model" | Needs internet once; try again, or use the basic index. |

## 9. Privacy

- Pages are stored after removing personal details Amazon puts in them (your name, address, country, session identifiers). Reviewer names are not kept.
- Your sales reports stay on this computer (a copy is kept in the library's `sales` folder). The only network traffic BookScout itself makes is what you ask for: the one-time model download, update checks, Community sync, and keyword lookups on the Keywords tab (the phrase you typed goes to the autocomplete services you left switched on in Settings). The extension talks only to `127.0.0.1` (your own computer).
- The AI apps you connect read your library through a local process; what they then do with it is governed by those apps.
- Amazon's terms restrict automated collection. BookScout only captures pages you open and choose to send, one at a time, for personal research. That remains your responsibility.
