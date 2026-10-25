# My Books: Analytics and Royalty Split Reports (0.6.0 plan)

Status: built in 0.6.0 (see CHANGELOG). Not built: MCP tools for the month summary and statements. Items marked **open** need a decision before coding.

## 1. What the KDP download actually contains

Both uploaded files are the same workbook (all nine sheets identical). It is richer than what BookScout imports today.

| Sheet | Grain | Holds | Imported today |
|---|---|---|---|
| Summary | month | paid/free units, paperback/hardcover units, KENP, royalty per currency | no |
| Combined Sales / eBook / Paperback / Hardcover Royalty | **month** x title x marketplace x royalty type x transaction type | units sold, refunded, net, list/offer price, delivery cost, **Royalty**, **Currency** | **no** |
| Orders Processed | month in this file (the dashboard shows it daily) | paid, free units | yes (see risk below) |
| eBook Orders Placed | **day** | paid, free units | no |
| KENP Read | day x title x marketplace | pages | yes |

Consequences:
- **Royalties are not stored anywhere.** `sales_day` holds units only, `kenp_day` holds pages only. Money has to be a new table.
- Royalty data is **monthly, in the marketplace's own currency** (USD, GBP, EUR, CAD, AUD, JPY, INR and others). Splitting and owing money needs a currency decision.
- **KENP earnings are not in the royalty sheets.** Dashboard "$155.43" for October is 78.91 (sheet royalties) plus about $76.5 of KENP at an estimated rate (about $0.0071 per page). The real KENP rate is only published after the 15th of the following month, so KENP income is an estimate until then.
- Transaction types matter for analysis: Standard, Free - Promotion, Kindle Countdown Deals, Pre Order, Standard - Paperback. Royalty types: 35%, 70%, 60%.
- Paperback rows identify books by ISBN, with the ASIN in the last column. Refunds appear as units refunded (royalty can be negative).
- Pen names appear in "Author Name" (Blake Ashford, Loric Thorne, Ashe Wilder, Bryn Wilder).

### Risk to check first (existing importer)
`parseSalesFile` prefers the sheet named like "order", which is **Orders Processed**. In this workbook its dates are `2026-10`. `parseDates` accepts that through its `Date.parse` fallback and turns it into 2026-10-01, so monthly totals would be stored as a one-day spike on the 1st. The first coding step is a test using this workbook. The fix is probably to take daily data from **eBook Orders Placed** when Orders Processed is monthly, and to record which grain each row came from.

## 2. Goals

1. A **Charts and Analysis** section in My Books that tells the author what their books are doing.
2. A **Month view**: pick one month and see everything for it.
3. **Royalty splits** for multi-author books, calculated per month.
4. An **Author Statement report**: what is owed to each author for a chosen period, with Month / Quarter / Year shortcuts and a custom range.

## 3. Data model (new migration, mirrored into user-data / data pack)

- `royalty_month(asin, month 'YYYY-MM', marketplace, format 'ebook'|'paperback'|'hardcover', royalty_type, transaction_type, units, refunded, net_units, list_price, offer_price, royalty, currency, source, imported_at)`, primary key over those fields. Re-importing the same month replaces it (KDP revises recent months).
- `orders_placed_day(asin, day, marketplace, paid, free)`, so daily charts do not depend on the processed report.
- `kenp_rate(month, currency, rate_per_page, source 'estimate'|'actual')`: a user-entered or default rate. **open**: default the estimate from the Summary sheet where a finalized month implies it (Summary royalty minus sheet royalties, divided by KENP), else a setting.
- `fx_rate(month, currency, to_base)` and a `base currency` setting. **open**: see section 7.
- `book_author(asin, person, share_pct)` plus `person(id, name, notes)`: the split. Shares sum to 100 per book. A book with no split row belongs 100% to its report author, so nothing needs configuring for solo books.
- `book_split(asin, from_month, person, share_pct)`: one split per book at a time; each change adds rows from the month the user picks, so earlier months are not rewritten.
- Raw imported files stay under `<library>/sales` as the source of truth (existing rule), and these tables are rebuilt from them by `reindexSales`.

## 4. Import changes (`packages/library/src/sales`)

- Parse the Royalty sheets (prefer the format-specific eBook / Paperback / Hardcover sheets over Combined, to avoid double counting), the Summary sheet (kept for reconciliation), and eBook Orders Placed.
- Reconciliation check at import: sheet royalty totals per month and currency must match Summary; show a warning if not.
- Register books from any sheet (the ISBN to ASIN mapping comes from the paperback ASIN column).
- Test fixture: a trimmed copy of the uploaded workbook (titles and numbers are the author's own business data; scrub if the repo is public). **open**.

## 5. Analysis layer (`packages/library/src/sales/analytics.ts`, pure functions, unit-tested)

All functions take a date range and filters (book, pen name, marketplace, format) and return plain data, so the desktop UI and MCP tools share them.

- `monthSummary(month)`: royalties by source (ebook, print, KENP est.), units, free units, KENP pages, refunds, per book, per marketplace, per format, per royalty type (35/70/60), and promo vs standard; change versus the previous month and versus the same month last year.
- `trend(range, grain)`: monthly series for royalties, units, KENP, plus a daily series for units and KENP.
- `bookLeaderboard(range)`: earnings, units, KENP, share of total, earnings per day since release.
- `ebookVsKu(range)`: per book, sale royalties versus KU pages and their value, to show what KU adds.
- `marketplaceMix(range)`; `royaltyTypeMix(range)` (35% versus 70% effect of price); `priceBands` (units and royalty by offer price).
- `promoImpact`: units in Countdown/Free days against the surrounding days.
- `rankVsSales`: reuse captured rank snapshots against daily units where both exist.
- Data-quality notes surfaced in the UI: months marked estimated (KENP not finalized, current month), months missing from the import, and books with no split.

## 6. UI (desktop renderer)

My Books gets sub-tabs: **Books** (today's table), **Analysis**, **Month**, **Royalties**.

**Analysis tab** (uses `charts.tsx`; extend with a bar and stacked-bar chart, and keep the "Show as table" pattern):
- Headline tiles for the chosen range: royalties, units, KENP, free downloads, with change versus the previous period.
- Royalties by month, stacked (ebook / print / KU estimate).
- Units per day, and KENP per day (like the KDP dashboard but with a book filter and a month comparison line).
- Top books, marketplace mix, 35/70 mix, promo impact.
- Range shortcuts: last 30 days, this month, last month, quarter, year, custom.

**Month tab** (the "look at one month, see everything" view):
- Month picker with previous/next arrows.
- Summary tiles, then a per-book table (ebook units and royalty, print, KENP and estimate, total, share of month, change versus last month).
- Breakdowns: marketplace, royalty type, transaction type, daily chart for the month.
- Click a book to drill into that book for that month (marketplaces and prices).
- Labels the month **Final / Estimated** (KENP) and shows the currency handling.

**Royalties tab**:
- *Splits*: per book, pick people and percentages (must total 100); quick "equal split" and "add author"; people list with pen names they own.
- *Statement*: choose period (Month / Quarter / Year / Custom, each with a picker), choose author or All. Output per author: one row per month and book with gross royalty, their share, and the amount owed; month subtotals and period total; separate lines for ebook, print and KU estimate; a clear Estimated/Final flag per month.
- Export: CSV for all authors and a printable per-author statement (PDF through the existing print path or a styled HTML view). **open**: PDF versus CSV only for v1.

## 7. Decisions

1. **Currency**: both. Statements show every currency as reported and a converted USD total. USD is the base; the monthly rate per currency is editable, with defaults shipped in the app (no network calls).
2. **KENP**: counts toward what is owed for every month before the current one. KDP finalizes a month's KENP rate around the 15th of the following month, so the previous month is included but flagged **Estimated** until the 15th; the current month is excluded (shown separately as "pending"). Rate per month is editable. A statement can be re-run after KDP finalizes.
3. **What is split**: everything for the book (ebook royalties, print royalties, KENP). No expenses in this tool.
4. **Splits**: one split per book. Saving a changed split asks "apply from which month?". Earlier months keep the split they were calculated under (so a change is stored as dated versions internally, but the user only ever sees the current split plus that prompt).
5. Defaults kept from the plan: refunds show negative in their month and net in the period total; print uses the book's split; a payee (person) can own several pen names.
6. **open**: statement output, CSV only or also a PDF per author. Defaults to CSV plus a printable view unless told otherwise.

## 8. Build order

1. Fix and test the sales import grain issue (Orders Processed monthly versus placed daily) against the real workbook.
2. Migration and importers for royalty, orders-placed and Summary; reconciliation; tests.
3. Analytics functions and tests (no UI).
4. Splits storage, statement calculation, and tests (rounding to cents so author shares sum exactly to the total; largest-remainder).
5. Month view, Analysis tab.
6. Royalties tab: splits editor, statement, export.
7. MCP tools for month summary and statement; user guide section; CHANGELOG 0.6.0 entry.

Each step ships with the repo's usual checks (typecheck, vitest), and the service API follows the existing pattern: `service.ts`, `shared/api.ts`, then the view.
