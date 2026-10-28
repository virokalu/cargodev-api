# Unused columns to remove in a later "contract" migration

These columns exist in the database but nothing reads or writes them any more. They are NOT dropped now: dropping is a
non-additive change and needs a separate, explicitly approved contract migration (ADR 0004). Until then they stay, unused.

| Table | Column | Why it is unused |
|---|---|---|
| `Vehicle` | `customerAmount` | FTJ decided customers are shown no amount of any kind. The API no longer selects it for customers, and the staff `PATCH /vehicles/:id/customer-info` rejects it. |
| `Vehicle` | `customerAmountCurrency` | Same decision (it only described `customerAmount`). |

When the contract migration is written: generate it with `diff-script`, read the SQL and the scan result (it will flag the DROPs), and wait
for the maintainer's approval before any `deploy`. Check first that no staff app screen still sends these fields.

## App design documents

The customer app design documents need the matching screen changes: remove the amount on the vehicle card and detail, the
"price" sort option, and the total purchase value on the purchase history screen (it now shows only the delivered count and
member-since). Cancelled vehicles simply do not appear (no "No longer available" card). The staff app's "customer info" form
no longer has an amount and currency.
