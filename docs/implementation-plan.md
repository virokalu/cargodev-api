# Implementation plan: standalone CargoDev API

Context file for contributors and their coding agents. Read it together with `CLAUDE.md`,
`docs/architecture.md` and `docs/security-model.md`. If this plan conflicts with `CLAUDE.md`,
`CLAUDE.md` wins and this file should be fixed in a PR.

## 0. Goal

Build a standalone Node.js (TypeScript) HTTP API that reproduces the behaviour of the CargoDev
backend, so other clients (mobile apps, new staff screens) can use it without Next.js. The
existing system is a Next.js app whose business logic already lives in framework-free services
(apart from `SessionUser` and `ServiceError`). Treat those services as the specification.

## 1. Sources of truth (in the CargoDev source repo, not in this repo)

1. `prisma/schema.prisma`: the database. Reused unchanged. This repo only runs `prisma generate`.
2. The existing `/api/v1` contract (auth, envelope, error codes, endpoints, query params). The
   result lives in `docs/api-contract.md`.
3. `lib/services/*.ts`, `lib/validation/*.schema.ts`, `lib/shipment-status.ts`,
   `lib/vehicle-track.ts`, `lib/shipment-milestones.ts`, `lib/errors.ts`: ported nearly verbatim.

## 2. Stack

Node 20+ / TypeScript strict (no `any`), Fastify, Prisma 7 with `@prisma/adapter-pg`, zod 4,
`jose` (JWT), `bcryptjs`, `expo-server-sdk` (mobile push), the AWS SDK v3 client for Cloudflare R2 (`src/lib/r2-object-store.ts`), an in-process scheduler (no external cron). Vitest and supertest / `app.inject()` for
tests. Layering: `routes/` (thin) -> `services/` (all logic) -> Prisma.

## 3. What to port vs. what to build new

**Port** (copy the service, drop the Next imports): `vehicle`, `serial`, `lookup`, `customer`,
`user`, `file`, `notification`, `reminder`, `activity-log`, `dashboard`, `reports`,
`staff-auth`, `mobile-auth`, `device-token`, `organization` services; zod schemas; pure helpers
(`shipment-status`, `vehicle-track`, `shipment-milestones`).

Replace only these Next-specific bits:

- `SessionUser`: define locally as `{ id, role, orgId, name, email }`.
- `requireUser()` (redirects): becomes an auth hook that returns 401/403 JSON.
- `env.ORG_ID` single-org assumption: take `orgId` from the token everywhere. Only the login
  lookup and cron may use a default org (see section 6).
- `revalidatePath` calls: drop.

**Build new:** the existing `/api/v1` is almost entirely read-only. Mutations are Next Server
Actions today. The API must expose them as REST endpoints that call the same service functions
with the same role allow-lists (section 5).

## 4. HTTP contract

### 4.1 Envelope and errors (keep exactly)

- Success: `{ "data": <payload> }`. Error: `{ "error": { "code", "message", "fieldErrors?" } }`.
- Codes to HTTP: `VALIDATION` 400, `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404,
  `CONFLICT` 409, `INTERNAL` 500 (log it, never leak the message).
- Every response: `Cache-Control: no-store`. Dates are ISO 8601 strings. `Decimal` becomes a plain number.
- Services throw `ServiceError(code, message, fieldErrors?)`. One error handler maps it.
- A resource in another org returns 404, never 403.
- CORS: allow-list from `CORS_ALLOWED_ORIGINS` (comma-separated), echo the origin only if
  listed, never `*`, handle OPTIONS preflight.

### 4.2 Auth (staff only for now)

- `POST /api/v1/auth/login {email,password}` returns `{accessToken, accessTokenExpiresIn:1200,
  refreshToken, refreshTokenExpiresAt, user:{id,name,email,role,orgId}}`.
- `POST /api/v1/auth/refresh {refreshToken}` returns a new pair and revokes the old refresh
  token (rotation). Re-check `userType=STAFF` and `loginEnabled=true` from the DB on each refresh.
- `POST /api/v1/auth/logout {refreshToken}` returns `{loggedOut:true}` and is idempotent.
- Access token: HS256 JWT via `jose`, 20 minutes, `sub` = user id, claims `orgId, role, name,
  email`, signed with `MOBILE_JWT_SECRET`. Verified locally, no DB hit per request.
- Refresh token: opaque random value, 30 days, stored only as a sha256 hex hash in
  `RefreshToken.tokenHash`. Set `revokedAt` / `replacedByTokenId` on rotation. Revoke all of a
  user's refresh tokens on deactivation or password change.
- Credential check (`verifyStaffCredentials` in `staff-auth.service`): lowercase email,
  `userType STAFF`, `loginEnabled true`, bcrypt compare, 5 failures lock the account for 15
  minutes (`failedLoginAttempts`, `lockoutUntil`), returned as 403.
- Do NOT add customer login (out of scope, see section 8).

### 4.3 Read endpoints (specified in `docs/api-contract.md`; implement all)

Vehicles (`GET /vehicles`, `/vehicles/filter-options`, `/vehicles/destinations`,
`/vehicles/:serial`, `/:serial/status-history`, `/:serial/files`, `/:serial/pdf-images`),
customers (`/customers`, `/customers/search`, `/customers/:id`), all lookups (`/lookups/*`,
including freight-agent search with `method`, and row-colour-statuses), reports (4), dashboard
(`stats`, `trends`), notifications (list, unread-count, read one, read-all), device-tokens
(POST/DELETE), profile, staff (ADMINISTRATOR/MANAGER), organization, activity-log and its
filters (ADMINISTRATOR only).

Known doc drift to fix when porting: the old doc says the vehicle list `sort` defaults to
`serial`, but the code default is `purchaseDate desc`. Follow the code and update the doc.

### 4.4 Mutation endpoints to add (map 1:1 to existing services)

Suggested REST shape. Keep service signatures unchanged.

| Endpoint | Service | Roles |
|---|---|---|
| `POST /vehicles` | `createVehicle(user, body)` | ADMINISTRATOR, MANAGER |
| `PUT /vehicles/:id` (full replace, not a patch) | `updateVehicle(user, id, body)` | ADMINISTRATOR, MANAGER |
| `DELETE /vehicles/:id` (soft) | `deleteVehicle` | ADMINISTRATOR, MANAGER |
| `PATCH /vehicles/:id/row-colour` | `updateVehicleRowColourStatus` | ADMINISTRATOR, MANAGER, OPERATOR |
| `PATCH /vehicles/:id/auction-bill-paid` (`true`, `false` or `null`) | `updateVehicleAuctionBillPaid` | ADMINISTRATOR, MANAGER, OPERATOR |
| `POST /vehicles/:id/convert-to-export`, `revert-to-local`, `convert-to-local`, `revert-to-export` | `convertVehicleToExport` etc. | ADMINISTRATOR, MANAGER |
| `PATCH /vehicles/:id/serial` | `correctVehicleSerialNumber` | ADMINISTRATOR only |
| `POST /vehicles/:id/photos`, `/documents`, `PUT /vehicles/:id/auction-sheet` | `file.service` add/set | ADMINISTRATOR, MANAGER, OPERATOR |
| `DELETE /vehicles/:id/photos/:photoId`, `/documents/:docId` | `file.service` delete | check the source Server Action for the exact allow-list |
| `POST /uploads/presign` | object-storage presign (section 7) | ADMINISTRATOR, MANAGER, OPERATOR |
| `POST/PATCH /customers` | `createCustomerFull`, `updateCustomer` | ADMINISTRATOR, MANAGER |
| `POST/PATCH /staff`, `POST /staff/:id/active` | `user.service` | ADMINISTRATOR only |
| `PATCH /profile`, `POST /profile/password` | `updateOwnProfileDetails`, `changeOwnPassword` | any staff |
| lookup create / rename | `findOrCreate*`, `rename*` | check the source lookup actions for the allow-list |
| `POST /admin/jobs/daily-checks` | `runDailyVehicleChecks(orgId)` via the scheduler | ADMINISTRATOR only (normal bearer auth, logged). No shared-secret endpoint. |

Read the matching source Server Action files for the exact role arrays before wiring each
route. Do not infer them.

## 5. Non-negotiable rules

These repeat `CLAUDE.md`. See it for the full list.

1. Every query filters by `org_id`. `orgId` comes from the verified token, never from the request.
2. All business logic lives in services. Route handlers do only: auth, zod-parse, call service, shape response.
3. zod validation on every mutation, server side. Re-validate freight-agent RORO/Container capability, that a customer is `userType=CUSTOMER`, and so on, as the services already do.
4. Every mutation writes an `ActivityLog` row via `activityLog.record(tx, ...)` inside the same `prisma.$transaction`.
5. Lookup rows are created only through lookup services.
6. Tri-state flags (`auctionBillPaid`, `logBook`, `extraKey`) are `Boolean?`. `null` means not entered. Never coerce to `false`.
7. Role names are exactly `ADMINISTRATOR | MANAGER | OPERATOR | VIEWER`, enforced in the auth hook per route.
8. Serial is read-only after creation except `correctVehicleSerialNumber` (administrator). Counter rule: `lastNumber = max(lastNumber, entered)`.
9. Remarks: the current code uses one overwritable `Vehicle.vehicleRemark`. Keep it.

## 6. Behaviours that are easy to get wrong

- **FC vs FL:** use the effective track (`computeEffectiveTrack`, `buildTrackWhere` in `vehicle-track`), not `serialPrefix`. FL vehicles never store shipping fields (the service strips them) and shipment status is not tracked.
- **Shipment status:** stored values are `PENDING | BOOKING_RECEIVED | SHIPPED`. `CANCELLED` is computed only (row colour "Unit Canceled" or "Resold in Auction", FC only). Use the read-time guard `computeEffectiveShipmentStatus`, and `buildEffectiveShipmentStatusWhere` for list filters. Every stored transition writes a `StatusHistory` row (`ETD_SAVED`, `ETD_CLEARED`, `CRON_JOB`, `LEGACY_ENTRY`, `CONVERTED_TO_EXPORT`, ...). Cron transitions have `triggeredBy = null`.
- **Daily job:** runs inside this server (`DAILY_JOB_UTC_HOUR`, default 02:00 UTC), guarded by an in-process flag and a Postgres advisory lock. It does the shipped-transition first, then the payment, rikso, LC, ETD and missing-document reminders, de-duplicated per vehicle and event per day, for every org. It must be idempotent. A missed run is recovered on startup. See ADR 0003.
- **Serial generation:** transactional `SerialCounter` increment inside the vehicle-create transaction (`serial.service`).
- **Soft delete:** `Vehicle.deletedAt`. Every read path excludes deleted rows.
- **Notifications:** `emit(tx, params)` inside the transaction, then `notifyRealtime(params)` after commit (Expo push to the recipients' registered devices). Recipients are ADMINISTRATOR/MANAGER staff with `loginEnabled`, minus the actor. Do not wait on delivery; swallow and log failures. There is no Pusher in this API: clients read missed notifications through `GET /notifications` and `/notifications/unread-count`. A live in-app stream (SSE) is a possible later addition.
- **Org:** the single-org default (`ORG_ID`) is used only by login lookup and cron. Keep that for phase 1 but isolate it in one config module. Login should ideally resolve the org via the user row. Never hardcode an org id in code, tests or docs.

## 7. Files (object storage)

- Presign: validate with `presignRequestSchema`, check vehicle ownership, build the key with `buildObjectKey`, return `{uploadUrl, key, publicUrl}`. The presigned PUT lasts 300 s and signs `ContentLength`. Keys are namespaced per org and vehicle (`org/<orgId>/vehicles/<vehicleId>/{documents|photos|auction-sheet}/...`), with staging under `org/<orgId>/uploads/staging/`.
- The DB stores URLs only. Document types are the `VehicleDocumentType` enum. Accepted MIME types per type live in the document-type constants and `upload.schema`; keep them in sync.
- Presign must accept the Bearer token.
- Generate file URLs behind one function, so signed URLs can replace public ones later without touching callers.

## 8. Out of scope: do not build, only leave seams

- Customer accounts/login/portal, customer-visible documents, per-document visibility flags, signed download URLs.
- Public website API (stock listing, enquiries), chat/messages, email or WhatsApp.
- New price/category/"published" fields.

Raise anything that tempts you into these in an issue first.

## 9. Config (names only)

`DATABASE_URL`, `MOBILE_JWT_SECRET`, `ORG_ID`, `CORS_ALLOWED_ORIGINS`, `TRUST_PROXY_HOPS`,
`SSE_MAX_CONNECTIONS`, `DAILY_JOB_UTC_HOUR`, `SCHEDULER_ENABLED`,
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL`,
`LOG_LEVEL`, `EXPO_ACCESS_TOKEN` (optional). Validate at startup in `src/config/env.ts`. Never commit values. See `docs/env.md`.

## 10. Safety

- Never run database-changing commands against any shared or production database. They are allowed only against a local or CI throwaway Postgres container.
- The existing web app keeps running. This service must stay schema-compatible with it.

## 11. Testing (required)

- Vitest and supertest / `app.inject()`. Database tests use a throwaway Postgres only. See `docs/testing.md`.
- Per route: 401 without a token, 403 for each disallowed role, 404 for an id from another org (seed two orgs with fake data, call with an org A token on org B ids).
- Service tests: serial concurrency, legacy serial bump, ETD to status transitions plus `StatusHistory` rows, tri-state `null` preserved through update, FL strips shipping fields, FC freight-agent capability rejection, a staff id rejected as `customerId`, an `ActivityLog` row after each mutation.
- Contract test: response envelope and error codes match section 4.1.

## 12. Suggested order of work

1. Scaffold: env validation, Prisma client, error handler, envelope helpers.
2. Port `ServiceError`, auth (login/refresh/logout), auth hook with role allow-lists.
3. Port read services and all `GET` routes. Verify against `docs/api-contract.md`.
4. Add mutation routes (vehicles, files, customers, staff, profile).
5. Notifications fan-out (event bus, SSE stream, Expo push) and the in-process scheduler.
6. Presign with Bearer auth.
7. Tests (section 11), then compare responses against the running Next API for the same inputs.

Acceptance: for the same database and an equivalent user, every read endpoint returns the same
JSON as the Next app's `/api/v1`, and every mutation produces the same DB rows (vehicle,
StatusHistory, ActivityLog, Notification) as the corresponding Server Action.
