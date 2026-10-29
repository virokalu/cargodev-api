# Project rules (for humans and coding agents)

This file is the contract. If a change breaks a rule here, change the rule in a PR first.

## Layering

`routes/` (thin) -> `services/` (all business logic) -> Prisma.

- A route handler does only: authenticate -> zod-parse input -> call one service -> shape response.
- Services are framework-free. They throw `ServiceError(code, message, fieldErrors?)` and know nothing about HTTP.
- One central error handler maps errors to the response envelope.

## Non-negotiable rules

1. Every query filters by `orgId`. `orgId` comes from the **verified token**, never from the request body, query or params.
2. A resource in another org returns **404**, never 403.
3. zod validation on every mutation, server side.
4. Every mutation writes an `ActivityLog` row via `activityLog.record(tx, ...)` **inside the same `prisma.$transaction`**.
5. Lookup rows are created only through lookup services.
6. Tri-state flags (`auctionBillPaid`, `logBook`, `extraKey`) are `Boolean?`. `null` means "not entered". Never coerce to `false`.
7. Roles are exactly `ADMINISTRATOR | MANAGER | OPERATOR | VIEWER`, enforced in the auth hook per route, not only in a UI.
8. Serial numbers are read-only after creation except the admin correction service. Counter rule: `lastNumber = max(lastNumber, entered)`, incremented in a transaction.
9. FC vs FL uses the **effective track** helpers, not `serialPrefix`. FL vehicles never store shipping fields.
10. Soft-deleted vehicles (`deletedAt`) are excluded from every read path.

## Response contract

- Success: `{ "data": ... }`. Error: `{ "error": { "code", "message", "fieldErrors?" } }`.
- Every response sends `Cache-Control: no-store`, with three deliberate exceptions: the customer file endpoints (`private, max-age=<CUSTOMER_FILE_CACHE_SECONDS>`), the successful read endpoints under `/api/public` (`public, max-age=60`; the enquiry POST and every error stay `no-store`), and the successful answers of the signed file links `GET /f/v1/...` (`private, max-age=<the link's remaining life, at most 300>`; every failure is one identical `no-store` 404). `/api/public` has its own CORS allow-list (`PUBLIC_ALLOWED_ORIGINS`, never `*`) and exists only when `PUBLIC_STOCK_ENABLED=true`.
- Never leak internal error messages. Unexpected errors log server side and return `INTERNAL`.

## Security rules

- No secrets, real hostnames, bucket names, customer data or org ids in code, tests, docs or fixtures.
- Logs must never contain tokens or passwords (the `Authorization` header is redacted).
- Do not add dependencies casually. Justify each one in the PR.
- Do not approve npm install scripts you cannot explain.

## Database safety

- This repo owns the schema (`prisma/schema.prisma`) and `prisma/migrations/` (ADR 0004). Changes go through reviewed, **additive-first** migrations: new tables, new nullable columns or columns with a safe default, added enum values. No drops, renames, type changes, or new NOT NULL columns without a default; removing old things is a separate, explicitly approved "contract" migration. Every new table has `org_id`, an index starting with `org_id`, and `ENABLE ROW LEVEL SECURITY` with no policies.
- Migration commands run **only** through `npm run migrate -- <command>` (`scripts/migrate.ts`). It uses `MIGRATION_DATABASE_URL`, else `DIRECT_URL` (the direct, non-pooled connection, as in CargoDev). It does not check which database that is, so every `deploy` needs the maintainer's explicit approval for that specific run, after the runbook checks (compare the printed project ref, not just the host, with the maintainer's private notes; backup first if the database holds real data). Agents may run `status`, `drift`, `scan`, `create` and `diff-script` on their own, never `deploy`. Only the fixed commands exist (`create`, `diff-script`, `scan`, `deploy`, `status`, `drift`): never `migrate reset`, `db push`, `--force-reset` or `--accept-data-loss`, and never `migrate resolve`. If `migrate dev` reports drift or wants a reset, stop and ask. If `_prisma_migrations` is empty or missing but the tables exist, stop: the maintainer baselines it.
- Read the generated SQL and the scan result before applying any migration. Anything the scan flags (DROP, ALTER COLUMN TYPE, RENAME, TRUNCATE, DELETE, NOT NULL without DEFAULT) means stop and ask; only a maintainer approves it (`prisma/migrations/scan-approved.txt`).
- Never run any other database-changing command against a shared or production database. The test harness runs only against a local or CI throwaway Postgres container (`npm run test:db`).
- The harness connects through `TEST_DATABASE_URL` only and never reads `DATABASE_URL`. It refuses to run unless the host is localhost/127.0.0.1/::1 (or the CI service container), the database name starts with `cargodev_test`, and the database is empty or was created by the harness. Do not weaken or bypass this check (`tests/db/guard.ts`).
- Seed data in tests is fake. Local development uses your own dev database.

## Customer zone (Phase 2, ADR 0005)

Customer accounts are a separate zone from staff, under `/api/customer/v1`.

- Separate token: HS256, `aud: "customer"`, signed with `CUSTOMER_JWT_SECRET` (must differ from `MOBILE_JWT_SECRET`; startup fails if equal). Staff tokens carry `aud: "staff"`. Both guards verify the audience AND the issuer.
- Never trust `customerId`, `orgId` or a role from the request. They come from the verified token; the guard re-loads the account on every request.
- Every customer query filters by `orgId` AND the customer's own id. Another customer's resource is 404. Every customer route has an IDOR test.
- Responses are whitelisted DTOs built field by field. Never return or spread a raw Prisma row.
- A customer's password is set at `verify-email` (together with the emailed code), never at register: nobody can pre-register someone else's address with a password they know. Passwords and hashes never appear in a response, a log or an error; the redactor scrubs bcrypt hashes.
- Responses for register, login, verify, forgot and reset never reveal whether an email has an account (same shape, same timing).
- Logs never contain passwords, one-time codes, tokens, message bodies or full email addresses.
- Email goes only through `src/lib/email.ts` and is a no-op without `RESEND_API_KEY`.
- Customers get photos and documents only through the API (`/photos/:id/image`, `/documents/:id/file`, by database id): the API checks, then reads from R2 and streams. A customer response, DTO, error or log never contains an R2 address, an object key or the account id. Presigned URLs exist only for staff uploads.
- No amount of any kind (price, per-vehicle amount, total purchase value) is ever shown to a customer, and cancelled vehicles are never shown (FTJ decisions).
- Only jpeg, png, webp and pdf are accepted, stored or served. Never svg, html or anything a browser could run.

## Out of scope for now

WhatsApp sending, phone OTP, reservations and cost estimates, new price/category fields. If a task tempts you into these, raise it in an issue first.

## Definition of done

Typecheck passes, tests pass (including 401/403/404 cases for new routes), docs updated if behaviour or contract changed. Anything that depends on real SQL behaviour (NULL handling, locks, constraints, concurrency) gets a test in `tests/db`, because the in-memory fake cannot prove it. `npm run test:db` passes (CI runs it in the `ci` job).
