# Customer app: stock tab (PENDING FTJ DECISION, not built)

Website stock (the public API, staff stock tools and enquiries) is in **version 1**. Reserving a vehicle and the cost / CIF
estimator stay deferred. A "stock" tab in the CUSTOMER APP is not built and needs FTJ's decision first.

Today no customer-side stock endpoint exists: nothing under `/api/customer/v1` returns stock. The only customer-facing stock code
is the `NEW_STOCK` event (an alert, push and email a customer can switch off in their notification settings), published
when staff publish a listing with `notifyCustomers: true`.

## Proposed design (if FTJ says yes)

- **Read-only list and detail** under `/api/customer/v1/stock` and `/api/customer/v1/stock/:slug`, behind the customer guard, reusing
  the public DTOs exactly (same key sets, `price: { amount, currency: "LKR" }`, images), PUBLISHED only. Another org's and unpublished
  listings are the same 404. Rate limited like the other customer reads.
- **Filters:** body type, maximum price (whole rupees), and sort (newest, price low to high, price high to low).
- **"Just in":** computed, not stored: published within the last N days (for example 14), from `publishedAt`.
- **Saved vehicles:** a `SavedVehicle` table (`org_id`, customer id, stock vehicle id, created at; unique on customer + stock vehicle;
  index starting with `org_id`; RLS enabled with no policies) via an ADDITIVE migration, generated with `diff-script`, scanned, shown
  to the maintainer, and applied only after the maintainer's approval. Endpoints would be save, unsave and list saved, each scoped to
  the token's customer.
- **Not included:** reserve, deposits, cost or CIF estimates, chat from a listing, any amount other than the listing price.

## Tests it would need
401 without a token and with a staff token; draft, sold and other-org listings are 404; the DTO key set equals the public one; saved
vehicles are only the customer's own (IDOR); parallel save and unsave; rate limits.
