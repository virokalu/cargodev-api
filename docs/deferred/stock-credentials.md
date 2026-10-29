# Proposal (not built): a separate credential pair for the public stock bucket

**Status:** proposed. Needs the maintainer's decision. Nothing here is implemented.

## The gap

One storage credential pair (a token scoped to both buckets) serves the private files bucket AND the public stock bucket, because the
settings have no separate pair for the public one. Anyone who obtains the API's credentials reaches both. The design is that the public
bucket has its own token that can touch only that bucket.

## Proposed change

- Two optional settings, `R2_STOCK_ACCESS_KEY_ID` and `R2_STOCK_SECRET_ACCESS_KEY`, set together or not at all (validated like the existing
  all-or-none credential group, names only in errors).
- The public-stock store (`src/app.ts`) uses them when set.
- **Outside production**, when they are not set, fall back to the main pair and log **one masked warning** at start-up (the setting names,
  never a value).
- **With `APP_ENV=production`**, refuse to start without them while `R2_PUBLIC_STOCK_BUCKET_NAME` is set.
- Refuse to start when `R2_PUBLIC_STOCK_BUCKET_NAME` equals `R2_BUCKET_NAME` (stock images would land in the private bucket).
- Tests: the all-or-none rule, the fallback warning, the production refusal, the equal-bucket refusal, and that the stock store is built with
  the stock pair (a recording factory), plus docs (`docs/env.md`, `.env.example`, the CI dummy env) and a security-model row.

## Also found while reading the setup

- Registering a stock image does not check that the object exists or what it is; the file-registering endpoints for vehicle files now do.
- `PUBLIC_STOCK_IMAGE_BASE_URL` validation (https, no credentials/query/fragment, no r2.dev in production) IS built (`APP_ENV`).
