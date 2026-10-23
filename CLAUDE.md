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
- Every response sends `Cache-Control: no-store`.
- Never leak internal error messages. Unexpected errors log server side and return `INTERNAL`.

## Security rules

- No secrets, real hostnames, bucket names, customer data or org ids in code, tests, docs or fixtures.
- Logs must never contain tokens or passwords (the `Authorization` header is redacted).
- Do not add dependencies casually. Justify each one in the PR.
- Do not approve npm install scripts you cannot explain.

## Database safety

- Schema is owned by the CargoDev repo. This repo only runs `prisma generate`.
- Never run database-changing commands against any shared or production database. They are allowed only against a local or CI throwaway Postgres container.
- Local development uses your own dev database.

## Out of scope for now

Customer accounts/login, public website API, chat, email/WhatsApp, new price/category fields. If a task tempts you into these, raise it in an issue first.

## Definition of done

Typecheck passes, tests pass (including 401/403/404 cases for new routes), docs updated if behaviour or contract changed.
