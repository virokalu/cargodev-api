# Testing

Tools: Vitest, `app.inject()` for routes, an in-memory fake database for fast unit tests, and a **real Postgres** (a throwaway container) for everything that depends on how the database actually behaves.

| Command | What it runs | Needs a database? |
|---|---|---|
| `npm test` | Unit and route tests against an in-memory fake | No |
| `npm run test:db` | The real-Postgres tests in `tests/db` | Yes: a throwaway one, see below |
| `npm run test:all` | Both | Yes |

CI runs both in the required `ci` job.

## Per-route checklist

- [ ] 401 without a token
- [ ] 403 for each disallowed role
- [ ] 404 for an id belonging to another org (seed two orgs, call with org A token on org B ids)
- [ ] 400 with `fieldErrors` for invalid input
- [ ] Response matches the envelope and sends `Cache-Control: no-store`

## Service tests

- Legacy serial bump: `lastNumber = max(lastNumber, entered)`
- ETD set/cleared produces the right status transition and a `StatusHistory` row
- Tri-state `null` survives an update (not coerced to `false`)
- FL vehicles strip shipping fields
- FC freight-agent capability (RORO/Container) is rejected when wrong
- A staff id is rejected as `customerId`
- An `ActivityLog` row exists after each mutation

## Contract tests

- Envelope shape and error codes match `docs/api-contract.md`
- Unexpected errors never leak their message

## Real-database tests (`tests/db`)

The in-memory fake proves our logic. It cannot prove anything that depends on Postgres itself, so these tests run against a real one:

- **NULL handling.** `{ not: id }` and a top-level `NOT` on a nullable column drop the NULL rows (SQL three-valued logic), while `NOT` over a relation filter keeps rows with no related row. Found while writing `null-semantics.db.test.ts`; it exposed a real bug in the row-colour filter.
- **Serial numbers.** Parallel creates get distinct, gap-free serials; the counter never moves backwards under concurrent legacy entries; the unique constraints are the backstop.
- **Advisory locks.** A second session is refused while the first holds the job lock, the lock is released on commit, rollback and a dying connection, and two scheduler instances run a job one at a time.
- **Vehicle and dashboard SQL.** The effective-status filters, relation search and ordering, NULLs-first/last ordering, soft delete, org scoping, and that the dashboard's counts agree with the list each bar links to.

Files named `*.concurrency.db.test.ts` need **real concurrent connections** (Docker or the CI service container). A single-session or in-process Postgres serializes everything, so they would pass for the wrong reason or fail confusingly. Run them only against a real server.

### Running them locally

You need Docker. Everything is fake data in a container that is thrown away.

```powershell
npm run db:test:up        # starts postgres on 127.0.0.1:55432 and prints the URL to set
$env:TEST_DATABASE_URL = "postgresql://postgres:example-throwaway-password@127.0.0.1:55432/cargodev_test"
npm run test:db
npm run db:test:down      # when finished
```

No `sh`? Run what `scripts/test-db.sh` runs:

```powershell
docker run -d --rm --name cargodev-api-test-db -e POSTGRES_PASSWORD=example-throwaway-password -e POSTGRES_DB=cargodev_test -p 127.0.0.1:55432:5432 --tmpfs /var/lib/postgresql/data postgres:16 -c fsync=off
```

### How the schema gets there

`tests/db/global-setup.ts` runs `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`, which only **prints** SQL (it never connects), and applies it to the throwaway database. It never runs `migrate dev`, `migrate deploy` or `db push`. The schema is rebuilt from `prisma/schema.prisma` on every run, so it cannot drift from the schema file (and, once migrations exist, a test should confirm that applying them gives the same schema). Each test starts from empty tables.

### The safety guard

The setup **drops and recreates the `public` schema**, so it must be impossible to aim it at a database that matters (`tests/db/guard.ts`, tested by `tests/db-guard.test.ts`). It refuses to run unless **all** of these hold:

1. `TEST_DATABASE_URL` is set. The harness reads that variable only and **never reads `DATABASE_URL`**. The tests overwrite `DATABASE_URL` with an unreachable address, so even code that forgot to use the test client could not reach a real database.
2. The host is `localhost`, `127.0.0.1` or `::1`, or the CI service container (`postgres`, only when `CI=true`). URLs with `host=`, `hostaddr=` or `service=` parameters are refused because they can redirect the connection.
3. The database name starts with `cargodev_test`.
4. The database is **empty or was created by this harness** (a marker comment on the schema). This catches what 1 to 3 cannot: a real database reached through an SSH tunnel looks like `localhost`.

It never prints the connection string (it contains a password).

If you see "The database test harness refused to run", read the message: it says which rule failed and nothing was changed.

## Customer zone tests

- `tests/helpers/customer-fixtures.ts` seeds two organisations, several customers, a staff user and the `IDOR_WORLD` actors (own, another customer in the same org, a customer in another org). New customer routes that return or change owned data reuse it: your own resource is found, another customer's is 404, another org's is 404.
- `tests/customer-zone.test.ts`: forged tokens in both directions, env validation, `/me` DTO key-set, IDOR, rate limits, timing parity.
- `tests/customer-auth.test.ts`: the flows. `tests/customer-logs.test.ts`: real log output.
- `tests/db/customer-auth.db.test.ts` and `customer-auth.concurrency.db.test.ts`: the SQL and the parallel guarantees (the concurrency file needs a real Postgres).
- The email queue is replaced by a recorder in tests so the plain code can be read back. Tests never have `RESEND_API_KEY`.

## Private-ready bucket tests

- `tests/file-links.test.ts`, `tests/file-link-env.test.ts`, `tests/db/file-links.db.test.ts`: the own-domain file links (ADR 0007): the exact format and signature, serving and headers, ETag and Range, a forged or altered link for every field and parameter, expiry and the cap, immediate revocation (staff deactivation, un-release, unlink, deletion, a disabled customer), secret rotation, one identical 404, the rate limit, the size cap, stopping the storage read when the client leaves, real log output, a scan for storage hosts, keys, bucket names and the account id, the staff endpoints, the PDF export, and the settings' validation. `tests/r2-audit.test.ts` covers `npm run r2:audit`.
- Mutation checks run on this feature: 16 breakages (host and org-prefix checks in the shared key function, the key source, the TTL, the type allowlist, the three redaction patterns, returning the stored address, logging addresses, fetching the public address), each caught; the host check needed same-length host and scheme cases added.

## Deployment tests

- `tests/deployment.test.ts`: the settings and their refusals (pool size, shutdown deadlines, client address source and header name), graceful shutdown (order, a second signal, a failing close, the deadline cutting off a hang, a real app sending `event: shutdown`), the pool size reaching the driver, the client address modes (socket ignores every forwarding header; hops; header mode with validation, fallback, one masked warning a minute, and rate-limit keys that follow the header), the database latency script with a fake client, and the container files (pinned tag, non-root, exec-form CMD, health check, `--ignore-scripts`, no `.env` copied, `.dockerignore`, the CI image job).
- `tests/route-inventory.test.ts` with `tests/route-inventory.table.ts`: every registered route against one explicit table, in both directions, then 401 / cross-zone 401 / 403 per role for every non-public route, and the operator scope for chat.

## Slice 7 tests

- `tests/public-stock.test.ts`: the flag (off means none of the routes exist), what the public sees (only PUBLISHED of the default org; exact key sets; the same 404 for draft, sold, other-org, malformed and unknown slugs; filters, sorts, the 24 cap and strict parameters), cache and CORS headers (per-route allow-lists, preflight, no `*`), the enquiry form (validation, honeypot, body limit, per-IP and per-email limits, Turnstile on/off/fails closed, nothing typed in logs), the staff inbox, the staff access matrix (401, 403 for OPERATOR and VIEWER on all 15 routes), stock management (draft, edit, explicit publish, sold, unpublish, new-stock alerts), and images (presign, registration, order, delete, limits).
- `tests/db/public-stock.db.test.ts` (real Postgres): public filters with NULL, case and wildcards, Decimal prices, sorting and paging, the unique slug, the image cascade, four staff publishing at once (one wins), and enquiries.
- Mutation checks run on this slice: 25 breakages (public filter, page cap, id and key leaks, org and listing scoping, key ownership, publish rules, honeypot, Turnstile, alert content, slug check, rate limits, body limit, cache headers, CORS, roles, the flag, image types), each caught.
- The in-memory fake now treats a comparison with NULL as false (`gt`, `gte`, `lt`, `lte`), like Postgres.

## Slice 6 tests

- `tests/chat.test.ts`: the access matrix (customer and staff routes: 401, 403 per disallowed role), own-conversation IDOR, vehicle ownership, plain-text rules (length 2000, trim, control characters, markup stored verbatim, no sender or attachment fields), rate limits and the conversation cap, who receives the live event and the alert (staff, agent, the customer; never the wrong party or org), alert coalescing, inbox filters and org scoping, reply and handled with ActivityLog, rejection reasons, account deletion, and the live stream on a real socket.
- `tests/db/chat.db.test.ts` (real Postgres): scoping as SQL, 20 parallel messages (which found and fixed a last-message-time race), the foreign-key cascade, account deletion, and three parallel rejections with a reason producing exactly one message.
- Mutation checks run on this slice: 21 breakages (scoping, ownership, the length/control/trim/strict rules, coalescing, text in alerts, wrong recipient, rate limit, roles, cap, account deletion, the stream whitelist), each caught (one more test was added for the trim and the whitelist; the org filter next to the customer id is redundant because ids are unique).

## Slice 5 tests

- `tests/otp-hardening.test.ts`: the pepper (required, 32+ bytes, differs from both JWT secrets; the stored hash is the keyed HMAC and cannot be brute-forced without it), email only after the response (a slow or failing provider changes nothing), the hourly caps per address and per IP, and response-time equality between a registered, an unregistered and a staff address on register, resend and forgot.
- `tests/customer-notifications.test.ts`: the access matrix on every route, alerts grouped by day and their IDOR, preferences, devices, presence, delivery that respects each switch (alert, push, email), the staff actions that tell the customer, departure reminders (3, 7, 14, idempotent), and the customer stream on a real local socket (no staff events, closes at token expiry, 3 per customer).
- `tests/db/customer-alerts.db.test.ts` (real Postgres): grouping and scoping, JSON preferences, parallel first saves, parallel device registration, presence on real timestamps, departure reminders and the advisory lock with six parallel runs.
- Mutation checks run on this slice: 28 breakages of the OTP, email, cap, alert, preference, device, presence, reminder and stream rules, each caught by a test (two needed a test added first).

## Slice 4 tests

- `tests/customer-admin.test.ts` (fake data): every staff route has the access matrix (401 without a token and with a customer token; 403 for each disallowed role, with the tables unchanged; allowed roles pass), the foreign-org 404 list, validation (strict bodies), behaviour and ActivityLog rows, session revocation end to end, FAQs, release of vehicles, photos and documents, mark arrived/delivered, the arrival reminder cadence, and the masked link-request warning.
- `tests/db/customer-admin.db.test.ts` (real Postgres): disabling revokes sessions and device tokens; 15 parallel rounds of two customers claiming one vehicle and of approve/reject on one request; all-or-nothing bulk release; the 5 minute online window; the arrival reminder query and its once-a-day idempotency.
- Mutation checks run on this slice: removing the session revoke, the device token delete, any org filter, the vehicle scoping of photo/document lookups or the online window each fails a test. The two race guards in `approveLinkRequest` survive the fake and are caught only by the real-Postgres file.

## Slice 3 tests

- `tests/customer-data.test.ts`: the customer read API with fake data. Internal values are seeded as `SENTINEL-...` strings and searched for in every response; every DTO's exact key set is asserted; every route has the ownership matrix (owner, another customer, another org, unreleased, local, cancelled, converted, deleted, unknown) and the link request block.
- `tests/db/customer-data.db.test.ts`: the SQL parts on real Postgres: derived status filters (each vehicle under exactly one status), sorting with nulls last, brand filter, visibility as SQL, Decimal money, link requests.

## Slice 2 tests

- `tests/milestones.test.ts` (routes, automation, the removal rule branch by branch), `tests/storage-signing.test.ts` (presign, content types, and the customer file gateway against a recording store, including a scan of every customer response and log for storage details), `tests/r2-object-store.test.ts` (endpoint, checksum settings, signed headers; offline), `tests/milestone-backfill.test.ts`, `tests/photo-release-report.test.ts`, `tests/env-storage.test.ts`, `tests/thumbnail.test.ts` (sharp on hostile bytes, and the service).
- `tests/db/milestones.db.test.ts` and `milestones.concurrency.db.test.ts`: unique index, rollback, defaults, visibility filters, and parallel writers (the concurrency file needs a real Postgres).
- No test contacts a bucket: the store is a recorder.

## Migrations (separate from the test harness)

`npm run migrate -- <command>` is the only way to run migration commands (`scripts/migrate.ts`, helpers in `scripts/migrate-tools.ts`, tested by `tests/migrate-tools.test.ts`). It aims at `MIGRATION_DATABASE_URL`, else `DIRECT_URL`. It does not check which database that is. It prints the host, port, database name and Supabase project ref (never the password) first, and **every `deploy` needs a maintainer's approval for that run** (see `docs/runbook.md`).

- Only fixed commands exist: `create <name>` (generates a migration, does **not** apply it), `diff-script <name>` (same, without a shadow database), `scan`, `deploy`, `status`, `drift`. There is no way to pass raw flags, so `reset`, `db push`, `--force-reset` and `--accept-data-loss` cannot be used, and `migrate resolve` is not offered.
- `status` is read-only (the connection is set read-only): it prints the target, whether `_prisma_migrations` exists and what it holds, the pending migrations and the scan result.
- `drift` is read-only: it compares the live database with `prisma/schema.prisma` and prints "no differences" or the statements that would make them match (table, column and index names; no data). It asks the session to be read-only, never prints the URL, and redacts connection strings from error text.
- `deploy` prints the SQL of the pending migrations and scans it for DROP, ALTER COLUMN TYPE, RENAME, TRUNCATE, DELETE, NOT NULL without DEFAULT, and a new table missing `org_id`, an `org_id`-first index or row level security. A flagged migration is not applied until a maintainer lists it in `prisma/migrations/scan-approved.txt`.
- `deploy` also stops, applying nothing, if the tables exist but `_prisma_migrations` is empty or missing, if a migration is recorded as unfinished (neither `finished_at` nor `rolled_back_at` set; a row with `rolled_back_at` is ignored, as Prisma does), or if the database has migrations that are not in `prisma/migrations/`. The maintainer fixes the history.
- The Prisma process sees one URL only, through `scripts/prisma.migrate.config.ts`. `DATABASE_URL` and the other connection variables are removed from its environment.

Flow: `create` → read the printed SQL and scan → `status` → maintainer approval → `deploy` → `npm run test:db`.

If `migrate dev` cannot create its shadow database, do not loosen permissions: use `diff-script <name>`. If it reports drift or asks to reset, stop and ask.

## Rules

- Test data is fake. No real names, org ids, hostnames or customer data.
- Test-harness commands run **only** against a local or CI throwaway container, through `npm run test:db`. Migrations run only through `npm run migrate`, never with raw Prisma commands.
- Do not build secret-looking fixtures as string literals (`password: "..."`): the secret scan has no allow-list. Build them at runtime or use an obviously fake value containing `example`.
- Anything that depends on real SQL behaviour (NULLs, locks, constraints, concurrency) gets a test in `tests/db`.
- Fix a bug by first writing the test that reproduces it.
- `tests/startup-and-logging.test.ts`: production refuses to start without `CLIENT_IP_SOURCE`, the socket-mode forwarding-header warning (once a minute, header names only), what a real request log line may contain (no query string, raw URL, parameter values or addresses), and the image library being optional (simulated `sharp` import failure).
- `tests/staff-auth-freshness.test.ts`, `tests/db/staff-auth.db.test.ts`: the staff authorization check against the database (deactivated, demoted, other org, customer row, token role lies), the cache (time, off, bypass, per org, in-flight invalidation), invalidation by every staff-changing service, and stream re-checks. Most other unit tests mint tokens for users that exist only in the token: `tests/setup-env.ts` switches the `NODE_ENV=test` seam on for them; a test that proves the database check calls `setTrustTokenClaimsForTests(false)`. After `vi.resetModules()` the seam is off again in the fresh module graph: switch it on in that test if it needs it.
- `tests/org-scoped-writes.test.ts`, `tests/db/org-scoped-writes.db.test.ts`: writes carry org_id in their own where clause. A static scan fails on any write in `src/` without it; `tests/helpers/fake-prisma.ts` throws on an unscoped update/updateMany/delete/deleteMany/upsert for every table with an org_id column (photos and documents must use `vehicle: { org_id }`), so ALL unit tests enforce the rule; the 'read lies' tests make the earlier read return another org's row and expect a 404 and no change. The only exceptions are the two secret-keyed lookups (refresh-token hash, Expo push token).
- `tests/db/retention.db.test.ts`, `tests/retention.test.ts`: retention against real Postgres (each deletion at its exact cut-off day, what must be kept, the 1000-row batch, idempotence, org scoping, the counts-only summary row, rollback with the log write) and the settings' bounds and daily-job wiring.
- `tests/viewer-privacy.test.ts`: a VIEWER gets customer list rows and by-customer report groups without email, phone and address (exact key sets, the keys absent), cannot find a customer by email or phone, and the other roles are unchanged.
- Timing tests use a virtual clock (`tests/helpers/virtual-clock.ts`), not the wall clock: `Date` and `setTimeout` are faked and the clock jumps to the next timer whenever the request waits on one. A response floor of 120 ms is then exactly 120 virtual ms however busy the machine is (checked with twice as many busy loops as CPU cores), and a branch that waits for something extra (an inline email send) shows up as extra virtual time. Bcrypt work is checked by counting calls (`tests/login-enumeration.test.ts`, `tests/customer-zone.test.ts`).
- The `org_id` scan (`tests/helpers/org-scan.ts`, used by `tests/org-scoped-writes.test.ts`) reads every `.ts` file under `src/` (new files are covered with no change), finds each Prisma call, and requires `org_id` at the TOP LEVEL of that call's own `where` (spreads, `AND` arrays and helper functions are followed; a nested `org_id` or `user.org_id` does not count). It covers writes and reads of tables with an `org_id` column; photos and documents must use `vehicle: { org_id }`. The few reads that are scoped another way are listed in the test with the reason.
