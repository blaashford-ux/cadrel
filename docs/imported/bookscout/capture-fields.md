# Capture fields: bestseller list pages

Source: two real pages saved from Chrome, now in `fixtures/amazon-com-au/` (personal data redacted; see "Privacy").

| Fixture | URL | Store |
|---|---|---|
| `bestsellers-books-humorous-fantasy.html` | `amazon.com.au/gp/bestsellers/books/4900420051` | Books |
| `bestsellers-kindle-cozy-fantasy.html` | `amazon.com.au/gp/bestsellers/digital-text/214873306051` | Kindle Store |

Book detail pages have not been sampled yet. This document covers list pages only.

## What is on a list page

### Page level
- `<link rel="canonical">` gives the store (`books` / `digital-text`) and the category node id.
- `<title>`: "Amazon.com.au Best Sellers: The most popular items in <Category>".
- Category breadcrumb and siblings (`_p13n-zg-nav-tree-all` / `zg-browse-root`): parents back to "Any Department", sibling categories, and the current node marked `(Current)`. Gives the category path without a separate lookup.
- Pagination: pages 1 and 2 (`?pg=2`), 50 books per page, 100 per category.
- Links to sibling list kinds for the same category (Hot New Releases; the page also links Movers & Shakers / Most Wished For / Gift Ideas in other layouts). Their metadata slots `currentSalesRank`, `percentageChange` and `twentyFourHourOldSalesRank` are empty here and are presumably filled on Movers & Shakers pages.

### Per book (`#gridItemRoot`)
| Field | Where | Notes |
|---|---|---|
| Rank | `.zg-bdg-text` ("#1") and `render.zg.rank` in `data-client-recs-list` | |
| ASIN | `data-asin`, `/dp/<ASIN>` in the link | 10 chars; paperbacks/hardcovers use the ISBN-10 as ASIN (e.g. `0349450617`) |
| Title | `<img alt>` and the clamped title div | Includes subtitle and series text, concatenated, e.g. "Name: Series, Book 5" |
| Author | `a[href*="/e/"]` | **Absent on most Audible rows**; contributors need the detail page |
| Rating | `aria-label` "4.6 out of 5 stars, 45,543 ratings" | Rating count is exact; the star value is rounded to one decimal. Missing when a book is too new |
| Format of this ASIN | `.a-color-secondary` ("Kindle Edition", "Audible Audiobook", "Hardcover", "Paperback") | |
| Price | `.p13n-sc-price` | Currency symbol is `$` only; the currency (AUD) must come from the marketplace. Missing for some rows |
| Other formats | "N formats available" | Count only, not which |
| Cover | `src` plus `data-a-dynamic-image` JSON with three sizes (300, 600, 900 px) | The 900 px URL is the one to store |
| Product URL | `href` | Contains a session id; strip it |

### Not on a list page (needs detail pages)
Blurb, subtitle split from series, publication date, page count, publisher, ISBN, categories and their ranks, Kindle Unlimited status, review text, "Customers say", A+ content, look-inside, related books, rank history.

## Findings that change the design

1. **Only 30 of the 50 books on a page are in the saved DOM.** `data-client-recs-list` lists all 50 ASINs and ranks, but the grid lazy-loads the rest as the page scrolls. The saved dumps hold full details for ranks 1–30 and only ASIN + rank for 31–50 (and the same on page 2). The extension must scroll the page to the bottom (waiting for the grid to fill) before it reads the DOM, and the parser must still take ASIN + rank from the JSON when a row didn't render.
2. **One title appears under several ASINs.** In the Humorous list "Threshing Day" is #1 as Kindle (`B0H27F76VH`) and #6 as Hardcover (`0349450617`); the same series appears as Audible rows with their own ASINs. A list entry is a *format-specific ASIN*, not a book. The data model needs a `work` layer above the ASIN (grouping by title, author and series) so a "top 20" is not inflated by duplicates and so ranking can be compared across formats.
3. **The Books-store and Kindle-store trees are different trees.** Humorous Fantasy is `books/4900420051`; Cozy Fantasy is `digital-text/214873306051`. The Books store also has its own "Cozy" under Fantasy. A category key is therefore `(marketplace, store, node id)`, not a name. The two lists also mix formats differently: the Books-store list contains Kindle, Audible, hardcover and paperback rows, while the Kindle-store list is Kindle only.
4. **Books appear in more than one category.** Four titles are in both lists (`B0H37YDJ7K`, `B0GYR6G9GX`, `B0GX2VMRGJ`, `B0GYFBSPSW`), so ranks are stored per (snapshot, category), never on the book.
5. **These pages are from amazon.com.au**, not the target amazon.com (prices are AUD; the page was served for a non-US delivery address). The structure is the same, but category ids, ranks and prices are marketplace-specific, so these are structural fixtures only. See "Marketplace" in `plan.md`.
6. **Titles are not clean data.** Subtitle, series name and book number are concatenated in one string and in several different shapes ("Book 5", "Book Seven", "(Series Book 12)", "(Series 1)", "Series, Book 2"). Series parsing needs rules plus fixtures, and the detail page's series widget is the better source.
7. **The saved HTML contains personal data** (see below).

## Privacy: what the raw page contains
Each saved page includes the signed-in user's first name, delivery city, a session id repeated in every product link, validation tokens and a slate token. The fixtures in this repo have these replaced with `REDACTED` / `000-0000000-0000000`. The product must do the same by default:

- A **scrub step runs in the ingest server before anything is written to disk**: first name and delivery line, session ids in URLs, `glow-validation-token`, `encrypted-slate-token`, `dropdown-selection` values, `customerName`, and cookies if any. This keeps the library safe to back up or share, and fixtures safe to commit.
- The trade-off is that the stored HTML is no longer byte-identical to what Amazon sent. That is acceptable: none of the scrubbed values is analysis data.
- The scrubber has its own tests and a fixture that contains planted fake values.

## Size
Each page is about 570 KB, over 95 % of it inline scripts and CSS. The library stores `page.html` gzip-compressed (roughly 6–10x smaller).

---

# amazon.com Kindle list (first real target-marketplace page)

Fixture: `fixtures/amazon-com/bestsellers-kindle-cozy-fantasy.excerpt.html`, saved 2026-10-18.
`https://www.amazon.com/Best-Sellers-Cozy-Fantasy-Fiction/zgbs/digital-text/214873986011` (Kindle Store).
It is an excerpt: head, breadcrumb tree, full 50-entry `data-client-recs-list`, rows 1, 2, 4 and 15, and pagination. Scripts, the nav bar and rows 3, 5-14 and 16-30 are omitted (same markup as the rows kept).

## Confirmed on amazon.com
- The `.com.au` structure carries over unchanged: `#gridItemRoot` rows, `data-asin`, `.zg-bdg-text` rank, `data-client-recs-list` with 50 entries, **30 rows rendered, 20 lazy-loaded** (`data-index-offset="30"`, `data-offset="50"`), `?pg=2` pagination.
- Category node ids are marketplace-specific: Cozy Fantasy is Kindle node **214873986011** on .com, **214873306051** on .com.au. The same name needs different keys per marketplace, as the plan already says.
- Breadcrumb ids on .com: Kindle eBooks 154606011, Science Fiction & Fantasy 668010011, Fantasy 158576011. Sibling ids are in the tree, e.g. **Humorous = 11650864011** (so the Kindle-store Humorous Fantasy list is `.../zgbs/digital-text/11650864011`).
- Covers use the same three-size `data-a-dynamic-image` map on `images-na.ssl-images-amazon.com`.

## New on amazon.com
1. **Paid and Free are separate lists.** The header has tabs "Top 100 Paid" (selected) and "Top 100 Free" (`?tf=1`). A rank only means something within one of them. `list_kind` must include paid and free (and new-releases etc.), and a list capture records which tab it was.
2. **Price has two layouts.** Most rows put the price in `.a-color-price`; some show "1 offer from $X" (`span.p13n-sc-price` inside `a-color-secondary`, no price wrapper). The parser must read both, and store which layout it saw, because "1 offer from" is a different pricing situation (not the Amazon buy-box price).
3. **"N formats available" is optional.** Row 4 has none; Kindle-only books omit it. Absent means "unknown", not zero.
4. **Author is not always a link.** Row 15 (a self-published title) has a plain `<span>` author with no `/e/` author-page URL, so author identity cannot rely on the author-page id.
5. **Titles carry marketing copy.** Row 8's title includes "A BRAND NEW autumnal fantasy romance with talking pumpkins ... for autumn 2026 (The Magic of Hudsbury 1)". Keep the raw title; derive a `title_clean`, `subtitle`, `series_name` and `series_position` with fixtures for each shape seen.
6. **Category membership is loose.** The Cozy Fantasy top 30 includes a science-fiction romance, a grim-reaper romance, and three LitRPG crafting titles. Analysis of "what a cozy fantasy looks like" needs a way to filter or flag off-genre members instead of treating the list as pure.
7. **Overlap with the .au pages is large** (same indie authors and series: Tales from the Dragon Diner, Wicked Witches of Cauldron Hollow, Mr Gorzug). That is useful for the tests, but not a reason to merge marketplaces in analysis.

## Personal data in this page (more than the .au pages)
Besides the first name, delivery city and session id found earlier, this page also contains an obfuscated customer id (several forms, including a hashed customer+session id), a request-context customer id, multiple csrf/validation tokens, the delivery country code, and the "free shipping to <country>" banner. The fixture removes the nav bar entirely and replaces the rest. The ingest scrubber needs rules for **each** of these:

- visible text: `Deliver to <name>`, the city line, `Hello, <name>`, "<name>'s Amazon.com", "shipping to <country>"
- ids: session id in URLs and JS, `customerId`, `customerName`, `customerCountryCode`, `hashCustomerAndSessionId`, `directed`/`ue_sid`/`rid` request ids
- tokens: `anti-csrftoken-a2z`, `glow-validation-token`, `encrypted-slate-token`, `acp` tokens, `dropdown-selection` values

The scrubber should drop `<script>` bodies by default (they hold most of these values and none of the book data), keeping only `application/ld+json` and the few data blobs the parser reads (`data-client-recs-list` is an attribute, not a script). That also cuts stored size by roughly 90 percent.

---

# Detail pages (amazon.com, Kindle): 10 books + Look Inside check

Fixtures in `fixtures/amazon-com/` (gzipped; produced by the scrubber in `packages/core/src/scrub.ts`):
- Cozy Fantasy top 5: B0G7R6X55V, B0HLR7NQC7, B0HC7ZDQQ8, B0H7QRHNJR, B0HDJJ2XKY
- Humorous Fantasy top 5: B0C1R52V2J, B0HKTD6M9Z, B0GZNJHYRW, B0GSCPBJLJ, B0GPRVQ8QJ
- `bestsellers-kindle-humorous-fantasy.html.gz`: Humorous Fantasy Kindle list (node 11650864011): 50 entries, 30 rendered, tabs Paid/Free, same as Cozy
- `detail-kindle-B0GPRVQ8QJ.read-sample-open.html.gz`: the same book with Read Sample open
All ten pages are Kindle books. Every field below was extracted from them with a throwaway BeautifulSoup probe; all 11 stored detail fixtures parse title, rating, rating count, pages, publication date, formats, description and details.

## 1. A "page source" is two documents, not one
Each detail page comes as **two concatenated `<!DOCTYPE html>` documents**: the first (about 850 KB) is the page down to the Look Inside block, and the second (about 1 MB, starting with the `litb-read-frame` iframe) is the below-the-fold half. The second holds: product details and **Best Sellers Rank**, A+ content, editorial reviews, "About the author", rating histogram, on-page reviews, related books. The parser must accept multi-document input. The extension, reading the live DOM, gets one merged document and needs no special handling, so both paths must be tested.

## 2. Fields found (present on all ten unless noted)
| Group | Field | Where |
|---|---|---|
| Identity | Title (with subtitle/series text), ASIN, canonical URL | `#productTitle`, details list, `link[rel=canonical]` |
| People | Author(s) with role and author-page id | `#bylineInfo` (`by X (Author)`); roles for narrators/editors appear when present |
| Series | "Book 4 of 5: <series>" and series link | `#seriesBulletWidget_feature_div`, `rpi-attribute-book_details-series`. Absent for standalones (Wicker, Mr. Whiskers) |
| Reviews | Star average, rating count, 5-to-1 star percentage histogram | `#acrPopover`, `#acrCustomerReviewText`, `#cm_cr_dp_d_rating_histogram` |
| Reviews | 5 to 13 individual reviews: stars, title, date and country, verified badge, format, helpful votes, body | `[data-hook=review]` |
| Reviews | "Customers say" AI summary | present on 5 of 10 (Ale Storm and four Humorous books); loaded into a `k-injected` block |
| Formats and price | Every format with price: Kindle, Audiobook ("$0.99 with membership"), Paperback ("from $16.83"), Hardcover, Audio CD | `#tmmSwatches .swatchElement`; Kindle price also in the buy box with list price and discount |
| Details | Print length, publication date, file size, language, ISBN-13 (some), publisher (some), Word Wise, X-Ray, Page Flip, enhanced typesetting, screen reader | `rpi-attribute-book_details-*` and the details list |
| Rank | **Best Sellers Rank**: overall Kindle Store rank, then up to several category ranks, each with a node id link | details list; see section 3 |
| Cover | Hi-res cover URL (`_SL1500_`) plus the size variants | `'colorImages'` JSON in a script (`hiRes`), and `data-a-dynamic-image` on `#landingImage`. The `colorImages` script must be kept by the scrubber |
| Text | Description (the full text is in the DOM even though the page shows it collapsed to 280 px) | `#bookDescription_feature_div` inside an expander |
| Text | Editorial reviews | `#editorialReviews_feature_div`; only on Wicker (Tordotcom, traditionally published) |
| Text | A+ content | `#aplus_feature_div`; **none of these ten had it** |
| Text | About the author | `#moreAboutTheAuthorCard_feature_div` |
| Related | "Customers also bought" (about 6 ASINs) and sponsored products (`sp_detail2_<ASIN>`) | two of the ten (Wicker, Vampire Pack) had no related-books block |
| Badges | Charts / BookTok / award badges | `*Badge_feature_div`; one page had `zeitgeistBadge` |

Fields NOT found on a Kindle page: publisher on about half of the indie books, ISBN on self-published books without one, word count (only page count), and **Kindle Unlimited status**.

## 3. Best Sellers Rank is the most valuable field, and it joins the two stores
Example (The Stormtender's Call): `#609 in Kindle Store`, `#1 in Cozy Fantasy Fiction (Kindle Store)`, `#3 in Women's Fantasy Fiction`, `#3 in Cozy Fantasy Fiction (Books)`. Findings:
- The rank block lists the **Kindle-store category and also the Books-store category** for the same book ("(Kindle Store)" and "(Books)" variants), each linked with its own node id. Example: Cozy Fantasy Fiction is Kindle `214873986011` and Books `211759009011`; Humorous Fantasy is Kindle `11650864011` and Books `11764648011`.
- A book is ranked in 3 to 5 categories at once, including ones outside your two (e.g. "GameLit & LitRPG", "Horror Comedy", "Women's Fantasy Fiction"). These are exactly the secondary categories an author chooses, so they are market data in their own right.
- The overall rank (`#609 in Kindle Store`) is a different, larger-scale number than the category rank. It is the best single sales-velocity proxy on the page.
- This is a snapshot: two captures of the same book on different days give rank movement, which is why every capture must be a stored snapshot.
- Cross-check: the detail page rank (`#1 in Cozy Fantasy`) matches the list position (#1 on the list), so list ranks and detail ranks can be validated against each other for the same capture date.

## 4. Kindle Unlimited status is not in the source
Neither the saved source nor the Look Inside source contains any "Read for $0.00" / "Included with Kindle Unlimited" element for these ten books (the string "Kindle Unlimited" appears only in the site navigation). Possible reasons: it is only shown to a signed-in KU member, or it is injected later. **Open:** if you are a KU member, tell me and I will check whether one of these books is KU by opening it again; otherwise the analysis has to do without KU status, or infer it from the Audible "with membership" line (which is a different programme).

## 5. Look Inside / Read Sample
Compared the page saved with Read Sample open to the same book without it (`B0GPRVQ8QJ`):
- The two are **the same page**. The only differences are randomly generated widget ids. Nothing about the sample is added to the page source.
- The sample is loaded into a **cross-origin iframe**: `<iframe id="litb-read-frame" data-src="https://read.amazon.com/sample/<ASIN>?f=1&l=en_US&r=...&rid=...&sid=...&cid=..." sandbox="allow-scripts allow-same-origin ...">`. Its content lives on `read.amazon.com`, not in the page. The URL also contains the session id and the customer id (scrubbed in the fixtures; the scrubber must remove `sid=` and `cid=` query values).
- A read-sample button (`#ebooksReadSampleButton`) exists on all ten books, so every book has a sample.
- A content script on `www.amazon.com` cannot read into that iframe. An extension **can** inject a script into it, but that needs permission for `read.amazon.com` and I have not seen what the reader renders (Kindle's web reader is known for drawing text as images/canvas, which would mean the text is not available as HTML). **I have no evidence yet that sample text can be captured.**

**Verdict:** automatic Look Inside capture is not supported by anything seen so far. A feasible, honest v1 is **assisted capture**: you open the sample and page through it; the extension captures what is on screen at each page turn (a screenshot per page, taken by the browser's own capture API), the desktop app runs OCR on those images, and the text joins the manuscript slot. That is a manual, per-page, user-driven action and stays within "no automated browsing". The manual PDF/EPUB drop-in remains the guaranteed route. The plan's M5 is updated accordingly.


---

# Findings from building the parsers (M1, slice 1)

- **Reviewer names contain injected text.** A reviewer's display name came back as `S. GThank you for your inquiry. TThThank you for your inquiry. ank you ...` (the same sentence spliced into the name three times). Whether Amazon or a browser extension on the capturing machine put it there, the page text cannot be trusted to be clean. Decisions: (1) reviewer names are **not stored** (analysis does not need them and they are third-party personal data); (2) all captured text is treated as untrusted data, and the MCP server will label text fields as quoted source material so a model does not follow instructions found in a blurb or review.
- **Sponsored products change on every load**, so two captures of the same page differ in `sponsoredAsins`. They are stored as ads, never compared as page content.
- **Rating histogram:** levels at 0 % have no link in the page, so a missing level is stored as 0.
- **Two .au fixtures committed earlier still held an obfuscated customer id and two hashes** (the first scrub covered name, city and session id only). The scrubber now detects these from the page and removes them, a test fails if any fixture still contains one, and the .au fixtures were regenerated. The earlier commits are still in the branch history.
- The list parser reads rows in both price layouts, optional author links, and entries not rendered; the detail parser accepts the two-document page source and the single merged DOM and produces identical results (tested).
