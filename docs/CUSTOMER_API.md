# Customer API contract (FTJ customer app)

Extracted from the code in `cargodev-api` on 2026-10-27 (branch `main`, commit `fed2350`). Every statement below is
backed by a file and line. Where `docs/api-contract.md` or an ADR says something different, the code wins and the
conflict is noted.

**Short version:** the customer zfone has **12 implemented endpoints**: auth (9), profile (2 on one path, GET and PATCH),
and a file gateway (2). Everything else the app needs (vehicles, timeline, documents list, stock, chat, alerts, devices,
FAQs, app config) is **NOT IMPLEMENTED**. Some of these already have database tables (Phase 2 slice 2 schema), but no
route or service reads them for customers.

---

## 1. Orientation

### 1.1 Framework and routing

- Node.js, TypeScript (strict, ESM), **Fastify 5**, zod 4, jose (JWT), Prisma 7 with `@prisma/adapter-pg`.
- Routes are registered as functions on Fastify plugin scopes in `src/app.ts`.
- **Base path for customer routes: `/api/customer/v1`** (`src/app.ts:177`). Not `/customer/v1`.
- Staff API: `/api/v1` (`src/app.ts:167`).
- The customer zone is **mounted only when `CUSTOMER_JWT_SECRET` is set** (`src/app.ts:171`). Without it every customer
  path returns `404 { error: { code: "NOT_FOUND", message: "Route not found." } }`.
- `GET /health` is at the root, outside both prefixes (`src/app.ts:148`).

### 1.2 OpenAPI / Swagger

**NOT IMPLEMENTED.** There is no `@fastify/swagger` (or any OpenAPI) dependency, no route schemas for generation, no
`/docs` or `/openapi.json`. So `docs/openapi.customer.json` was **not** produced. The hand-written contract is
`docs/api-contract.md` (section "Customer API").

### 1.3 Running locally

Env variable **names** (validated in `src/config/env.ts`, documented in `docs/env.md`, template in `.env.example`):

| Variable | Needed for the customer app | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Your own dev Postgres. Never shared or production. |
| `MOBILE_JWT_SECRET` | yes (always required) | 32+ chars. |
| `CUSTOMER_JWT_SECRET` | **yes** | 32+ chars, must differ from `MOBILE_JWT_SECRET` (startup fails if equal). Unset = customer zone not mounted. Also keys the OTP HMAC. |
| `ORG_ID` | yes | The org customers log into (there is no org header). |
| `CUSTOMER_SELF_SIGNUP` | no | `true` default. |
| `PORT` | no | Default **4000**. |
| `CORS_ALLOWED_ORIGINS` | only for Expo web | Native apps don't use CORS. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` | for photos/documents | All four or none. Without them the file endpoints return 500 `INTERNAL` for authorised files. |
| `R2_PUBLIC_URL` | for photos/documents | Stored file URLs are checked against it. |
| `CUSTOMER_FILE_CACHE_SECONDS` | no | Default 300. |
| `RESEND_API_KEY`, `EMAIL_FROM` | to receive codes | Without both, no email is sent and **the code is not logged** (only a masked address, `src/lib/email.ts:35`). |
| `TRUST_PROXY_HOPS`, `LOG_LEVEL`, `SSE_MAX_CONNECTIONS`, `DAILY_JOB_UTC_HOUR`, `SCHEDULER_ENABLED`, `EXPO_ACCESS_TOKEN`, `DIRECT_URL` | no | |

Commands:

```sh
npm install
cp .env.example .env      # fill in your own dev values; uncomment and set CUSTOMER_JWT_SECRET
npm run dev               # tsx watch --env-file=.env src/server.ts, listens on 0.0.0.0:4000
curl http://localhost:4000/health
```

- **No Docker for the API itself.** Docker is only used for the throwaway test database (`npm run db:test:up`).
- **No seed script and no test customer account.** `tests/helpers/customer-fixtures.ts` is test-only. To get a
  working customer locally you need either a Resend key (so the verification code arrives by email) or a customer row
  set up by hand in your dev database. See open questions.
- Doc drift: `README.md` lists `npm run build`; `package.json` has no `build` script.

### 1.4 Staging / production base URLs

**Not in config**, by project rule (no real hostnames in the repo). Ask the backend owner.

---

## 2. Global conventions

### 2.1 Auth

| Item | What the code does | Source |
|---|---|---|
| Login | `POST /auth/login { email, password }` | `src/routes/customer-auth.ts:70` |
| Access token | HS256 JWT, `aud: "customer"`, shared issuer, payload only `sub` (customer id) and `orgId` | `src/lib/customer-jwt.ts:28-37` |
| Where | `Authorization: Bearer <accessToken>` (case-insensitive `bearer`) | `src/plugins/customer-auth.ts:31-33` |
| Access lifetime | **15 minutes** (900 s), returned as `accessTokenExpiresIn` | `src/lib/customer-jwt.ts:11` |
| Refresh token | Opaque 32-byte base64url string, stored as sha256. **30 days** from issue/rotation, returned as `refreshTokenExpiresAt` (ISO) | `src/services/customer-auth.service.ts:36,66,206-223` |
| Rotation | **Yes, every refresh.** The old token is revoked atomically; the response carries a new one | `customer-auth.service.ts:257-300` |
| Reuse | Old token within 10 s of rotation: 403, nothing else happens (covers retries). Old token **after** 10 s: 403 **and every session of that customer is revoked** (theft) | `customer-auth.service.ts:264-270` |
| Concurrent refresh | Two parallel refreshes of the same token: one wins, the other gets 403 | `customer-auth.service.ts:280-290` |
| Account checked live | Every authenticated request re-reads the user. Disabled, deleted or unverified accounts get 401 immediately, not after 15 min | `src/plugins/customer-auth.ts:43-47` |
| Logout | `POST /auth/logout { refreshToken }`, **no access token needed**, revokes that one session, idempotent. The access token stays valid until it expires | `customer-auth.service.ts:302-306` |
| Revoke all | Happens on password reset, account delete, and refresh-token reuse. No endpoint for "sign out everywhere" | `customer-auth.service.ts:308-311` |
| Delete account | `POST /auth/delete-account { password }` (not `DELETE /me`) | `src/routes/customer-auth.ts:92` |
| Staff tokens | A staff token here is 401; a customer token on `/api/v1` is 401 (different secret and audience) | ADR 0005 |

**Client consequences:** refresh must be single-flight (one in-flight refresh shared by all requests), and a failed
refresh is **403**, not 401. Treat 403 from `/auth/refresh` as "signed out".

### 2.2 Error format

```json
{ "error": { "code": "VALIDATION", "message": "Please fix the highlighted fields.", "fieldErrors": { "email": "Enter a valid email address" } } }
```

- Your client reads `message`: it is at **`error.message`**, not at the top level (`src/lib/response.ts:11-13`).
- `fieldErrors` is optional, one message per field, keys are dot paths (`src/validation/shared.ts:6-15`). It can be
  present but empty (`{}`) for whole-body errors such as unknown keys or an empty PATCH.
- Success is always `{ "data": ... }`, including auth responses.

| HTTP | `code` | When (customer zone) |
|---|---|---|
| 400 | `VALIDATION` | Bad body/query, unknown body key (all schemas are strict), malformed JSON, oversized body, wrong content type, **wrong email/password at login**, wrong/expired OTP code, wrong password at delete |
| 401 | `UNAUTHENTICATED` | Missing, invalid or expired access token, or the account can no longer sign in |
| 403 | `FORBIDDEN` | Account locked (5 failures, 15 min), refresh token dead/expired/reused |
| 404 | `NOT_FOUND` | Unknown route; file not found or not yours/not released; account not found |
| 409 | `CONFLICT` | Not used by any customer route |
| 422 | — | **Never used** (validation is 400) |
| 429 | `RATE_LIMITED` | Per-IP or per-identifier limit; message `"Too many requests. Try again later."` |
| 500 | `INTERNAL` | Anything unexpected; message `"Something went wrong."`, details only in server logs |

Source: `src/lib/errors.ts:14-20`, `src/lib/error-handler.ts:9-31`.

### 2.3 Pagination

**No customer endpoint paginates** (none returns a list). For reference, the staff API uses `page` / `pageSize`
(default 50, max 100, `src/validation/pagination.schema.ts`) and returns
`{ data: { rows, total, page, pageSize, totalPages } }` (`src/services/vehicle.service.ts:1758-1764`).
**That is `rows`, not `items`.** If the customer list endpoints follow the staff convention, your `{ items }` client
will not match. Open question.

### 2.4 Dates, IDs, money

- **Dates:** ISO 8601 UTC strings from `Date.toISOString()`, e.g. `"2026-10-27T09:15:00.000Z"`
  (`customer-profile.service.ts:58`, `customer-auth.service.ts:220`). No date-only values in any implemented customer
  response. The DB stores `DateTime` (timestamp); staff filters use `YYYY-MM-DD`.
- **IDs:** Prisma `cuid()` strings, e.g. `"cm2x8k1p40000abcd1234efgh"` (`prisma/schema.prisma`). Always strings.
- **Money:** no implemented customer response contains money. The schema has `Vehicle.customerAmount`
  (`Decimal(14,2)`, nullable) + `customerAmountCurrency` (string, nullable), and `StockVehicle.priceFob`
  (`Decimal(14,2)`, nullable, **no currency column**). `docs/api-contract.md` says decimals are plain numbers on the
  staff API.

### 2.5 Enums a customer response can contain

Implemented responses contain only one enum-like field: `theme` = `"light" | "dark" | "system" | null`.

Enums in the schema that future customer endpoints will likely expose:

| Enum | Values | Source |
|---|---|---|
| `ShipmentStatus` (stored) | `PENDING`, `BOOKING_RECEIVED`, `SHIPPED` | `schema.prisma:27-31` |
| Effective status (computed) | the three above plus **`CANCELLED`** (display only, from row colour) | `src/lib/constants/shipment-status.ts` |
| `MilestoneType` | `BOUGHT`, `AUCTION_BILL_PAID`, `AT_EXPORT_YARD`, `EXPORT_CERT_ISSUED`, `BOOKING_RECEIVED`, `SHIPPED`, `BL_ISSUED`, `ARRIVED`, `DELIVERED` | `schema.prisma:795-805` |
| `VehicleDocumentType` | `LC`, `EC`, `ED`, `BL`, `INSPECTION_REPORT`, `SHAKEN_SHO`, `FREIGHT_INVOICE`, `PURCHASE_INVOICE`, `SALES_INVOICE`, `MEGI_HENKO`, `CASH_RECEIPT`, `OTHER` | `schema.prisma:42-55` |
| `ShippingMethod` | `RORO`, `CONTAINER` | `schema.prisma:34-37` |
| `LinkRequestStatus` | `PENDING`, `APPROVED`, `REJECTED` | `schema.prisma:827-831` |
| `MessageSender` | `CUSTOMER`, `STAFF` | `schema.prisma:876-879` |
| `StockStatus` | `DRAFT`, `PUBLISHED`, `SOLD` | `schema.prisma:949-953` |

There is **no** `DELIVERED`, `ARRIVED` etc. in `ShipmentStatus`; those exist only as milestones.

### 2.6 Nullability

Implemented DTOs list every key explicitly and **always include it**; absent values are `null`, never omitted
(`customer-profile.service.ts:47-60`). Exception: `language` is never null (defaults to `"en"`).

### 2.7 Rate limits, CORS, headers

- Global: 300 requests/min per IP (`src/app.ts:63`), plus the per-route limits below.
- Per-identifier limits key on the normalised email (or customer id) and count unknown addresses too. When hit, the
  response is 429 with `Retry-After` (seconds) (`src/routes/customer-auth.ts:43-50`). Per-IP limits come from
  `@fastify/rate-limit`, which also sends its own rate-limit headers.

| Endpoint | Per IP | Per email / customer |
|---|---|---|
| register | 5/min | 3/hour |
| verify-email | 10/min | 10/10 min |
| resend-verification | 5/min | 3/10 min |
| login | 10/min | 20/15 min |
| refresh | 30/min | — |
| logout | 30/min | — |
| forgot-password | 5/min | 3/hour |
| reset-password | 10/min | 10/10 min |
| delete-account | 5/min | 5/hour (per customer) |
| GET/PATCH /me | 60/min | — |
| photo/document files | 300/min | 120/min (per customer) |

Source: `src/config/customer-rate-limits.ts:19-32`.

- **IP behind a proxy:** with `TRUST_PROXY_HOPS=0` (default) all traffic through a proxy shares one IP bucket. Worth
  checking for production (10 logins/min per IP is tight if a proxy hides client IPs).
- **CORS:** allow-list from `CORS_ALLOWED_ORIGINS`, never `*`; allowed request headers are **only `Authorization` and
  `Content-Type`** (`src/app.ts:134-139`). Irrelevant for native iOS/Android, but on Expo web any custom header
  (`X-App-Version`, `X-Platform`) would fail preflight.
- **Required headers:** none besides `Authorization` (protected routes) and `Content-Type: application/json` (bodies).
  No app-version, platform or org header is read. `User-Agent` is optional and stored (first 300 chars) on the session.
- `Cache-Control: no-store` on every response except the two file endpoints (`src/app.ts:95-97`). Helmet security
  headers are on.

### 2.8 Multi-tenancy

- Before a token exists (register, login, forgot, ...): the org is the server's `ORG_ID` env var
  (`src/config/default-org.ts`). The client cannot choose it.
- After login: `orgId` is a claim in the verified access token (`src/lib/customer-jwt.ts:29`). No header. Any `orgId`
  in a body is rejected (strict schemas).

### 2.9 Files

- **Not R2 URLs and not signed URLs.** The app fetches bytes from the API by database id, with the Bearer token:
  `GET /photos/:photoId/image` and `GET /documents/:documentId/file` (ADR 0006). The client never sees a storage URL,
  key or signed link.
- So `<Image>` must send the `Authorization` header (e.g. `expo-image` `source={{ uri, headers }}`). A plain
  `thumbnailUrl` that works without auth does not exist.
- Responses can be cached privately for `CUSTOMER_FILE_CACHE_SECONDS` (default 300) and support `ETag` /
  `If-None-Match` → 304.
- **Gap:** no customer endpoint returns photo or document ids yet, so the app has no way to discover what to request.

### 2.10 Realtime / push

- **Customer device-token registration: NOT IMPLEMENTED.** `POST/DELETE /device-tokens` exist only under the **staff**
  guard at `/api/v1` (`src/routes/notifications.ts:102-111`); a customer token gets 401 there. The `DeviceToken` table
  has an `appVersion` column for the customer app, but no endpoint writes it.
- Push payload shape for customers: NOT IMPLEMENTED (staff push goes through `src/lib/expo-push.ts`).
- SSE (`GET /api/v1/notifications/stream`) is staff-only. No websocket. No customer realtime channel.

### 2.11 Minimum app version / app config

**NOT IMPLEMENTED.** Only `GET /health`.

---

## 3. Endpoint reference

All paths below are relative to **`/api/customer/v1`** unless shown absolute. All bodies are JSON and **strict**:
an unknown key is `400 VALIDATION`.

### Area 1: Auth

#### POST /auth/register

Source: `src/routes/customer-auth.ts:55`, service `src/services/customer-auth.service.ts:120`
Auth: none
Purpose: create an unverified, passwordless customer and email a 6-digit code. (The app is sign-in only; listed for completeness.)

Request:
```json
{ "name": "Amal Perera", "email": "amal@example.test", "phone": "+94 77 000 0000", "companyName": null, "country": "Sri Lanka" }
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| name | string | yes | trimmed, 1-150 |
| email | string | yes | trimmed, lowercased, valid email, max 150 |
| phone | string \| null | no | trimmed, max 30; empty becomes null |
| companyName | string \| null | no | max 150; empty becomes null |
| country | string \| null | no | max 100; empty becomes null |

Response **202**: `{ "data": { "accepted": true } }` for every address (new, existing, staff, deleted), and also when
`CUSTOMER_SELF_SIGNUP=false` (then nothing is created).
Errors: 400 bad body; 429.
Business rules: same answer and a 250 ms minimum response time for every branch (`src/lib/min-duration.ts`). An
existing verified customer gets an "already registered" email instead of a code.
Status: **IMPLEMENTED**

#### POST /auth/verify-email

Source: `src/routes/customer-auth.ts:60`, service `customer-auth.service.ts:170`
Auth: none
Purpose: submit the emailed code **and** choose the password.

Request: `{ "email": "amal@example.test", "code": "123456", "password": "a-long-passphrase" }`

| Field | Type | Required | Constraints |
|---|---|---|---|
| email | string | yes | as above |
| code | string | yes | exactly 6 digits |
| password | string | yes | 12 chars min, 72 **bytes** max |

Response **200**: `{ "data": { "verified": true } }`. Does **not** log in; call `/auth/login` next.
Errors: 400 `"That code is invalid or has expired."` for every failure (unknown email, wrong code, expired, 5 attempts used, already verified); 429.
Business rules: code valid 10 min, single use, 5 attempts. With self-signup on, verifying enables login.
Status: **IMPLEMENTED**

#### POST /auth/resend-verification

Source: `src/routes/customer-auth.ts:65`, service `customer-auth.service.ts:154`
Auth: none · Body: `{ "email": "..." }` · Response **202** `{ "data": { "accepted": true } }` always.
Business rules: a new code retires the old one. 250 ms response floor.
Status: **IMPLEMENTED**

#### POST /auth/login

Source: `src/routes/customer-auth.ts:70`, service `customer-auth.service.ts:225`
Auth: none
Purpose: exchange email + password for a session.

Request: `{ "email": "amal@example.test", "password": "a-long-passphrase" }`

| Field | Type | Required | Constraints |
|---|---|---|---|
| email | string | yes | trimmed, lowercased, valid email, max 150 |
| password | string | yes | 1-1000 chars (no strength rule at login) |

Response **200**:
```json
{
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiJ9...",
    "accessTokenExpiresIn": 900,
    "refreshToken": "q3Jx0f8kP2...base64url",
    "refreshTokenExpiresAt": "2026-11-26T09:15:00.000Z",
    "user": { "id": "cm2x8k1p40000abcd1234efgh", "name": "Amal Perera", "email": "amal@example.test" }
  }
}
```

| Field | Type | Nullable | Notes |
|---|---|---|---|
| accessToken | string | no | JWT, 15 min |
| accessTokenExpiresIn | number | no | seconds, always 900 |
| refreshToken | string | no | opaque, store securely |
| refreshTokenExpiresAt | string (ISO) | no | 30 days |
| user.id | string (cuid) | no | |
| user.name | string | no | |
| user.email | string | **yes** (type allows it; a signed-in account always has one in practice) | |

Errors:
- 400 `{ "error": { "code": "VALIDATION", "message": "Invalid email or password." } }`: wrong password, unknown email, unverified, disabled, deleted, or staff account (all identical). **Not 401.**
- 400 `"Please check your email and password."` with `fieldErrors`: malformed body.
- 403 `FORBIDDEN` `"This account is temporarily locked after repeated failed sign-in attempts. Try again in a few minutes."`: 5 failures, 15 min.
- 429.

Business rules: unknown addresses also lock after 5 failures (in memory), so lockout reveals nothing.
Status: **IMPLEMENTED**

#### POST /auth/refresh

Source: `src/routes/customer-auth.ts:75`, service `customer-auth.service.ts:257`
Auth: none (the refresh token is the credential)
Request: `{ "refreshToken": "q3Jx0f8kP2..." }` (string, 1-200)
Response **200**: same session shape as login, with a **new** `refreshToken`. The old one is dead.
Errors: 400 missing token (`"A refresh token is required."`); **403** `"Session expired. Please sign in again."` for unknown, expired, revoked, reused or concurrently-rotated tokens, or an account that can no longer sign in; 429.
Business rules: see 2.1 (rotation, 10 s reuse grace, revoke-all on theft).
Status: **IMPLEMENTED**

#### POST /auth/logout

Source: `src/routes/customer-auth.ts:77`, service `customer-auth.service.ts:302`
Auth: none
Request: `{ "refreshToken": "q3Jx0f8kP2..." }` (**required**)
Response **200**: `{ "data": { "loggedOut": true } }` (not 204). Idempotent: unknown or already revoked tokens also 200.
Errors: 400 missing/invalid body; 429.
Status: **IMPLEMENTED**

#### POST /auth/forgot-password

Source: `src/routes/customer-auth.ts:82`, service `customer-auth.service.ts:316`
Auth: none · Body: `{ "email": "..." }` · Response **202** `{ "data": { "accepted": true } }` always.
Business rules: a reset code is sent only to a non-deleted customer with `loginEnabled`. This is also how a
staff-created customer (no password yet) gets in. 250 ms response floor.
Status: **IMPLEMENTED**

#### POST /auth/reset-password

Source: `src/routes/customer-auth.ts:87`, service `customer-auth.service.ts:330`
Auth: none
Request: `{ "email": "amal@example.test", "code": "123456", "newPassword": "another-long-passphrase" }` (code 6 digits; newPassword 12 chars to 72 bytes)
Response **200**: `{ "data": { "reset": true } }`.
Errors: 400 `"That code is invalid or has expired."` for every failure; 429.
Business rules: clears lockout, marks the email verified, **revokes every session**.
Status: **IMPLEMENTED**

#### POST /auth/delete-account

Source: `src/routes/customer-auth.ts:92`, service `customer-auth.service.ts:360`
Auth: **required**
Request: `{ "password": "a-long-passphrase" }`
Response **200**: `{ "data": { "deleted": true } }`.
Errors:
- 400 `{ "error": { "code": "VALIDATION", "message": "Incorrect password.", "fieldErrors": { "password": "Incorrect password." } } }` (counts toward lockout)
- 401 bad token; 403 locked; 404 `"Account not found."`; 429 (5/hour per customer).

Business rules: anonymises the user (name `"Deleted customer"`, all personal fields null), revokes all sessions,
deletes OTP codes and device tokens. Vehicles and messages stay. The current access token stops working at once.
Status: **IMPLEMENTED**

#### Register-only extras

None beyond the above. Phone login: **NOT IMPLEMENTED** (`OtpPurpose.PHONE_LOGIN` is reserved).

### Area 2: Me / profile

#### GET /me

Source: `src/routes/customer-auth.ts:98`, service `src/services/customer-profile.service.ts:62`
Auth: required

Response **200**:
```json
{
  "data": {
    "id": "cm2x8k1p40000abcd1234efgh",
    "name": "Amal Perera",
    "email": "amal@example.test",
    "phone": "+94 77 000 0000",
    "companyName": null,
    "country": "Sri Lanka",
    "destinationPort": "Colombo",
    "language": "en",
    "theme": null,
    "memberSince": "2026-10-25T14:02:11.000Z"
  }
}
```

| Field | Type | Nullable | Notes |
|---|---|---|---|
| id | string | no | cuid |
| name | string | no | |
| email | string | yes | |
| phone | string | yes | |
| companyName | string | yes | |
| country | string | yes | |
| destinationPort | string | yes | |
| language | string | no | `"en"` when unset |
| theme | `"light" \| "dark" \| "system"` | yes | |
| memberSince | string (ISO) | no | account `createdAt` |

Exactly these keys (tested in `tests/customer-zone.test.ts`).
Errors: 401; 404 `"Account not found."` (not reachable in practice, the guard already checks the account); 429.
Status: **IMPLEMENTED**

#### PATCH /me

Source: `src/routes/customer-auth.ts:99`, service `customer-profile.service.ts:71`
Auth: required
Request: at least one of:

| Field | Type | Constraints | Can clear with null |
|---|---|---|---|
| name | string | 1-150 | no |
| phone | string \| null | max 30 | yes |
| companyName | string \| null | max 150 | yes |
| country | string \| null | max 100 | yes |
| destinationPort | string \| null | max 100 | yes |
| language | string | `^[a-z]{2}(-[A-Z]{2})?$` | no |
| theme | `"light" \| "dark" \| "system"` | | no (once set it cannot go back to null) |

`email` cannot be changed (strict schema rejects it).
Response **200**: the full profile, same shape as GET.
Errors: 400 (empty body gives `"Please fix the highlighted fields."` with `fieldErrors: {}`); 401; 404; 429.
Business rules: writes an ActivityLog row with field names only.
Status: **IMPLEMENTED**

#### Notification preferences

**NOT IMPLEMENTED.** Table `NotificationPreference` exists (`schema.prisma:856`: `events` JSON map, `departureLeadDays`
3/7/14, `pushEnabled`, `emailEnabled`, `whatsappEnabled`), no route.

### Area 3: Home

`GET /home` or any dashboard feed: **NOT IMPLEMENTED.** (`/api/v1/dashboard` is staff-only.)

### Area 4: My vehicles

List, detail, timeline and photo listing: **NOT IMPLEMENTED.**

What the code already decides (from `src/services/customer-file-access.service.ts:36-43`) about which vehicles a
customer may see, which any future endpoint should reuse:

- `customerId` = the signed-in customer, same `org_id`, `deletedAt` null,
- `customerVisible = true` (default **false**: staff must release each vehicle),
- effective track is **FC** (`computeEffectiveTrack`, so an FC vehicle converted to local is hidden and an FL vehicle
  converted to export is shown).

Fields that exist on `Vehicle` and would map to the app's model (these are DB columns, not a DTO):

| App field | Where it lives | Note |
|---|---|---|
| make | `model.brand.name` (relation `VehicleModelRef` → `Brand`) | not a column on Vehicle; can be null (model is optional) |
| model | `model.name` | nullable |
| year | `yom` (Int?) | name differs |
| chassisNo | `chassisNo` (String?) | |
| status | `shipmentStatus` + computed `CANCELLED` | only `PENDING`, `BOOKING_RECEIVED`, `SHIPPED`, `CANCELLED` |
| etd / eta | `etd`, `eta` (DateTime?) | |
| thumbnailUrl | none | photos are served by id via the gateway (2.9) |
| — | `serial`, `vesselName`, `blNo`, `portOfLoading`, `portOfDischarge`, `voyageNo`, `containerNumber`, `customerAmount`, `customerAmountCurrency` | candidates for a detail DTO |

**Timeline.** The schema has **9** milestone types, not 7 (`MilestoneType`, one `VehicleMilestone` row per vehicle and
type with `occurredAt`). Mapping to the app's 7 steps:

| App step | MilestoneType | How it gets recorded today |
|---|---|---|
| Purchased | `BOUGHT` | staff (`PUT /api/v1/vehicles/:id/milestones/:type`) or backfill |
| — | `AUCTION_BILL_PAID` | staff or backfill (not in the app's list) |
| — | `AT_EXPORT_YARD` | staff or backfill (not in the app's list) |
| EC issued | `EXPORT_CERT_ISSUED` | staff or backfill |
| Booking received | `BOOKING_RECEIVED` | **automatic** when ETD is saved, same transaction (`milestone.service.ts`) |
| Shipped | `SHIPPED` | **automatic** when the daily job moves the status past ETD |
| BL issued | `BL_ISSUED` | staff or backfill |
| Arrived | `ARRIVED` | staff or backfill |
| Delivered | `DELIVERED` | staff or backfill |

When the status goes down (ETD cleared, shipped reverted), only untouched automatic `BOOKING_RECEIVED` / `SHIPPED`
milestones are removed (ADR 0006 §9). The staff read is `GET /api/v1/vehicles/:serial/milestones`
(`src/routes/milestones.ts:13`); no customer read exists.

Note: `src/lib/shipment-milestones.ts` is a **different**, staff-only derived timeline (Auction Bill Paid, Transport
Assigned, EC Received, Inspection, LC Open, Booking, Loaded, Shipped, Delivered) computed from vehicle fields. Do not
confuse it with `VehicleMilestone`.

#### GET /photos/:photoId/image

Source: `src/routes/customer-files.ts:55`, service `src/services/customer-file-access.service.ts:55,108`
Auth: required
Purpose: the bytes of one released photo of one of the customer's visible vehicles.
Path params: `photoId` (string, `^[A-Za-z0-9_-]{1,64}$`, otherwise 404).
Query params: `size` = `thumb` | `full` (default `full`). Any other query key is 400 (strict).
Request headers: optional `If-None-Match: "<etag>"`.
Response **200**: raw image bytes (not JSON). Headers: `Content-Type` (`image/jpeg`, `image/png` or `image/webp`),
`Content-Length` (when known), `Content-Disposition: inline`, `ETag`, `Cache-Control: private, max-age=300`,
`Vary: Authorization`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`.
Response **304**: empty body when the ETag matches.
Errors: 401; 404 `{ "error": { "code": "NOT_FOUND", "message": "File not found." } }` for every failure (not found,
not released, not yours, other org, vehicle hidden or FL, bad id, object missing); 400 bad query; 429 with
`Retry-After`; 500 `INTERNAL` if storage is not configured.
Business rules: `size=thumb` falls back to the full image when no thumbnail exists. Photos are private by default
(`visibleToCustomer=false`).
Status: **IMPLEMENTED** (but no endpoint yet tells the app which `photoId`s exist)

### Area 5: Vehicle documents

List per vehicle: **NOT IMPLEMENTED.** Signed-URL endpoint: **NOT IMPLEMENTED by design** (ADR 0006 rejects signed
links for customers). The download endpoint exists:

#### GET /documents/:documentId/file

Source: `src/routes/customer-files.ts:60`, service `customer-file-access.service.ts:55,108`
Auth: required
Path params: `documentId` (same id rule as photos). Query: **none allowed** (any key is 400).
Response **200**: raw bytes. `Content-Type`: `application/pdf` or an image type. `Content-Disposition: attachment;
filename="<staff-entered name>.pdf"; filename*=UTF-8''...` (images get `inline`). Other headers and the 304 path as
for photos.
Errors: same as photos.
Business rules: only `visibleToCustomer = true` documents on a visible FC vehicle of this customer.
Status: **IMPLEMENTED** (but no endpoint yet lists `documentId`s or their `documentType` / `name`)

### Area 6: Purchase history

**NOT IMPLEMENTED.**

### Area 7: Link-a-vehicle requests

Create and list: **NOT IMPLEMENTED.** Table `VehicleLinkRequest` exists (`schema.prisma:835`: `serialEntered`,
`status` PENDING/APPROVED/REJECTED, `vehicleId` set on approval, `decidedById`, `decidedAt`). The schema comment says
the serial is stored as typed and not resolved, so a request never confirms or denies a vehicle exists. The
"always 202" behaviour is intent only; no code enforces it yet.

### Area 8: Stock

**NOT IMPLEMENTED**, and the data model differs from the app's assumption:

- There is **no** `showInApp` or `showPriceInApp` field anywhere in the schema. Stock is **not** "FL vehicles with no
  customer". It is a separate curated table, `StockVehicle` (`schema.prisma:957`), described as "curated stock for the
  public website... NOT the vehicle ledger", addressed by `slug`, with `make`, `model`, `year`, `priceFob`
  (no currency column), `mileageKm`, `bodyType`, `fuel`, `transmission`, `colour`, `description`, `status`
  (DRAFT/PUBLISHED/SOLD), `publishedAt`, and `StockImage` rows (public bucket keys).
- ADR 0006 §8 says public stock images go in a separate public bucket behind `PUBLIC_STOCK_ENABLED`. That env var
  does not exist in `src/config/env.ts`.
- So whether the price is omitted cannot be confirmed: nothing serves stock.

### Area 9: Conversations & messages

**NOT IMPLEMENTED.** Tables `Conversation` (`customerId`, optional `vehicleId`, `lastMessageAt`, `handledAt`,
`handledById`) and `Message` (`senderType` CUSTOMER/STAFF, `senderId`, `body` plain text) exist
(`schema.prisma:881-915`). Compared with the app's plan, the schema has:

- **no conversation type** (GENERAL, VEHICLE_QUESTION, PRICE_REQUEST, RESERVATION),
- **no `isInternalNote`** on messages,
- **no read receipts or read state** (no `readAt` / last-read column), so no unread count either,
- no link from a conversation to stock.

### Area 10: Alerts / notifications

**NOT IMPLEMENTED for customers.** `/api/v1/notifications*` (list, unread count, mark read, SSE stream) is staff-only.
The `Notification` table is per `userId` and could hold customer rows, but no customer route reads it.

### Area 11: Devices and presence

- Device push token: **NOT IMPLEMENTED for customers** (staff-only `POST/DELETE /api/v1/device-tokens`, body
  `{ expoPushToken, platform: "ios" | "android" }`, `src/validation/device-token.schema.ts`).
- Presence heartbeat: **NOT IMPLEMENTED.** `User.lastActiveAt` is only updated on successful login.

### Area 12: Help / FAQs

**NOT IMPLEMENTED.** Table `Faq` exists (`question`, `answer`, `sortOrder`, `published`).

### Area 13: App config, minimum version, health

- App config / minimum version: **NOT IMPLEMENTED.**

#### GET /health (absolute path, no prefix)

Source: `src/app.ts:148`
Auth: none · Response **200** `{ "data": { "status": "ok" } }` · Does not check the database.
Status: **IMPLEMENTED**

---

## 4. Security checks (what the code does)

**Scoping (IDOR).** Every implemented authenticated endpoint is scoped by customer id **and** org from the verified
token:

| Endpoint | Scope | Source |
|---|---|---|
| Guard (all protected routes) | `user.findFirst({ id: sub, org_id: orgId })` + `canCustomerLogin` | `src/plugins/customer-auth.ts:43-47` |
| GET/PATCH /me | `id`, `org_id`, `userType: CUSTOMER`, `deletedAt: null` | `customer-profile.service.ts:63-66,76-79` |
| delete-account | same | `customer-auth.service.ts:363-366` |
| photo / document file | file looked up by id + `visibleToCustomer`, then the vehicle must match `customerId`, `org_id`, not deleted, `customerVisible`, effective FC; the stored URL must sit inside the caller's org folder | `customer-file-access.service.ts:36-75` |
| refresh / logout | by sha256 of the 32-byte random token (the token is the credential) | `customer-auth.service.ts:260,305` |

No IDOR found in the implemented routes. Cross-customer and cross-org cases are tested with `IDOR_WORLD`
(`tests/helpers/customer-fixtures.ts`, `docs/testing.md`).

**DTO exposure.** Implemented customer responses are built field by field: the session `user` is `{ id, name, email }`
and the profile is the 10 keys above. They contain no price, auction hall, bill-paid, costs, remarks, activity log,
messages or link-request data. File responses carry no storage URL, key or host. The other items on the checklist
(internal notes, staff match info on link requests) have **no customer endpoint to check**.

**Link request parity.** Not checkable: not implemented. The schema is designed for it (serial stored unresolved).

**Enumeration.** register, resend, forgot, verify, reset and login answer the same way for any address, with matched
bcrypt work, a 250 ms floor on the "accepted" endpoints, and per-email limits that count unknown addresses.

---

## 5. Compared with what the app currently assumes

| App assumption | Reality | Mismatch |
|---|---|---|
| Base path `/customer/v1` | `/api/customer/v1` | **path** |
| Responses are the bare payload | Every success is `{ data: ... }` | **envelope** |
| Errors have top-level `message` | `{ error: { code, message, fieldErrors? } }` | **field path** |
| `POST /auth/login {email,password} -> {accessToken, refreshToken}` | Same input. Output in `data`, plus `accessTokenExpiresIn`, `refreshTokenExpiresAt`, `user` | envelope only (extra fields are additive) |
| Login failure = 401 | **400** `VALIDATION`; locked = **403** | status codes |
| `POST /auth/refresh {refreshToken} -> {accessToken, refreshToken}` | Same, in `data`, plus extras. Refresh **rotates**; failure is **403** | envelope, status; must single-flight |
| `POST /auth/logout -> 204` | **200** `{ data: { loggedOut: true } }`, **body `{ refreshToken }` required**, no auth header needed | status, body |
| `GET /me -> { id, name, email\|null, companyName\|null }` | All four present with that nullability, plus `phone`, `country`, `destinationPort`, `language`, `theme`, `memberSince`; in `data` | envelope only |
| `GET /vehicles` | Not implemented | **missing** |
| vehicle `make`, `model` (non-null) | From `Brand`/`VehicleModelRef` relations, both optional in the DB | **nullability**: should be `string \| null` |
| vehicle `year` | Column is `yom` | name (DTO not yet defined) |
| vehicle `status: "PENDING" \| "BOOKING_RECEIVED" \| "SHIPPED" \| ...` | Exactly `PENDING`, `BOOKING_RECEIVED`, `SHIPPED`, `CANCELLED`. No ARRIVED/DELIVERED status (those are milestones) | enum |
| `thumbnailUrl: string \| null` | No URLs. Photos via `GET /photos/:photoId/image?size=thumb` **with Bearer header** | **concept** |
| lists as `{ items: [...] }` | No customer lists. Staff lists use `{ rows, total, page, pageSize, totalPages }` | **likely shape** |
| `GET /stock` from FL vehicles + `showInApp` | Not implemented. Separate `StockVehicle` table; no `showInApp` / `showPriceInApp` | **missing / model** |
| `price: { amount: number, currency: string }` | `priceFob` decimal only, **no currency column** | **missing field** |

---

## 6. Gap list

| Feature the app needs | Endpoint | Status | Notes |
|---|---|---|---|
| Sign in | `POST /auth/login` | ready | 400 on bad credentials, 403 locked |
| Keep session | `POST /auth/refresh` | ready | rotates; 403 on failure |
| Sign out | `POST /auth/logout` | ready | needs `{ refreshToken }`; 200 not 204 |
| Forgot / reset password | `POST /auth/forgot-password`, `/auth/reset-password` | ready | 6-digit code by email |
| Delete account | `POST /auth/delete-account` | ready | requires password |
| Register / verify (website flow) | `POST /auth/register`, `/auth/verify-email`, `/auth/resend-verification` | ready | |
| Profile | `GET /me`, `PATCH /me` | ready | |
| Notification preferences | — | missing | table exists |
| Home dashboard | — | missing | |
| My vehicles list / detail | — | missing | visibility rule exists in `findCustomerVehicle` |
| Vehicle timeline | — | missing | `VehicleMilestone` table + automation exist; 9 types not 7 |
| Vehicle photos | `GET /photos/:photoId/image` | partial | bytes ready; no way to list photo ids |
| Vehicle documents | `GET /documents/:documentId/file` | partial | bytes ready; no list endpoint; no signed URLs by design |
| Purchase history | — | missing | |
| Link-a-vehicle | — | missing | table exists |
| Stock | — | missing | different data model; no price currency; no show flags |
| Conversations / messages | — | missing | tables lack type, internal-note and read-state columns |
| Alerts | — | missing | staff-only today |
| Push device token | — | missing | staff-only `/api/v1/device-tokens` |
| Presence heartbeat | — | missing | |
| FAQs | — | missing | table exists |
| Min version / app config | — | missing | |
| Health | `GET /health` | ready | root path, no DB check |

### Open questions for the backend owner

1. **List envelope:** will customer lists use `{ items }` or the staff `{ rows, total, page, pageSize, totalPages }`?
   Cursor or page/pageSize?
2. **Stock source:** is app stock the curated `StockVehicle` table (website stock) or FL vehicles with a "show in
   app" flag? If the latter, `showInApp` / `showPriceInApp` need a schema change (owned by the CargoDev repo).
3. **Stock price currency:** `priceFob` has no currency column. Is it always one currency?
4. **Chat model:** conversation types, internal notes and read receipts need columns that don't exist. Planned?
5. **Timeline:** should the app show all 9 milestone types or a 7-step subset? Should pending steps come from the API
   (with `occurredAt: null`) or does the app fill them in?
6. **Vehicle DTO:** which fields go in list vs detail? Is `customerAmount` shown, and only when not null?
7. **Photo/document discovery:** will vehicle detail include `photos: [{ id }]` and
   `documents: [{ id, name, documentType, createdAt }]`?
8. **Customer push:** a customer `/device-tokens` route (with `appVersion`), and the push payload shape (`data.type`,
   `vehicleId`, ...)?
9. **Realtime chat:** SSE (like staff), polling, or push only?
10. **Min-version / config endpoint:** wanted? Then the app could send an app-version header, but CORS currently allows
    only `Authorization` and `Content-Type` (matters for Expo web only).
11. **Local test account:** can we have a dev seed for a verified customer, or a dev-only way to see OTP codes when
    `RESEND_API_KEY` is unset?
12. **Staging / production base URLs** and whether `TRUST_PROXY_HOPS` is set there (per-IP auth limits are tight if
    every client shares the proxy's IP).
13. **`/auth/*` login limit** of 10/min per IP: fine for carrier-grade NAT on mobile networks?
