# Paying authors from KDP payment reports (0.6.2 plan)

Status: built in 0.6.2 (see CHANGELOG). Still open: a real payment report with non-USD lines, to confirm the derived-share rule.

## 1. What the payment report shows (one real sample)

`KDP_Payments` has one sheet, "Payments". Each payment is a header row followed by one detail row per **sales month and source**:

| Header row | Detail rows |
|---|---|
| Sales period start and end, paying entity (Amazon.com), payment number, payment date, method (WIRE), accrual currency (USD), **accrued royalty**, **tax withholding**, **net earnings**, **FX rate** (USD to the bank currency), bank currency (NZD), **payout amount** (NZD), status | month (`2025-11`), currency, accrued, tax, net, source: `Sales` (eBook and print royalties) or `Kindle+ Royalties` (KENP) |

Checked against the royalty workbook already imported:

- **Sales lines equal the royalty sheets exactly** for Amazon.com, month by month (for example 2026-08: 131.24).
- **Kindle+ lines equal KENP pages read on Amazon.com only, times a rate** (2026-08: 1,976 pages, 9.68, which is 0.0049 per page; the Summary-derived rate we already use gives 9.67). So KENP is **paid per marketplace, in that marketplace's currency**: this USD payment contains none of the UK, EU, Canada, Australia or India pages. It confirms the way 0.6.0 already prices KENP (pages per marketplace, rate per currency), and these lines give the exact figure to the cent.
- One payment covers **many months** (Jul 2025 to Aug 2026): KDP holds royalties until a currency's balance passes its minimum, then pays everything accrued. The payment date (2026-10-29) is about two months after the last month included (Aug).
- **Tax is withheld** at 5% of every line (accrued 188.92, tax 9.43, net 179.49).
- **There is one lump-sum payment, not one per marketplace.** The header's "Marketplace: Amazon.com" is the paying entity. Its accrued royalty is in USD, and the **FX rate and payout amount are the conversion of that USD lump sum into the bank currency (NZD)** at the rate on the payment date. They are "Pending info from Bank" until the wire is processed. How KDP converts each marketplace's own currency into the USD total is **not shown anywhere**.
- In this sample the lump sum holds **only USD-marketplace money**: its Sales lines equal the Amazon.com royalties exactly, and its Kindle+ lines equal the Amazon.com pages only. The GBP, EUR, CAD, AUD and INR months (for example August: 10.00 GBP, 5.37 EUR) are not in it, so they are still unpaid. When they are paid they will presumably appear as lines in a currency other than USD (the detail rows have their own Currency column) folded into a later lump sum at a conversion we cannot see. **Upload a report that contains such lines when there is one.**
- Status reads "Paid" while the bank details are pending, so it should not be read as "money received".

## 2. What goes wrong today

The 0.6.0 statement is by **sales month** and converts other currencies with a rate the user types or a built-in guess. Real payments differ: the money arrives later, in one lump sum covering many months, after tax, converted from USD into the bank currency at the rate on the payment date. A quarterly statement built on guessed rates will not match what was received.

## 3. Design

**Import** (`KDP_Payments` workbook, same Import button; the file is kept under `<library>/sales/payments`, so the database can be rebuilt):
- `payment(number, paid_on, method, accrual_currency, accrued, tax, net, fx_rate, payout_currency, payout_amount, status, from, to)`
- `payment_line(payment_number, month, source, currency, accrued, tax, net)`
- Re-importing a payment replaces it (numbers are unique). A payment whose FX or payout is still pending is stored as pending and filled in when a later report has them.

**Matching to royalties.** A payment line is matched to the earnings of the same (sales month, source, currency). Each earning is then **Paid** (in payment N on date D, with its tax and net) or **Awaiting payment** (an estimate at the user's or default rate, as today).
- Sales lines also check the royalty import: a difference is shown (KDP revised a month) instead of hidden.
- Kindle+ lines set the exact KENP rate for that month and currency, replacing the derived one.
- **Authors are paid in USD**, Amazon's figure: a paid line's amount is its **net USD** from the payment (accrued minus tax withheld). The conversion to the bank currency (NZD) is the user's own and does not touch the authors' shares; the Payments tab shows it per payment (FX rate and payout amount, or "pending") for reconciling the bank deposit.
- **Lines in a currency other than USD** (when they first appear): the conversion KDP used to reach the USD total is not reported. If the payment's accrued total exceeds its USD lines, the difference is the USD value of the non-USD lines; it is shared between them in proportion to their estimates at typed or default rates, and marked as derived. This needs a real sample before it is relied on.

**Statement.** The same split per book and the same CSV and PDF, with a per-line status (Paid with payment number, date and rate; Awaiting; Estimated), in USD. Two bases:
1. **Paid in the period** (by payment date): the lines of every payment made in the quarter or month, split by each line's sales month. This is what can actually be paid out to authors.
2. **Earned in the period** (by sales month, as today): what the books made, with the status column showing how much of it has been paid yet.

**Reconciliation view** ("Payments" tab): each payment with its lines, accrued, tax, net, FX and payout; how much of it is split to each author; and any accrued royalty not yet in a payment, by currency, so the user can see why a month's money has not arrived.

**Tax.** Authors' shares are computed on **net** (decision 2).

## 4. Decisions

1. **Basis**: the statement defaults to **paid in the period** (by payment date), with **earned in the period** (by sales month) as a toggle.
2. **Tax**: author shares are computed on the **net** after withholding. The statement shows accrued, tax withheld and net as separate lines.
3. **Unpaid months**: shown as **awaiting payment** with an estimate at the typed or default FX rate, clearly marked and left out of "owed now".
4. **Currency**: authors are paid in **USD**, Amazon's figure. The NZD conversion is shown on the Payments tab only.
5. **open**: a payment report with non-USD lines, to confirm how they appear before the app relies on the derived-share rule above.

## 5. Build order

1. Payments importer and tables, with a trimmed copy of the sample as a test.
2. Match payments to earnings; exact KENP rates from Kindle+ lines; paid and awaiting status.
3. Statement by payment date and by sales month, with status and the tax line; CSV and PDF.
4. Payments tab (reconciliation) and the unpaid-by-currency summary.
5. User guide, CHANGELOG, tests with a non-USD sample when available.
