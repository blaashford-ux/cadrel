# BookScout: plan

A local-first market-research tool for Amazon books. A Chrome extension captures pages you browse; a Windows desktop app stores, parses, analyses and serves them to Claude or GPT through an MCP server.

Status: plan only. No code yet. Written after the investigation and design discussion; the decisions below are settled unless marked **open**.

## 1. Goals and non-goals

**Goals**
- Capture everything on an Amazon book page, and on bestseller/category list pages, with one right-click.
- Keep raw HTML forever, so a parser fix can re-process the whole archive.
- Keep cover images (every capture), blurbs, rank snapshots, price, ratings, reviews, A+ content, "Customers say", and every other field present in the HTML.
- Capture Look Inside material where possible; otherwise accept a manually saved PDF or EPUB in the same slot.
- Analyse per category, in code, what separates top performers from the rest, and how that moves over time.
- Expose the library to Claude or GPT through a local MCP server (stdio).

**Non-goals (v1)**
- No crawling, no background or scheduled fetching, no parallel fetching. Every capture is a human action.
- No marketplaces other than amazon.com. The first fixtures were saved from amazon.com.au by mistake; the page structure is the same, so they stay as structural fixtures, but the parser is only considered done once it passes real amazon.com pages. The marketplace is still a stored field on everything.
- No online/tunnelled MCP access. Desktop MCP only.
- No Mac/Linux builds.
- **Kindle books only in v1.** Paperback, hardcover and audiobook detail pages are not captured or parsed; those formats appear only as swatch rows (format, price) on a Kindle page. Print-specific fields (dimensions, ISBN-10, print Look Inside) are deferred.
- No redistribution of captured content, covers or sample pages. Personal research use.

## 2. Settled decisions

| Area | Decision |
|---|---|
| Browser | Chrome (Manifest V3; Edge should work unchanged but is untested) |
| Extension to app | HTTP POST to `127.0.0.1` with a pairing token shown in the app |
| Desktop | Electron + React + Vite + TypeScript, Windows installer (same toolchain as MDEdit) |
| Storage | Plain files on disk (source of truth) + SQLite (derived, rebuildable) via the built-in `node:sqlite` driver, not `better-sqlite3`: no native module to rebuild for Electron or on Windows (FTS5 works in both; `sqlite-vec` loads as an extension). Exception to "derived": `queue_item` (and later annotations) is user data and survives `rebuild()`. |
| Library location | Chosen at install; changeable later in Settings (moves or re-points the library) |
| Embeddings | Local ONNX model, in-process |
| Vector search | `sqlite-vec` inside the same SQLite file |
| MCP | Official TypeScript SDK, stdio, started by Claude Desktop / Claude Code / Codex |
| Look Inside | Attempted in v1, isolated so failure never blocks a normal capture; manual PDF/EPUB drop-in ships alongside |
| Marketplace | amazon.com only in v1, stored as a field. The amazon.com.au fixtures are kept for structure only |
| Finding detail pages | One-click "open next" in the app (opens the next uncaptured book in Chrome); every capture is still a manual right-click |

## 3. Architecture

```
Chrome extension (MV3)
  context menu: "BookScout: capture page" / "capture page + Look Inside"
  content script: outerHTML + parsed image URLs + cover bytes (fetched in-page)
        |  POST 127.0.0.1:<port>/v1/capture   Authorization: Bearer <pairing token>
        v
BookScout desktop app (Electron main process hosts everything)
  ingest server -> raw store -> parser -> SQLite -> chunker -> embedder
  analysis engine (pure code, SQL + stats)
  UI (library, book view, category dashboards, settings)
  MCP server (stdio entry, reads the same library)
```

Rules:
- The ingest server binds to loopback only, rejects requests without the token, rejects any `Origin` other than the extension's, and caps body size.
- Raw capture is written to disk **before** parsing, after a **scrub step** that removes personal data (first name, delivery city, session ids, tokens). A parse failure never loses data. See `docs/capture-fields.md`.
- SQLite is a cache of what the files say. Deleting `scout.db` and re-running "Rebuild index" must reproduce it.
- The MCP server is read-mostly. Its only writes are user annotations (tags/notes).
- Parser, analysis and chunking are pure functions in a shared package with no Electron dependency, so they are unit-testable and reusable from the MCP process.

## 4. Repository layout

```
bookscout/
  docs/                 plan.md, capture-fields.md, mcp-tools.md, spikes/
  packages/
    core/               parser, analysis, chunking, schema, library I/O (pure TS)
    extension/          MV3 extension
    desktop/            Electron main + renderer
    mcp/                MCP server (stdio), built into the installer
  fixtures/             saved real Amazon HTML pages (see section 9)
  scripts/
```

npm workspaces, vitest everywhere, `tsc --noEmit` and tests in CI on every push (GitHub Actions), Windows installer built in CI as MDEdit does.

## 5. Library on disk

```
<Library root>/
  library.json                       version, created, marketplace
  books/<ASIN>/
    book.json                        latest parsed summary (derived)
    snapshots/<UTC timestamp>/
      page.html                      raw, untouched
      capture.json                   url, page type, extension version, user agent, viewport
      parsed.json                    parser output + parser version + parse issues
    covers/<timestamp>-front.jpg     one per capture (+ other images in the carousel)
    lookinside/<timestamp>/page-001.jpg ...   + ocr/page-001.txt
    manuscript/                      user-dropped PDF/EPUB (original kept)
    extracted/manuscript.txt         text from manuscript or OCR, whichever is better
  lists/<UTC timestamp>-<slug>/      bestseller/category list captures (page.html, parsed.json)
  models/                            embedding model
  scout.db                           derived
```

Everything under `books/` and `lists/` is append-only except `book.json`, `extracted/` and `scout.db`, which are regenerated.

## 6. Data model (SQLite, derived)

- `work(id, title_norm, primary_author, series_id, series_position)` groups the format-specific ASINs of one title (Kindle, hardcover and Audible rows of the same book are different ASINs)
- `book(asin PK, work_id, marketplace, format, title, subtitle, series_id, first_seen, last_seen, ...)` — one row per format-specific ASIN
- `author`, `book_author(role)`, `series`
- `snapshot(id, asin, captured_at, format, price, list_price, rating, rating_count, review_histogram_json, pages, publication_date, publisher, language, isbn10, isbn13, ku_flag, parser_version, ...)`
- `format_offer(snapshot_id, format, price, asin_for_format)`
- `category(id, marketplace, store, node_id, path, parent_id)`: the Books-store and Kindle-store trees differ, so the key is (marketplace, store, node id), not the name. `rank_entry(snapshot_id, category_id, rank, kind)` (overall and per-category ranks)
- `text_block(snapshot_id, kind, body)` with kinds: blurb, editorial_review, a_plus, customers_say, on_page_review, about_author, details_misc
- `related(snapshot_id, kind, asin, position)` (also bought, frequently bought together, sponsored)
- `list_capture(id, captured_at, category_id, list_kind, page, rendered_count, listed_count)` where `list_kind` is one of paid, free, new_releases, movers_shakers, most_wished_for, gift_ideas. On amazon.com a category has separate Top 100 Paid and Top 100 Free lists; ranks are never compared across kinds. and `list_entry(list_capture_id, position, asin, rank, format, price, currency, rating, rating_count, formats_available, title_raw, author_raw, rendered)`. `rendered=false` rows carry only ASIN and rank (see M1)
- `asset(id, asin, kind, path, captured_at, sha256)` for covers and Look Inside images
- `manuscript(asin, source, path, text_path, chars, source_quality)`
- `chunk(id, asin, snapshot_id, kind, text, token_count)` + `chunk_fts` (FTS5) + `chunk_vec` (sqlite-vec)
- `annotation(asin, tag, note, created_at)` (the only user-authored table; also stored as JSON in the library so it survives a DB rebuild)
- `parse_issue(snapshot_id, field, severity, detail)`

"All data in the HTML" is handled in two layers: typed columns for what analysis needs, plus `parsed.json` holding every key/value row from the details tables and every labelled section, so nothing present is dropped even if it has no column yet.

## 7. Analysis (code, no LLM)

Computed per category and cohort (top N by rank vs rest, or by performance score):
- Market shape: price bands, rank-vs-price, page count, publication-date clustering, format mix, series share, KU share, subcategory crowding.
- Performance: review velocity (reviews per day between snapshots), rating distribution, rank stability and volatility, rank response to price changes.
- Packaging: title/subtitle length and structure, keyword position, blurb structure (hook length, bullets, comp titles, tropes, call to action), cover palette/brightness/text density (`sharp`).
- Content (from manuscript/Look Inside text): opening-page profile, dialogue share, reading level, sentence-length profile, chapter count. MDEdit's text-analysis code is the starting point; it will be copied into `packages/core` rather than shared across repos in v1.
- Reader voice: review theme and sentiment clustering, "Customers say" phrase counts.
- Trends: any metric per month per category.

A "success score" is configurable and shown with its inputs, so you can argue with it. Default: a blend of current rank percentile, rank stability, and review velocity.

## 8. MCP tools

All return structured JSON with the ASIN and snapshot date so answers can be cited. Descriptions are written for a model to pick the right tool.

- Discovery: `list_categories`, `category_overview`, `library_status`
- The user's own catalogue: `my_books` (from imported KDP reports; includes books not yet captured)
- Books: `get_book`, `book_history`, `compare_books`, `get_cover` (returns the image), `get_text_block`
- Cohorts: `top_books`, `cohort_stats`, `trend`, `distribution`
- Text: `search_text` (hybrid FTS5 + vector, filterable by category/kind/date), `get_manuscript_excerpt`
- Annotations: `add_tag`, `add_note`

Large results are paginated and capped so a tool call can't flood the model's context.

## 9. Milestones

### M0: Spike and fixtures (do first; gates the rest)
**Status:** done except page 2 of each list. Captured and analysed (see `docs/capture-fields.md`): Cozy and Humorous Fantasy Kindle lists page 1, ten Kindle detail pages (five per category), and a Read Sample comparison. Paperback pages are out of scope for v1 (see non-goals). **Still optional:** page 2 of each list (ranks 51-100), and the Top 100 Free tab.
- Build a throwaway extension that dumps `outerHTML` and the image URL set; confirm what the rendered DOM contains that "Save as" misses.
- Inventory every field in the fixtures and write `docs/capture-fields.md`.
- **Look Inside spike:** with a logged-in session, find how the viewer loads pages (endpoints, tiles, signing, rate limits) for print and Kindle books; try to capture page images from the content script at human pace; try OCR on them. Write findings to `docs/spikes/look-inside.md` with a go / partial / no-go verdict per book type.
- Confirm cover-image extraction (best resolution, carousel images).
- **Exit criteria:** fields documented; fixtures committed; Look Inside verdict recorded; the Look Inside plan in M5 adjusted to match.

### M1: Core pipeline
**Progress:** slice 1 done in `packages/core`: scrubber, list-page parser and detail-page parser with 53 passing tests against the 14 fixtures (`npm test`, `npm run typecheck`, CI in `.github/workflows/ci.yml`). Slice 2 done in `packages/library`: on-disk layout, SQLite schema with migrations, scrub → store raw → parse → index ingest, content-addressed cover storage, and `rebuild()` from files (11 tests). Slice 3 done in `packages/server`: loopback-only HTTP ingest (`GET /v1/ping`, `POST /v1/capture`) with bearer token, Host and Origin checks, https-amazon.com URL check, body cap and cover upload (15 tests). Slice 4 done in `packages/extension` (plain JS MV3, no build step; load unpacked): right-click "Send to BookScout", scroll-to-render of lazy rows/sections, hi-res cover fetch, popup for pairing and "send this page", toolbar badge feedback; tested in real Chromium against fixtures served in place of amazon.com (`test/e2e.test.ts`, skipped where no Chromium is installed). List-page covers are not fetched (the detail capture gets the hi-res one). Not started: work grouping; testing against live Amazon (needs the user).
- Monorepo, CI, lint/typecheck/test.
- Library I/O, schema and migrations, `rebuild index` command.
- Parser v1 against fixtures, with `parse_issue` reporting; snapshot tests on every fixture. Parser input may be **two concatenated documents** (page source) or one merged DOM (live capture); both are tested with the same fixtures.
- Best Sellers Rank parser: overall rank plus every category rank with its store (Kindle/Books) and node id; stored as `rank_entry` rows per snapshot.
- Ingest server with token auth, size limits, origin check; idempotent writes.
- Extension: context menu, capture, image fetch in page, pairing UI, clear success/failure feedback (badge + notification).
- List-page capture scrolls the grid to the bottom so all 50 rows render (only 30 do on load); rows that still fail to render are kept from the ASIN + rank JSON with `rendered=false`.
- Scrub step (name, delivery city/country, every customer/session id form, csrf and validation tokens; `<script>` bodies dropped by default) with tests that plant fake values and assert none survive. The rule list is in `docs/capture-fields.md`.
- Work grouping: title/author/series normalisation so a title's Kindle, hardcover and Audible ASINs share one `work`.
- **Exit:** right-click on a real page results in a snapshot on disk and rows in SQLite; re-capturing creates a second snapshot; killing the app mid-capture loses nothing.

### M2: Desktop app shell
**Progress:** slice 1 done in `packages/library`: capture queue (pending/opened/skipped, captured derived from snapshots), `openNext`, and read queries for categories, books, book detail with history, and parse issues (9 tests). Queue state lives in `queue_item`, which is user data and is deliberately not wiped by `rebuild()`. Slice 2 done in `packages/desktop`: Electron main process (`AppService`, no Electron imports, unit-tested), sandboxed preload, React renderer with first-run library picker, Queue (Open next / skip / restore), Library (categories, books, search, book detail with cover, rank/price/ratings history, ranks, description, parse issues), Parse issues, Settings (library, rebuild index, token show/copy/regenerate, port); the ingest server runs inside the app and the UI updates live on capture. Driven end to end in real Electron under a virtual display (`test/app.e2e.test.ts`). Not done: installer (electron-builder), moving library files (Settings only re-points), raw HTML viewer ("Show files" reveals the folder), charts beyond sparklines, extension auto-pairing, tray/autostart.
- Installer, first-run library location picker, Settings (move/re-point library, regenerate token, port).
- Library browser (books, categories, captures), book detail (cover history, rank/price/review charts, parsed fields, raw HTML viewer), parse-issues view, "Rebuild index".
- Capture queue: books seen in list captures but without a detail capture, ordered by rank and filterable by category. An "Open next" button opens the top item's page in Chrome (via the extension, so it opens in your logged-in profile) and marks it "opened"; it turns "captured" when a snapshot arrives and "skipped" if you skip it. Capturing remains a right-click.
- **Exit:** you can browse everything captured so far without any AI, and work through the queue of uncaptured books.

### M3: Retrieval and MCP
**Progress:** built. `packages/library`: `text_block` and `chunk` tables (title, blurb, editorial review, about author, on-page reviews; ~900-character pieces; unchanged chunks are kept across re-captures), FTS5 keyword search, `sqlite-vec` vector search, reciprocal-rank fusion, a per-text embedding cache (so rebuilds and model changes re-use vectors), annotations mirrored to `user/user-data.json`, category resolution and cohort statistics. `packages/embedder`: local MiniLM-L6-v2 (q8, 384-d) through transformers.js, downloaded once into `<library>/models`. `packages/mcp`: stdio server with 15 tools (`library_status`, `list_categories`, `category_overview`, `top_books`, `get_book`, `book_history`, `compare_books`, `get_text_block`, `search_text`, `cohort_stats`, `distribution`, `list_books_by_tag`, `get_cover`, `add_tag`, `add_note`); every result cites ASIN and capture date, text is labelled as untrusted source material, results are capped. Desktop Settings: build the search index (neural or no-download basic) with progress, and copy-paste setup for Claude Desktop, Claude Code and Codex. Tested over real stdio, including launching the server from the setting the app produced.
**Not verified here:** the real model download and inference (huggingface.co is blocked in the build sandbox; the loader is tested with a stand-in), and an actual Claude Desktop / Claude Code / Codex session (tested with the MCP SDK client). Not built: `trend` and `get_manuscript_excerpt` tools (M4, M5), packaging the MCP server and native pieces (`sqlite-vec`, `onnxruntime-node`) into the installer (M6).
- Chunker, local embedding model download/bundle, FTS5 + `sqlite-vec` hybrid search.
- MCP server with the tools in section 8; one-click "copy config" for Claude Desktop / Claude Code / Codex; integration tests that run the server over stdio.
- **Exit:** from Claude Desktop you can ask "which blurb patterns do the top 20 in category A share?" and get cited results.

### M4: Analysis and dashboards
**Progress:** built. `packages/core/src/analysis`: stats (median, quartiles, Spearman, percentile, Flesch), packaging metrics (title shape, blurb length/hook/bullets/questions/CTA/comp titles/prestige claims, trope dictionary) and reader-voice themes by review sentiment. `packages/library/src/analysis`: market shape (price and page bands, rank-vs-price, age and recency, series and book-1 share, format mix, co-categories), success score (rank, rank stability, review velocity; weights stored in the library; missing components dropped and the rest re-weighted, with each component's basis shown), trends per capture day or month, packaging and reader-voice cohort comparisons, cover analysis with `sharp` (brightness, contrast, saturation, warmth, dominant hue, palette, edge density by band), a composed `categoryReport`, a Markdown report and a CSV export (formula-safe). Desktop: an Analysis tab (caveats first, cohort table, price/length bars, rank-vs-price scatter, freshness tiles, packaging table, tropes, reader themes, covers, trends, success-score table with editable weights, a table view behind every chart) with CSV and report export. MCP: 7 more tools (`category_report`, `market_shape`, `success_scores`, `trend`, `packaging_stats`, `reader_voice`, `cover_stats`), 22 in all. The same numbers feed the app, the exports and the MCP tools.
**Limits to know:** velocity falls back to ratings-per-day since publication until a book has two captures a day or more apart, and rank stability needs three list captures, so a first capture shows neither; "text density" on covers is an edge-density proxy, not text recognition; reader themes come from the handful of on-page reviews, not every review; cover analysis was tested on generated images, not real Amazon covers.
- Cohort stats, trends, packaging and reader-voice metrics, success score with visible inputs.
- Category dashboard in the app; export to CSV.
- Cover analysis.
- **Exit:** a per-category report you can read without an AI, and the same numbers available through MCP.

### M5: Manuscript and Look Inside
**Progress:** built; the OCR-legibility spike was skipped at the user's request, so assisted capture is verified on rendered pages, not real Amazon reader screenshots. `packages/text`: extraction from PDF (pdfjs), EPUB (spine, headings as chapters), DOCX, TXT and Markdown; offline OCR (tesseract.js with the English data bundled from npm, auto-inverts dark reader themes, crops to the reader area, removes reader chrome, joins sentences that run across page turns, recognises the end-of-sample screen). `packages/core`: content metrics (dialogue share, sentence profile, reading level, chapters, opening profile that skips chapter headings). `packages/library`: `manuscript` table (one whole-book upload and one free-sample text per book; files under `books/<ASIN>/extracted`, originals under `manuscript/`, screenshots under `lookinside/<session>/`), chapter-aware chunking into the same FTS5 + vector index (kinds `manuscript` and `sample_text`), excerpts, content stats per category, report and CSV sections, rebuild from files. `packages/server`: `POST /v1/sample/page` and `/v1/sample/finish`. `packages/extension`: Start sample capture (popup), a small in-page control, reader detection, change-then-settle detection so each page is saved once, crop rectangle, keyboard shortcut (Alt+Shift+S) to save the page on screen, Finish. Desktop: a "Text of the book" card on every book (drop or choose a file, sample status, OCR progress, metrics), a Text column in the Library, an "Inside the books" section in Analysis. MCP: `get_manuscript_excerpt`, `content_stats`, `book_content`; `search_text` now covers manuscript and sample text. Tested, including real OCR inside Electron and real screenshots in Chromium.
**Limits to know:** screenshots need the `activeTab` permission, which Chrome grants when you click the extension button or popup, so sample capture must be started from the popup; a PDF that is only scanned images is detected and reported but not OCR'd; the free sample is about the first tenth of a book and is labelled as such everywhere; Amazon's reader layout, themes and fonts are untested, so recognition quality on real screenshots is unknown until tried; one sample session replaces the previous one per book.
- PDF/EPUB drop-in per book (drag onto book view), text extraction, chunking, opening-page profile.
- **Assisted sample capture** (replaces automatic Look Inside capture; see `docs/capture-fields.md`, section 5): the Read Sample reader is a cross-origin iframe (`read.amazon.com`) whose content is not in the page source. You open the sample and turn the pages; the extension takes a screenshot of the reader at each page turn (browser capture API), the desktop app OCRs the images (Tesseract, local) and indexes the text. Marked per book as `none | partial | full`, with a prompt to attach a PDF/EPUB instead. A short spike confirms the screenshots are legible enough for OCR before this is built.
- **Exit:** the content metrics in section 7 work for any book that has a manuscript from either source.

### M6: Hardening and release
**Progress:** built (see `docs/user-guide.md`, `docs/release.md`, `docs/security.md`, `docs/performance.md`).
- *Parser health*: weekly view of captures with missing fields per field; **Re-read all pages** is now an async job with progress (captures sent meanwhile get a 503 and a "try again" message).
- *Library care*: verify (integrity, files vs index, missing covers), back up, and **move** (copy, verify by count/size and integrity, switch; old folder left), tested on a 1,500-file library; network shares are refused.
- *Pairing by 6-digit code* (single use, 2 minutes, rate-limited) instead of copying a token; token entry kept as an advanced option.
- *Hardening*: rotating log file, single instance, tray with keep-running and start-with-Windows settings, IPC argument validation, security notes.
- *Packaging*: electron-builder config; the MCP server is bundled inside the app and launched with the app's own Node; native pieces unpacked from the asar; extension folder and zip shipped; CI runs the whole app suite and the walkthrough against the **packaged Linux build**; a Release workflow builds the Windows installer and extension zip.
- *Walkthrough test*: real Chromium with the extension paired by code to the real Electron app: capture a list, Open next, capture the book, capture the free sample while pages turn, OCR it, analyse, build the index, check the library.
- *Scale test*: 5,000 books / 150,000 chunks, all interactive queries under 250 ms.
**Not verified:** the NSIS installer and any run on Windows (the Release workflow does it; do a clean-machine smoke test before sharing), the tray icon and start-with-Windows (disabled under test), unsigned installer warning, real Amazon reader screenshots and live amazon.com pages, the real neural embedding model, a real Claude Desktop / Claude Code / Codex session, Chrome Web Store packaging (sideload only).
- Layout-drift handling: a "parser health" view (percentage of captures with issues per field per week), a re-parse-everything command.
- Backup/export of the library, library move tool tested on large libraries.
- Windows installer in CI, extension zip for sideloading, README with install and pairing steps.

## 10. Testing strategy
- **Fixtures:** real saved pages are the backbone. Parser tests are snapshot tests per fixture; a new layout variant is added as a new fixture, never patched around.
- **Core:** unit tests for parser, chunker, every analysis metric (with hand-computed expected values on small synthetic libraries).
- **Ingest:** integration tests for auth failure, wrong origin, oversized body, duplicate capture, partial writes.
- **Rebuild:** a test that deletes `scout.db` and asserts the rebuilt DB matches the original.
- **MCP:** stdio integration test calling each tool against a seeded library.
- **Extension:** Playwright with the installed Chromium loading the unpacked extension against a local mock of an Amazon page (never against amazon.com in CI).
- **Manual:** a short checklist per milestone for what only a real Amazon page can verify.

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Amazon changes its markup or A/B tests layouts | Raw HTML always kept; parser is versioned and re-runnable; `parse_issue` and parser-health view make drift visible; layouts become fixtures |
| Look Inside is signed, tiled, rate-limited or blocked | Spike in M0 decides scope; capture is a separate optional step; paced one-book-at-a-time; fallback is manual PDF/EPUB in the same slot |
| Amazon Terms of Service forbid automated scraping | Human-triggered, one page at a time, no crawling; personal research only; stored content is not redistributed. This is a residual risk you are accepting, not one the design removes |
| Local port exposure | Loopback only, bearer token, origin check, size cap; token regenerable |
| Library growth (images) | Configurable location, per-asset hashes to avoid duplicate storage, size shown in Settings |
| Embedding quality of a small local model | Hybrid search (FTS5 + vector) so keyword matches still work; model is swappable behind one interface |
| Rank is noisy from single snapshots | Analysis uses snapshot series where available and flags single-snapshot books |

## 12. Open items
- Settled: marketplace is amazon.com. The .com.au fixtures are structural only; analysis never mixes marketplaces.
- Settled: capture queue is "open next" (section 9, M2). Lists give ASINs; blurbs, categories, page counts and reviews need each book's detail page. The app keeps an "uncaptured books" queue ordered by list rank; one button opens the next book's page in Chrome, and you capture it with the right-click. Nothing captures automatically.
- Settled: categories are Humorous Fantasy and Cozy Fantasy.
- Settled: Kindle Unlimited status is ignored in v1 (it shows only on the user's amazon.com.au view, not on amazon.com).
- Settled: **Kindle Store for both categories** (Cozy `214873986011`, Humorous `11650864011`). Books-store lists are a possible later addition; the detail-page rank block already records the Books-store ranks.
- Pasted amazon.com Cozy Fantasy list is stored as `fixtures/amazon-com/bestsellers-kindle-cozy-fantasy.excerpt.html`; findings are in `docs/capture-fields.md` (paid vs free lists, two price layouts, optional author links, loose category membership, extra personal data).
- **Decided (v1):** the text-analysis code is new in `packages/core` (dialogue share, sentence profile, reading level, opening profile), not a copy of MDEdit's; sharing code between the repositories can be revisited later.
- **Decided (v1):** all-MiniLM-L6-v2 (quantised) as the embedding model, behind one interface so it can be swapped. The planned bake-off on real blurbs was not possible in the build environment (model hosting is blocked there); do it once real data exists.
- **Open:** the default success-score weights (rank 0.5, stability 0.2, velocity 0.3, editable in the app); tune on real data.
- **Open:** how well OCR reads Amazon's real sample reader (fonts, themes); verify on a real capture before relying on sample text.
- **Open:** Chrome Web Store listing (the extension is sideloaded for now), code signing, auto-update.
- **Open:** OCR for scanned PDFs (detected and flagged, not read); Books-store lists; paperback/hardcover/audio pages.

### 0.2.0: opportunity analysis
`packages/library/src/analysis/opportunity.ts` (rank-to-sales curve, category depth, opportunity score with editable weights, sub-category shelf finder) and `clusters.ts` (tf-idf trope clusters, top versus rest). The same numbers feed the report, the MCP tools (`category_opportunity`, `rank_categories`, `find_subcategories`, `estimate_sales`, `trope_clusters`) and the Analysis tab. Sales estimates are given as a range (three published rules; or the author's own fit from imported KDP Orders and KENP Read reports, with Kindle Unlimited borrows estimated from pages read, `packages/library/src/sales/`). Deliberately left out: a price-spread component (no defensible meaning) and a single keyword search-volume number (not on Amazon pages; the Keywords tab shows per-source signals instead, each in its own units).

### 0.3.0: keyword research, calibrated sales estimates, My Books
- **Keywords tab** (`packages/library/src/keywords/`): per-source columns, never blended: Amazon/Google/Bing autocomplete position (client-side, user-triggered, 400 ms apart, 7-day cache, dropped after two blocked answers), Reddit mentions counted locally from synced subreddits, Google Trends via browser link plus CSV import, and Amazon competition from search pages captured by the extension (a third page kind, `packages/core/src/amazon/search.ts`, stored under `searches/`).
- **Sales estimates as ranges** (`packages/library/src/sales/`): the spread of three published rank-to-sales rules until calibrated; then the author's own fit from imported KDP Orders and KENP Read reports, pairing ranks from captured pages with the prior three days' sales, with Kindle Unlimited borrows estimated from pages read and KENPC and counted as sales on request.
- **My Books**: books created from imported reports (or flagged by hand), shown under Library → My Books before any page is captured; MCP tool `my_books`.
- Schema 7 → 11 (keywords and search captures; sales and rank points; KENP and page counts; own books; existing libraries migrate on first open). Includes the community-sync fixes from `claude/peaceful-cori-cy14ta`: it judges only the response status and error field, and keeps partial days.
- **Reader Community** (`packages/library/src/analysis/communityInsights.ts`, Analysis tab and MCP `community_insights`): deterministic word-count analysis of synced Reddit text (request threads, recurring phrases, trope mentions asked / praised / complained about, avoid-clauses, books named) set beside what the category's listed books carry; no model reads the text.
- **Open:** the search-page parser and the KDP Orders / KENP Read parsers are tested on synthetic pages and layouts taken from KDP's help text, not on real downloads; capture real ones and tune. Rank-history import formats from third-party tools are unverified.

### 0.4.0: reader community, My Books columns, keyword history
- **Reader Community** (Analysis tab and MCP `community_insights`) moved here from the 0.3.0 notes: see `packages/library/src/analysis/communityInsights.ts`.
- My Books uses the Library's columns plus Pen Name, Orders and KU pages read; Author columns list every author of a collaboration and ignore other credits (`packages/library/src/authors.ts`).
- Sub-category shelf names open their Best Sellers page on Amazon; the Keywords tab gains Suggest Keywords (`keywords/ideas.ts`) and a Search History sub-tab (`keywords/history.ts`).
- Community sync waits patiently at a window it cannot split and slows its pace after timeouts.
- Schema 11 → 12 (`keyword_history`); existing libraries migrate on first open.
