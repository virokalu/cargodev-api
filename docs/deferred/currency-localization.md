# Currency localization for the public website (DEFERRED, not built)

**Current behaviour (FTJ decision): every stock price is in Sri Lankan rupees (LKR), with no conversion.** There is no currency
column, no rate table, no environment variable and no `?currency=` parameter. `StockVehicle.priceFob` holds the listing price in
LKR (the column name is historical and is not renamed, because a rename is a non-additive change). The public API returns
`price: { amount, currency: "LKR" } | null` and never a bare number; the constant is `STOCK_PRICE_CURRENCY` in
`src/config/public-stock.ts`. The website must always label prices LKR.

**Multi-currency remains deferred.** The design below is kept for later so it is not lost. Nothing in it exists in the code.
Any part of it that needs a database change is a normal additive migration (ADR 0004): generate with `diff-script`, read the
SQL and the scan, and wait for approval before any `deploy`.

## The design

### Stored price
- One **base price per listing, stored in USD**. A single currency in the database keeps filters, sorting and "price between"
  correct and avoids a column of mixed currencies.
- If a listing is ever priced in another currency by the business, that is a separate decision (see open questions).

### Rates
- A **staff-maintained rate table**, one row per currency: USD to X, the date it was set, who set it. Staff only
  (ADMINISTRATOR / MANAGER), every change written to the ActivityLog in the same transaction.
- **Typo guard:** a new rate is refused (or needs an explicit "I am sure") when it differs from the previous rate by more than a
  set percentage, so a slipped decimal point cannot put wrong prices on the website.
- **Staleness limit:** a rate older than a set number of days is not used; the website then shows the USD price only, and staff
  get a reminder to refresh the rate.
- Only whole, supported currencies are accepted (a short allow-list), never arbitrary codes from a client.

### Math
- **Decimal math only** (never floating point) for conversion.
- **Per-currency rounding:** each currency rounds to its own minor unit (for example 0 decimals for JPY, 2 for USD and EUR), and
  indicative prices may be rounded to a "nice" figure for display. The USD base price is never altered by a conversion.

### Which currency the website shows
Chosen by the website, in this order:
1. an explicit **cookie** the visitor set (their override),
2. the visitor's **country from Cloudflare**, mapped to a currency,
3. **USD** by default.

The country comes from the `CF-IPCountry` request header. Verified in Cloudflare's IP geolocation documentation: Cloudflare adds
`CF-IPCountry` to requests to the origin, and it is available once **IP Geolocation** is turned on for the zone (Network
settings). The documentation page checked does not describe the special values for unknown or anonymised traffic; read that
before relying on it, and treat any value that is not a known country code as "unknown" (USD). The header is only trustworthy
when requests really come through Cloudflare, so the API must not accept it from other sources.

The page shows the **USD price first**, with an **approximate local price** beside it, clearly labelled as indicative.

### What is never converted
- **The customer app and purchased-vehicle amounts are never converted.** Customers see no amounts at all (FTJ decision, see
  `docs/deferred/unused-columns.md`), so there is nothing to convert there.
- Invoices, bills and any amount a customer actually pays are outside this feature.

## Open questions for FTJ
1. **Which currencies and which countries at launch?** (This decides the allow-list and the country-to-currency map.)
2. **Indicative or invoiced prices?** Is the converted price only a guide ("about 4,200 EUR"), or may it be quoted and honoured?
   This decides the wording on the page and whether rounding rules can be loose.
3. **Manual rates or a feed?** Staff-maintained rates are simple and predictable; a rate feed is automatic but adds a dependency
   (not added without approval), a provider to trust, and a failure mode (stale or wrong data).
4. ~~What currency is `priceFob`?~~ Answered: LKR (see the top of this file).

## If and when it is built
- Additive migration: one nullable column or a small rate table with `org_id`, an index starting with `org_id`, and RLS enabled
  with no policies (CLAUDE.md database rules).
- Public API change: a documented, strict, allow-listed `currency` response field or parameter, with tests that no other value is
  accepted and that the USD base is unchanged.
- Tests: rounding per currency, the typo guard, the staleness limit, the cookie > country > USD order, and a key-set test that the
  public responses still contain nothing internal.
