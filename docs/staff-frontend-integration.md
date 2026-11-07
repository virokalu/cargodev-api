# Staff frontend integration contract

**Contract version:** 1.9.0 (2026-11-07). Staff zone: everything under `/api/v1`, plus the signed file links under `/f/v1`.
**Written for:** a frontend developer who has never seen this repository and is building the staff web app (Next.js) or the iOS staff app against this API.
**Source of truth:** the code. This file is checked against the running routes by `tests/staff-frontend-contract.test.ts`: every JSON example below (a fenced block marked `example:<id>`) is compared, key for key, with what the real route returns for fake data, and every `/api/v1` route must appear here with the roles the code allows. If the test fails, this file or the code is wrong. `docs/api-contract.md` is the shorter reference for all zones; this file is the complete staff contract.

All values in examples are fake. `https://api.example.test` stands for the API's own address, which the operator gives you (it is not written in this repository).

## Contents

1. Conventions
2. Staff authentication lifecycle
3. Role matrix
4. Domain model the UI must respect
5. Endpoints, by screen area
6. Files: viewing and uploading
7. Live updates
8. Differences from the old app, and what is not built
9. Operational facts
10. Changes and versioning
11. Facts checked against the code

---

## 1. Conventions

**Base address.** `https://api.example.test` (placeholder). Every path below starts with `/api/v1` unless stated.

**Envelope.** Success: `{ "data": <payload> }`. Error: `{ "error": { "code", "message", "fieldErrors"? } }`. `fieldErrors` is an object of `field name -> one message`, present on validation problems and some conflicts. `message` is safe to show to a person; do not parse it, use `code` and the HTTP status. **`fieldErrors` values are always one string per field, never an array** (the same shape as the original mobile contract). A `409 CONFLICT` **may** carry an optional `reason` string, a stable machine-readable cause, on a `409` only (since 1.6.0). **No `reason` is returned today** (the two serial reasons of 1.6.0 were removed in 1.8.0); treat it as reserved, ignore it if you meet one, and use `code`, the HTTP status and `fieldErrors`. Every other error is exactly `{ code, message, fieldErrors? }`.

| `code` | HTTP | Meaning for the UI |
|---|---|---|
| `VALIDATION` | 400 | The request was wrong. Show `fieldErrors` next to the fields. Also used for a wrong password and for malformed or oversized JSON (message `Invalid request.`) |
| `UNAUTHENTICATED` | 401 | No usable token, an expired token, or the account is no longer allowed in (deactivated, removed). Refresh once, then sign in again |
| `FORBIDDEN` | 403 | The role may not do this, or the account is locked, or a refresh token is no good (see section 2) |
| `NOT_FOUND` | 404 | No such thing, **or it belongs to another organisation** (never 403 for that), or the route does not exist (message `Route not found.`) |
| `CONFLICT` | 409 | A concurrent or duplicate change (serial taken, a decision already made, a duplicate email or name). Reload and retry. May carry a `reason` (reserved; none is returned today). Where a field is to blame the body carries `fieldErrors` keyed by that field (see below) |
| `RATE_LIMITED` | 429 | Too many requests. Wait `Retry-After` seconds |
| `INTERNAL` | 500 | A bug or an outage. The message is always `Something went wrong.`; details are only in the server log |

`UNAUTHENTICATED` is produced only by the token check, `RATE_LIMITED` only by the rate limiter. Every error body has exactly the shape above.

Example (401):

```json example:errors.401 401
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "Missing bearer token."
  }
}
```
Example (403):

```json example:errors.403 403
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You don't have permission to access this resource."
  }
}
```
Example (404):

```json example:errors.404 404
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Vehicle not found."
  }
}
```
Example (404):

```json example:errors.404.route 404
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Route not found."
  }
}
```
Example (409):

```json example:errors.409 409
{
  "error": {
    "code": "CONFLICT",
    "message": "Serial FC102 already exists.",
    "fieldErrors": {
      "serialNumber": "Serial FC102 already exists.",
      "serial": "already in use"
    }
  }
}
```
Example (400):

```json example:errors.400.fields 400
{
  "error": {
    "code": "VALIDATION",
    "message": "Please fix the highlighted fields.",
    "fieldErrors": {
      "name": "Name is required",
      "email": "Enter a valid email address"
    }
  }
}
```

**Statuses of success.** `200` for reads and updates, `201` for the create endpoints (vehicle, customer, staff, FAQ, stock listing, stock image, photo, document, chat reply). Lookup `POST` is find-or-create and answers `200` either way.

**Dates and numbers.** Dates are ISO 8601 strings in UTC (`2026-10-11T18:30:00.000Z`). A date-only field is still sent as a full timestamp. When you send a date you may send `YYYY-MM-DD` or a full timestamp; an empty string or `null` clears an optional date. Decimal values (`sellingPrice`, stock `price.amount`) are plain JSON numbers.

**Caching.** Every response carries `Cache-Control: no-store`, except the signed file links (section 6). Do not cache API responses in a shared cache.

**Authentication.** `Authorization: Bearer <accessToken>` on every `/api/v1` call except `auth/login`, `auth/refresh` and `auth/logout`. Tokens never go in a URL.

**Contract version.** Every answer under `/api/v1` (success, error, `401`, `404`, `429`) carries `X-Contract-Version: <version>`, the version at the top of this document (since 1.7.0). Compare it with the version your client was built for and warn or reload when it is newer. Browsers on an allowed origin can read it (see CORS below). The file links (`/f/v1`), the customer zone and the public website API do not send it.

**Request id.** Every answer carries `X-Request-Id`, a random UUID the server makes for that request (a value you send is ignored). It is the `reqId` in the server log: quote it in a support report. Browsers on an allowed origin can read it (see CORS below). Since 1.1.0.

**Rate limits and 429.** Per client address: 300 requests a minute overall; 10 a minute on each of `auth/login`, `auth/refresh`, `auth/logout`; 20 a minute on each of the two `device-tokens` calls; 60 a minute on `uploads/presign`; 30 a minute on the notification stream; 240 a minute on file links. A limited call answers `429` with `{ "error": { "code": "RATE_LIMITED", ... } }`, `Retry-After: <seconds>` and `X-RateLimit-Limit / -Remaining / -Reset` headers. A browser on an allowed origin **can** read these headers, and `X-Request-Id`, because the API lists them in `Access-Control-Expose-Headers` (since 1.1.0). Prefer `Retry-After` over a fixed wait. The limiter counts per client address, in the memory of one server instance; see section 9 for what that means behind a proxy or from a server-side caller.

**Lists, pagination and sorting.** There are three kinds of list:
- *Plain arrays* (no paging): customers (name order, unlimited), customer search (20), staff (name order), lookups (`?q=`, at most 20, name order), FAQs, status history, milestones, destinations, row colours, active customers (at most 200).
- *Paged, with `totalPages`*: vehicles, notifications, activity log. `page` (1 and up, default 1), `pageSize` (1 to 100, default 50). Response `{ rows, total, page, pageSize, totalPages }`; `totalPages` is at least 1.
- *Paged, without `totalPages`*: link requests, chat inbox, chat messages, stock, enquiries. `page` (default 1), `pageSize` (1 to 50, default 20). Response `{ rows, total, page, pageSize }`.

An out-of-range page returns an empty `rows`, not an error. A `pageSize` above the maximum is a 400.

**Vehicle list sort.** `sort` is one of `serial, chassisNo, model, yom, shipmentStatus, purchaseDate, etd, eta, destination, docsArrivedDate, nameChangeDeadline, massoDate, docSentDate, recycleDate, vesselName, deliveryDate, sellingPrice`, and `dir` is `asc` or `desc`. **The default is `sort=serial&dir=desc`** (highest serial number first, ignoring the FC/FL prefix), and the default `track` is `FC`. There is no tie-break column: rows with equal sort values may swap between pages, so prefer a unique sort (`serial`) when you page through everything. Rows with no value in the sort column follow PostgreSQL's null order (last for `asc`, first for `desc`). `sort=shipmentStatus` sorts the *effective* status (section 4) and is done in memory, so it is the slowest sort.

**Other organisations.** Every query is limited to the organisation in your token. An id from another organisation behaves exactly like an id that does not exist: `404`, never `403`.

**CORS.** The API answers cross-origin calls only for origins listed by the operator in `CORS_ALLOWED_ORIGINS` (never `*`). For an allowed origin it allows the methods `GET, POST, PATCH, PUT, DELETE, OPTIONS` and the request headers `Authorization` and `Content-Type`; it does not allow credentials (there are no cookies), sets no `Access-Control-Max-Age` (browsers re-send the preflight often) and exposes exactly these response headers to scripts: `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `X-Request-Id`, `X-Contract-Version`. **When a browser must call the API directly** (a single-page app, or the upload and notification-stream code in a Next.js client component), the app's origin must be on that list; ask the operator to add it. Calls made from a Next.js server (server actions, route handlers) are not browser calls and need no CORS entry, but see section 9 for the client-address effect. The direct upload to storage (section 6) is a separate CORS configuration on the storage bucket.

**Security headers.** Responses carry the standard helmet set (for example `X-Content-Type-Options: nosniff`, `Strict-Transport-Security`). JSON only; send `Content-Type: application/json` on bodies. Bodies larger than 1 MiB, malformed JSON and unsupported content types answer `400 VALIDATION` (`Invalid request.`).

---

## 2. Staff authentication lifecycle

Two tokens. The **access token** (a signed JWT) lasts **20 minutes**; the **refresh token** (an opaque random string) lasts **30 days** and is single use.

### Sign in

#### POST /api/v1/auth/login

**Roles:** none (public: no token needed)

Body: `{ "email": string, "password": string }`. The email is trimmed and lower-cased (max 150, must look like an address). The password is any non-empty string (old passwords of any length still work).

Example (200):

```json example:auth.login 200
{
  "data": {
    "accessToken": "<access token (JWT)>",
    "accessTokenExpiresIn": 1200,
    "refreshToken": "<refresh token>",
    "refreshTokenExpiresAt": "2026-12-01T14:11:48.223Z",
    "user": {
      "id": "staff_mgr",
      "name": "Example Manager",
      "email": "manager@example.test",
      "role": "MANAGER",
      "orgId": "org_test_a"
    }
  }
}
```

- `accessTokenExpiresIn` is in seconds (1200). `refreshTokenExpiresAt` is an ISO date. `user.role` is the role **at sign-in**.
- **A wrong email or password is `400 VALIDATION`, not 401**, with the message `Invalid email or password.` (same answer, and the same timing, whether or not the email exists).
- **Lockout:** 5 wrong passwords lock the account for 15 minutes. While locked, even the right password answers `403 FORBIDDEN` with the message `This account is temporarily locked after repeated failed sign-in attempts. Try again in a few minutes.` An email that does not exist locks the same way, so the response never says whether an account exists. A successful sign-in resets the counter.
- A malformed body answers `400` with `fieldErrors` (`email`, `password`).

Example (400):

```json example:auth.login.wrong 400
{
  "error": {
    "code": "VALIDATION",
    "message": "Invalid email or password."
  }
}
```
Example (400):

```json example:auth.login.invalid 400
{
  "error": {
    "code": "VALIDATION",
    "message": "Please check your email and password.",
    "fieldErrors": {
      "email": "Enter a valid email address",
      "password": "Password is required"
    }
  }
}
```
Example (403):

```json example:auth.login.locked 403
{
  "error": {
    "code": "FORBIDDEN",
    "message": "This account is temporarily locked after repeated failed sign-in attempts. Try again in a few minutes."
  }
}
```

### Refresh

#### POST /api/v1/auth/refresh

**Roles:** none (public: no token needed)

Body: `{ "refreshToken": string }`. Answers the same shape as sign in with a **new access token and a new refresh token**; the old refresh token is dead as soon as the call succeeds (rotation).

Example (200):

```json example:auth.refresh 200
{
  "data": {
    "accessToken": "<access token (JWT)>",
    "accessTokenExpiresIn": 1200,
    "refreshToken": "<refresh token>",
    "refreshTokenExpiresAt": "2026-12-01T14:11:48.231Z",
    "user": {
      "id": "staff_mgr",
      "name": "Example Manager",
      "email": "manager@example.test",
      "role": "MANAGER",
      "orgId": "org_test_a"
    }
  }
}
```

Rules that matter for your client:

1. **Persist the new pair before you use it, and never send the same refresh token twice.** Serialize refreshes: keep one in-flight refresh per signed-in user and let every other 401 wait for it (a single "refresh promise" in the web app; a single actor in iOS). On a server-rendered Next.js app, do this in one place (middleware or a token store), not per request.
2. **A refresh token that was already used, expired, revoked or unknown answers `403 FORBIDDEN`** with the message `Session expired. Please sign in again.` (note: **403, not 401**). Treat any 403 from `auth/refresh` as "sign in again".
3. **Reuse detection.** Presenting a token that was already rotated:
   - within **10 seconds** of the rotation it is treated as a client retry (for example a lost response): the call is refused with the `403` above and the live session is **left alone**;
   - after 10 seconds it is treated as theft: the call is refused and **every refresh token of that user is revoked** (all of the user's devices must sign in again).
4. **Two refreshes at the same moment with the same token:** exactly one succeeds. The other answers the same `403`, and because it is inside the 10 seconds the session is not revoked. If your second request was a duplicate, discard its failure; the first one's new pair is the live one. (If your client lost the first response, sign in again.)
5. **Use single-flight refresh.** Keep at most one refresh in flight per app (or per browser, across tabs): when an access token expires, the first request starts the refresh, every other request waits for that one and reuses its answer, and a retry never sends the same refresh token twice. The API deliberately does **not** answer a repeated refresh with the same new pair (that would make a stolen token safe to replay), so the client is responsible for not repeating it.
6. Each refresh re-reads the user from the database: a deactivated account, or one without a role, is refused with the same `403`. The new access token carries the **current** role; the `user.role` in the answer is the one to show.

Example (403):

```json example:auth.refresh.reused 403
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Session expired. Please sign in again."
  }
}
```

### Sign out

#### POST /api/v1/auth/logout

**Roles:** none (public: no token needed)

Body: `{ "refreshToken": string, "expoPushToken"?: string }`. Answers `{ "data": { "loggedOut": true } }`. **Idempotent:** an unknown or already revoked token is still `200`. When `expoPushToken` is sent, that push token is removed, but only if it belongs to the user the refresh token was issued to. The access token is not revoked (it simply expires within 20 minutes); delete it on the client.

Example (200):

```json example:auth.logout 200
{
  "data": {
    "loggedOut": true
  }
}
```

### What happens to a signed-in person

The access token only proves who signed in. **On every request the API reads the user from the database** (through a cache of `STAFF_AUTH_CACHE_SECONDS`, default 30 seconds, maximum 300) and uses the **database** role, not the role inside the token:

| Event | What the client sees |
|---|---|
| Account deactivated, removed, or its role removed | `401 UNAUTHENTICATED` (`Invalid or expired token.`) on the next request in the same server instance; at most the cache time later on another instance. All refresh tokens are revoked at once, so a refresh also fails (`403`) |
| Role changed (for example MANAGER to VIEWER) | The very next request is judged with the new role (the cache is cleared in the same instance; otherwise within the cache time). Calls the new role may not make answer `403`. All refresh tokens are revoked, so the person is signed out of the app when the access token expires. The UI must expect a role to change under it: re-read `GET /profile` on a 403 |
| Password changed by the person (`POST /profile/password`) | **All of the person's refresh tokens are revoked, including the one of this device.** The current access token keeps working until it expires (at most 20 minutes). Sign in again with the new password right after the change |
| Password set for someone by an administrator | The same revocation for that person |
| Account locked (5 failures) | Only sign in is affected; existing sessions continue |
| Access token expired | `401 UNAUTHENTICATED`, message `Invalid or expired token.`; refresh once |
| Notification stream open when any of the above happens | The stream is closed within 60 seconds (section 7) |

**Token claims.** The access token is a JWT with `sub` (the user id), `exp`, `iat`, `iss` and `aud` set by the server, plus `orgId`, `role`, `name`, `email`. **Do not parse it to make decisions.** The client may rely on `exp` only to schedule a refresh a little early; it must not read `role` for authorization (the server ignores it) and must not assume the other claims are stable. Get the role for UI gating from a response, not from the token.

**Responses that carry the user's role** (for gating the UI): `POST /auth/login` and `POST /auth/refresh` (`user.role`), `GET /profile` (`role`), `PATCH /profile` (`role`), and, for administrators and managers, `GET /staff` (`role` of each member). No other response includes it. The role is one of `ADMINISTRATOR`, `MANAGER`, `OPERATOR`, `VIEWER`.

---

## 3. Role matrix

Roles are exactly `ADMINISTRATOR | MANAGER | OPERATOR | VIEWER`, enforced on the server for every route (a hidden button is not security). **yes** = allowed. **scoped** = allowed but limited (see below). A dash = `403 FORBIDDEN`. Every route needs a valid staff token (`401` otherwise). This table is generated from `tests/route-inventory.table.ts`, which the route inventory test compares with the real routes, and the contract test checks it again against this file.

| Method | Path | ADMINISTRATOR | MANAGER | OPERATOR | VIEWER |
|---|---|---|---|---|---|
| POST | `/api/v1/auth/login` | public | public | public | public |
| POST | `/api/v1/auth/refresh` | public | public | public | public |
| POST | `/api/v1/auth/logout` | public | public | public | public |
| GET | `/api/v1/customers` | yes | yes | yes | yes |
| GET | `/api/v1/customers/search` | yes | yes | yes | yes |
| GET | `/api/v1/customers/:id` | yes | yes | yes | yes |
| POST | `/api/v1/customers` | yes | yes | — | — |
| PATCH | `/api/v1/customers/:id` | yes | yes | — | — |
| GET | `/api/v1/staff` | yes | yes | — | — |
| POST | `/api/v1/staff` | yes | — | — | — |
| PATCH | `/api/v1/staff/:id` | yes | — | — | — |
| POST | `/api/v1/staff/:id/active` | yes | — | — | — |
| GET | `/api/v1/profile` | yes | yes | yes | yes |
| PATCH | `/api/v1/profile` | yes | yes | yes | yes |
| POST | `/api/v1/profile/password` | yes | yes | yes | yes |
| GET | `/api/v1/organization` | yes | yes | yes | yes |
| GET | `/api/v1/dashboard/stats` | yes | yes | yes | yes |
| GET | `/api/v1/dashboard/trends` | yes | yes | yes | yes |
| GET | `/api/v1/reports/by-customer` | yes | yes | yes | yes |
| GET | `/api/v1/reports/by-auction-hall` | yes | yes | yes | yes |
| GET | `/api/v1/reports/by-destination` | yes | yes | yes | yes |
| GET | `/api/v1/reports/by-freight-agent` | yes | yes | yes | yes |
| GET | `/api/v1/activity-log` | yes | — | — | — |
| GET | `/api/v1/activity-log/filters` | yes | — | — | — |
| GET | `/api/v1/lookups/brands` | yes | yes | yes | yes |
| GET | `/api/v1/lookups/brands/:id` | yes | yes | yes | yes |
| POST | `/api/v1/lookups/brands` | yes | yes | — | — |
| PATCH | `/api/v1/lookups/brands/:id` | yes | yes | — | — |
| GET | `/api/v1/lookups/auction-halls` | yes | yes | yes | yes |
| GET | `/api/v1/lookups/auction-halls/:id` | yes | yes | yes | yes |
| POST | `/api/v1/lookups/auction-halls` | yes | yes | — | — |
| PATCH | `/api/v1/lookups/auction-halls/:id` | yes | yes | — | — |
| GET | `/api/v1/lookups/suppliers` | yes | yes | yes | yes |
| GET | `/api/v1/lookups/suppliers/:id` | yes | yes | yes | yes |
| POST | `/api/v1/lookups/suppliers` | yes | yes | — | — |
| PATCH | `/api/v1/lookups/suppliers/:id` | yes | yes | — | — |
| GET | `/api/v1/lookups/transport-companies` | yes | yes | yes | yes |
| GET | `/api/v1/lookups/transport-companies/:id` | yes | yes | yes | yes |
| POST | `/api/v1/lookups/transport-companies` | yes | yes | — | — |
| PATCH | `/api/v1/lookups/transport-companies/:id` | yes | yes | — | — |
| GET | `/api/v1/lookups/inspection-companies` | yes | yes | yes | yes |
| GET | `/api/v1/lookups/inspection-companies/:id` | yes | yes | yes | yes |
| POST | `/api/v1/lookups/inspection-companies` | yes | yes | — | — |
| PATCH | `/api/v1/lookups/inspection-companies/:id` | yes | yes | — | — |
| GET | `/api/v1/lookups/inspection-by` | yes | yes | yes | yes |
| GET | `/api/v1/lookups/inspection-by/:id` | yes | yes | yes | yes |
| POST | `/api/v1/lookups/inspection-by` | yes | yes | — | — |
| PATCH | `/api/v1/lookups/inspection-by/:id` | yes | yes | — | — |
| GET | `/api/v1/lookups/packing-agents` | yes | yes | yes | yes |
| GET | `/api/v1/lookups/packing-agents/:id` | yes | yes | yes | yes |
| POST | `/api/v1/lookups/packing-agents` | yes | yes | — | — |
| PATCH | `/api/v1/lookups/packing-agents/:id` | yes | yes | — | — |
| GET | `/api/v1/lookups/vehicle-locations` | yes | yes | yes | yes |
| GET | `/api/v1/lookups/vehicle-locations/:id` | yes | yes | yes | yes |
| POST | `/api/v1/lookups/vehicle-locations` | yes | yes | — | — |
| PATCH | `/api/v1/lookups/vehicle-locations/:id` | yes | yes | — | — |
| GET | `/api/v1/lookups/models` | yes | yes | yes | yes |
| GET | `/api/v1/lookups/models/:id` | yes | yes | yes | yes |
| POST | `/api/v1/lookups/models` | yes | yes | — | — |
| PATCH | `/api/v1/lookups/models/:id` | yes | yes | — | — |
| GET | `/api/v1/lookups/grades` | yes | yes | yes | yes |
| GET | `/api/v1/lookups/grades/:id` | yes | yes | yes | yes |
| POST | `/api/v1/lookups/grades` | yes | yes | — | — |
| PATCH | `/api/v1/lookups/grades/:id` | yes | yes | — | — |
| POST | `/api/v1/lookups/freight-agents` | yes | yes | — | — |
| PATCH | `/api/v1/lookups/freight-agents/:id` | yes | yes | — | — |
| GET | `/api/v1/lookups/freight-agents` | yes | yes | yes | yes |
| GET | `/api/v1/lookups/freight-agents/search` | yes | yes | yes | yes |
| GET | `/api/v1/lookups/freight-agents/:id` | yes | yes | yes | yes |
| GET | `/api/v1/lookups/row-colour-statuses` | yes | yes | yes | yes |
| GET | `/api/v1/notifications/stream` | yes | yes | yes | yes |
| GET | `/api/v1/notifications` | yes | yes | yes | yes |
| GET | `/api/v1/notifications/unread-count` | yes | yes | yes | yes |
| POST | `/api/v1/notifications/read-all` | yes | yes | yes | yes |
| POST | `/api/v1/notifications/:id/read` | yes | yes | yes | yes |
| POST | `/api/v1/device-tokens` | yes | yes | yes | yes |
| DELETE | `/api/v1/device-tokens` | yes | yes | yes | yes |
| POST | `/api/v1/admin/jobs/daily-checks` | yes | — | — | — |
| GET | `/api/v1/vehicles` | yes | yes | yes | yes |
| POST | `/api/v1/vehicles` | yes | yes | — | — |
| PUT | `/api/v1/vehicles/:id` | yes | yes | — | — |
| DELETE | `/api/v1/vehicles/:id` | yes | yes | — | — |
| PATCH | `/api/v1/vehicles/:id/row-colour` | yes | yes | yes | — |
| PATCH | `/api/v1/vehicles/:id/auction-bill-paid` | yes | yes | yes | — |
| POST | `/api/v1/vehicles/:id/convert-to-export` | yes | yes | — | — |
| POST | `/api/v1/vehicles/:id/revert-to-local` | yes | yes | — | — |
| POST | `/api/v1/vehicles/:id/convert-to-local` | yes | yes | — | — |
| POST | `/api/v1/vehicles/:id/revert-to-export` | yes | yes | — | — |
| PATCH | `/api/v1/vehicles/:id/serial` | yes | — | — | — |
| GET | `/api/v1/vehicles/check-chassis` | yes | yes | yes | yes |
| GET | `/api/v1/vehicles/next-serial` | yes | yes | yes | yes |
| GET | `/api/v1/vehicles/:serial/files` | yes | yes | yes | yes |
| GET | `/api/v1/vehicles/:serial/pdf-images` | yes | yes | yes | yes |
| POST | `/api/v1/vehicles/:id/photos` | yes | yes | yes | — |
| POST | `/api/v1/vehicles/:id/photos-added` | yes | yes | yes | — |
| POST | `/api/v1/vehicles/:id/documents` | yes | yes | yes | — |
| PUT | `/api/v1/vehicles/:id/auction-sheet` | yes | yes | yes | — |
| DELETE | `/api/v1/vehicles/:id/photos/:photoId` | yes | yes | — | — |
| DELETE | `/api/v1/vehicles/:id/documents/:docId` | yes | yes | — | — |
| GET | `/api/v1/vehicles/filter-options` | yes | yes | yes | yes |
| GET | `/api/v1/vehicles/destinations` | yes | yes | yes | yes |
| GET | `/api/v1/vehicles/partner-names` | yes | yes | yes | yes |
| GET | `/api/v1/vehicles/:serial` | yes | yes | yes | yes |
| GET | `/api/v1/vehicles/:serial/status-history` | yes | yes | yes | yes |
| GET | `/api/v1/vehicles/:serial/milestones` | yes | yes | yes | yes |
| GET | `/api/v1/vehicles/:serial/timeline` | yes | yes | yes | yes |
| PUT | `/api/v1/vehicles/:id/milestones/:type` | yes | yes | yes | — |
| POST | `/api/v1/vehicles/:id/mark-arrived` | yes | yes | yes | — |
| POST | `/api/v1/vehicles/:id/mark-delivered` | yes | yes | yes | — |
| DELETE | `/api/v1/vehicles/:id/milestones/:type` | yes | yes | yes | — |
| POST | `/api/v1/uploads/presign` | yes | yes | yes | — |
| PATCH | `/api/v1/customers/:id/login-access` | yes | yes | — | — |
| PATCH | `/api/v1/customers/:id/agent` | yes | yes | — | — |
| GET | `/api/v1/staff/customers/active` | yes | yes | — | — |
| GET | `/api/v1/link-requests` | yes | yes | — | — |
| POST | `/api/v1/link-requests/:id/approve` | yes | yes | — | — |
| POST | `/api/v1/link-requests/:id/reject` | yes | yes | — | — |
| GET | `/api/v1/faqs` | yes | yes | — | — |
| POST | `/api/v1/faqs` | yes | yes | — | — |
| PATCH | `/api/v1/faqs/:id` | yes | yes | — | — |
| DELETE | `/api/v1/faqs/:id` | yes | yes | — | — |
| GET | `/api/v1/vehicles/:id/release-readiness` | yes | yes | yes | — |
| PATCH | `/api/v1/vehicles/:id/customer-visibility` | yes | yes | — | — |
| PATCH | `/api/v1/vehicles/:id/customer-info` | yes | yes | — | — |
| PATCH | `/api/v1/vehicles/:id/documents/:docId` | yes | yes | — | — |
| PATCH | `/api/v1/vehicles/:id/photos/:photoId` | yes | yes | — | — |
| PATCH | `/api/v1/vehicles/:id/photos` | yes | yes | — | — |
| GET | `/api/v1/chat/conversations` | scoped | scoped | scoped | — |
| GET | `/api/v1/chat/conversations/:id/messages` | scoped | scoped | scoped | — |
| POST | `/api/v1/chat/conversations/:id/messages` | scoped | scoped | scoped | — |
| POST | `/api/v1/chat/conversations/:id/handled` | scoped | scoped | scoped | — |
| POST | `/api/v1/chat/conversations/:id/read` | scoped | scoped | scoped | — |
| GET | `/api/v1/stock` | yes | yes | — | — |
| POST | `/api/v1/stock` | yes | yes | — | — |
| GET | `/api/v1/stock/:id` | yes | yes | — | — |
| PATCH | `/api/v1/stock/:id` | yes | yes | — | — |
| DELETE | `/api/v1/stock/:id` | yes | yes | — | — |
| POST | `/api/v1/stock/:id/publish` | yes | yes | — | — |
| POST | `/api/v1/stock/:id/unpublish` | yes | yes | — | — |
| POST | `/api/v1/stock/:id/mark-sold` | yes | yes | — | — |
| POST | `/api/v1/stock/:id/images/presign` | yes | yes | — | — |
| POST | `/api/v1/stock/:id/images` | yes | yes | — | — |
| POST | `/api/v1/stock/:id/images/reorder` | yes | yes | — | — |
| PATCH | `/api/v1/stock/:id/images/:imageId` | yes | yes | — | — |
| DELETE | `/api/v1/stock/:id/images/:imageId` | yes | yes | — | — |
| GET | `/api/v1/enquiries` | yes | yes | — | — |
| POST | `/api/v1/enquiries/:id/handled` | yes | yes | — | — |

**Scoped (OPERATOR, chat only).** An OPERATOR sees only the conversations of customers whose assigned agent (`assignedAgentId`) is that operator, checked against the database on every request. Any other conversation (another agent's, an unassigned customer's, another organisation's) is `404`. ADMINISTRATOR and MANAGER see every conversation. VIEWER has no chat access.

**VIEWER restrictions.** A VIEWER can read vehicles, lookups, dashboards and reports, but:
- never sees a customer's contact details: `GET /customers` rows have **no `email`, `phone` or `address` keys at all**; searching by those is not possible (`q` matches the name only); and `GET /reports/by-customer` groups have no `email` or `phone` keys. Do not render a column for them when the role is VIEWER (the keys are absent, not null);
- cannot change anything, upload anything, or see the staff list, the activity log, customer administration, chat, public stock or enquiries.

**Administrator accounts.** The account named exactly `Administrator` is the *super-admin*. Only it can create, edit, activate or deactivate other administrator accounts or grant the ADMINISTRATOR role (`403 FORBIDDEN` for any other administrator), and only it can see the `Administrator` row in `GET /staff`. The name `Administrator` is reserved (`400`) for anyone else.

---

## 4. Domain model the UI must respect

**Tracks.** Every vehicle is **FC** (export) or **FL** (local). The serial prefix (`FC101`, `FL201`) is only where the vehicle started. **The track you display and filter on is the *effective* track**, returned as `track`: a local vehicle converted to export (`convertedToExport: true`) is FC, an export vehicle converted to local (`convertedToLocal: true`) is FL. Never decide FC versus FL from the serial's letters. The list default `track=FC` therefore includes converted vehicles. **FL vehicles never store shipping fields** (ETD, ETA, BL number, vessel, freight agent, shipping method, packing agent, vanning date, container number): the server strips them on create and update, and they come back `null`. Hide those inputs for an FL vehicle. FL vehicles get no shipment status history rows.

**Shipment status.** Stored values are `PENDING`, `BOOKING_RECEIVED` and `SHIPPED`. A fourth value, `CANCELLED`, is **computed only** and never stored: an export vehicle whose row colour is "Unit Canceled" or "Resold in Auction" is shown as cancelled. A `BOOKING_RECEIVED` vehicle whose ETD has passed is shown as `SHIPPED` by the same computation (and the daily job stores it). **Two shapes name the two values differently, on purpose:** a **list row** has `shipmentStatus` (the stored value) and `effectiveShipmentStatus` (what to show and filter by); the **vehicle detail** (and the answers of create and update) has `shipmentStatus` = **the effective value, what to show**, and `storedShipmentStatus` = the value the database holds (since 1.4.0 the detail carries both; before, the documentation wrongly called the detail's `shipmentStatus` the stored value). The `status` filter and the reports use the effective value. Show `shipmentStatus` from the detail and `effectiveShipmentStatus` from a list row.

**Tri-state flags.** `auctionBillPaid`, `logBook`, `extraKey` and `paidByCustomer` are `true`, `false` or **`null`, meaning "not entered"**. `null` is a real value: show it as blank, never as "No", and never send `false` for "not entered". In list filters the three states are `YES`, `NO`, `BLANK`. In `PUT /vehicles/:id` an omitted tri-state field becomes `null`.

**Serial numbers.** The server assigns `serial` on create (`FC` or `FL` plus the next number for the track). `GET /vehicles/next-serial` is only a preview. A *legacy entry* (`isLegacyEntry: true`) supplies `legacySerialNumber` instead. The serial is read-only after creation: `PUT` cannot change it or the track; only an ADMINISTRATOR can correct it, with `PATCH /vehicles/:id/serial`.

**Soft delete.** `DELETE /vehicles/:id` hides the vehicle from every read (list, detail, reports, files, milestones, search, dashboard). It is not restorable through the API (there is no restore route). **Its serial becomes free** (since 1.8.0): a new vehicle may be created with it, or an administrator may correct a vehicle to it, and then the same serial exists on one deleted and one active vehicle. Lookups by serial only ever find the active one; the deleted one is identified by its id (activity log, notifications and link requests carry ids).

**Vehicle remark.** `vehicleRemark` is one single text field (max 2000) that is **overwritten** on every `PUT`; there is no remark history. Send the whole current text back when you save.

**Lookups are foreign keys.** Brand, model, grade, auction hall, supplier, customer, freight agent, packing agent, transport company, inspection company, inspected-by, vehicle location and row colour are stored as ids. Send ids, not names. New lookup rows are created only through `POST /lookups/...`; a vehicle save never creates one. Every id must belong to your organisation (otherwise `400` with a field error). A vehicle has either an auction hall or a supplier, not both.

**Milestones.** One row per vehicle and type, from `BOUGHT, AUCTION_BILL_PAID, AT_EXPORT_YARD, EXPORT_CERT_ISSUED, BOOKING_RECEIVED, SHIPPED, BL_ISSUED, ARRIVED, DELIVERED` (this is also the customer's timeline). The server records only `BOOKING_RECEIVED` (when a vehicle enters that status) and `SHIPPED` (the daily job and any edit that makes it shipped, dated by the ETD) itself; every other type is recorded by staff. Automation only ever **adds**: clearing an ETD or reverting a status removes no milestone. Staff may set a milestone's date (`PUT`, not in the future) and undo one (`DELETE`), which is the only way a milestone is removed. `ARRIVED` and `DELIVERED` have shortcut endpoints.

**Row colour.** A vehicle has at most one row colour status `{ id, name, colour, transportCellOnly }` (`colour` is a CSS hex such as `#ff8800`). Paint the whole table row with `colour`, unless `transportCellOnly` is true, in which case paint only the transport cell. The statuses named "Unit Canceled" and "Resold in Auction" also make the *effective* shipment status `CANCELLED` (FC only). The dashboard's "In Progress" bar means "every status except Transport Complete", which is the list filter `rowColourNot`.

**Release to the customer.** A vehicle is shown to its customer only when it is linked to a customer, is FC, and staff set `customerVisible`; photos and documents are shown only when individually released (`visibleToCustomer`). Customers never see amounts, auction sheets, remarks, auction hall, supplier or lot numbers.

---

## 5. Endpoints, by screen area

Every endpoint below shows its allowed roles (from the code), its request, and its answer. Unless said otherwise: path parameters named `:id` are database ids (any string, `404` if unknown), `:serial` is a vehicle serial such as `FC102`, an unknown body field is ignored on vehicle, customer, staff and lookup bodies and is a `400` on bodies marked *strict*. "Same as X" means the same key set. Errors every authenticated endpoint can produce (not repeated): `401` (token), `403` (role), `429`. Every write also writes an activity-log row on the server; nothing for the client to do.

### 5.1 My account and the organisation

#### GET /api/v1/profile

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

The signed-in person. Use it to read the current role. `isSuperAdmin` (since 1.7.0) is `true` only for the account named exactly `Administrator` with the ADMINISTRATOR role: use it to show or hide the controls only that account may use (section 3). It is computed by the same server function that enforces the reserved-name rule. **It is for display only: every action is checked on the server again**, so never rely on it for security.

Example (200):

```json example:profile.get 200
{
  "data": {
    "id": "staff_mgr",
    "name": "Example Manager",
    "email": "manager@example.test",
    "phone": "0770000000",
    "role": "MANAGER",
    "isSuperAdmin": false
  }
}
```

#### PATCH /api/v1/profile

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

Body (a real PATCH, since 1.3.0): any of `{ "name": string (1-150), "email": string (valid, max 150, stored lower case), "phone": string|null (max 30) }`, at least one. **Only the fields you send change**; an absent field is left alone, and `phone: null` (or a blank string) clears the phone. Unknown fields and an empty body are `400`. Answers the same as `GET /profile` (including `isSuperAdmin`). `409 CONFLICT` with `fieldErrors.email` if another account has that email.

Example (200):

```json example:profile.update 200
{
  "data": {
    "id": "staff_mgr",
    "name": "Example Manager",
    "email": "manager@example.test",
    "phone": "0770000000",
    "role": "MANAGER",
    "isSuperAdmin": false
  }
}
```

#### POST /api/v1/profile/password

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

Body: `{ "currentPassword": string, "newPassword": string (12 to 72 bytes), "confirmPassword": string (must equal newPassword) }`. Answers `{ "data": { "changed": true } }`. A wrong current password is `400` with `fieldErrors.currentPassword`. **All refresh tokens of this person are revoked, including the refresh token of the device that made this call** (section 2). The app must therefore send the person back to sign in after a successful change; do not try to refresh with the stored token.

Example (200):

```json example:profile.password 200
{
  "data": {
    "changed": true
  }
}
```
Example (400):

```json example:profile.password.wrong 400
{
  "error": {
    "code": "VALIDATION",
    "message": "Current password is incorrect.",
    "fieldErrors": {
      "currentPassword": "Current password is incorrect"
    }
  }
}
```

#### GET /api/v1/organization

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

The organisation's display name, for the app header. `{ "data": { "name": string } }`.

Example (200):

```json example:organization.get 200
{
  "data": {
    "name": "Example Organization"
  }
}
```

### 5.2 Vehicle list and detail

#### GET /api/v1/vehicles

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

Query (all optional; repeat `status` for several): `page`, `pageSize` (section 1), `track` (`FC` default, `FL`, `ALL`), `q` (up to 200 characters; matches serial, chassis, auction item and lot number, model, brand, grade, customer name, supplier, partner name, vessel, BL number and LC number), `status` (repeatable: `PENDING`, `BOOKING_RECEIVED`, `SHIPPED`, `CANCELLED`; effective status), `destination`, `partner` (a partner name, FL), `customer`, `rowColour`, `rowColourNot`, `brand`, `model`, `grade`, `hall`, `supplier`, `agent`, `packingAgent`, `location`, `transport` (all ids; `ALL` or empty means no filter), `method` (`RORO`, `CONTAINER`, `ALL`), `billPaid`, `logBook`, `extraKey`, `paidByCustomer` (`ALL`, `YES`, `NO`, `BLANK`), `partnership`, `converted` (converted to export), `convertedLocal` (converted to local) (`ALL`, `YES`, `NO`), `currency` (a sold currency, `ALL`), `etdFrom`, `etdTo`, `etaFrom`, `etaTo` (dates), `sort`, `dir` (section 1; default `serial` `desc`). Anything outside these values is a `400`. `GET /vehicles/filter-options` returns the fixed option lists for the dropdowns.

The row is a flat summary: **names** of the related lookups (`brandName`, `modelName`, ...), not ids, except `rowColourStatus` which is an object. The track shown is the effective one. Soft-deleted vehicles never appear.

Example (200):

```json example:vehicles.list 200
{
  "data": {
    "rows": [
      {
        "id": "v_fc_resold",
        "serial": "FC108",
        "track": "FC",
        "convertedToExport": false,
        "convertedToLocal": false,
        "chassisNo": "CHASSIS-AAA-8",
        "brandName": "Alpha Motors",
        "modelName": "Zeta One",
        "gradeName": null,
        "yom": null,
        "auctionItemNo": null,
        "auctionHallName": null,
        "supplierName": null,
        "auctionLotNo": null,
        "purchaseDate": null,
        "customerName": null,
        "destination": null,
        "hasPartnership": false,
        "partnerName": null,
        "etd": null,
        "eta": null,
        "blNo": null,
        "vesselName": null,
        "freightAgentName": null,
        "shippingMethod": null,
        "packingAgentName": null,
        "vanningDate": null,
        "containerNumber": null,
        "hasInspection": false,
        "inspectionDate": null,
        "inspectionCompanyName": null,
        "inspectionByName": null,
        "transportByName": null,
        "vehicleLocationName": null,
        "auctionBillPaid": null,
        "logBook": null,
        "extraKey": null,
        "docsArrivedDate": null,
        "nameChangeDeadline": null,
        "massoDate": null,
        "trackingNumber": null,
        "lcNo": null,
        "docSentDate": null,
        "docSentComment": null,
        "recycleDate": null,
        "jibaishake": null,
        "vehicleRemark": null,
        "deliveryDate": null,
        "paidByCustomer": null,
        "sellingPrice": null,
        "sellingPriceCurrency": null,
        "shipmentStatus": "PENDING",
        "effectiveShipmentStatus": "CANCELLED",
        "rowColourStatus": {
          "id": "rc_resold",
          "name": "Resold in Auction",
          "colour": "#ff8800",
          "transportCellOnly": false
        }
      }
    ],
    "total": 10,
    "page": 1,
    "pageSize": 1,
    "totalPages": 10
  }
}
```

Keys of a row, grouped: identity `id, serial, track, convertedToExport, convertedToLocal, chassisNo, shipmentStatus, effectiveShipmentStatus`; vehicle `brandName, modelName, gradeName, yom, auctionItemNo, auctionLotNo`; source `auctionHallName, supplierName, purchaseDate, customerName`; shipping (`null` on FL) `destination, etd, eta, blNo, vesselName, freightAgentName, shippingMethod, packingAgentName, vanningDate, containerNumber`; partnership `hasPartnership, partnerName`; inspection `hasInspection, inspectionDate, inspectionCompanyName, inspectionByName`; logistics `transportByName, vehicleLocationName, trackingNumber, lcNo, massoDate`; paperwork `auctionBillPaid, logBook, extraKey (tri-state), docsArrivedDate, nameChangeDeadline, docSentDate, docSentComment, recycleDate, jibaishake`; `vehicleRemark, deliveryDate, paidByCustomer (tri-state), sellingPrice (number|null), sellingPriceCurrency, rowColourStatus ({ id, name, colour, transportCellOnly } | null)`. The example above is the authority for the exact set.

#### GET /api/v1/vehicles/filter-options

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

Example (200):

```json example:vehicles.filter-options 200
{
  "data": {
    "tracks": [
      {
        "value": "FC",
        "label": "FC — Export"
      },
      {
        "value": "FL",
        "label": "FL — Local"
      }
    ],
    "shipmentStatuses": [
      {
        "value": "PENDING",
        "label": "Pending"
      },
      {
        "value": "BOOKING_RECEIVED",
        "label": "Booking Received"
      },
      {
        "value": "SHIPPED",
        "label": "Shipped"
      },
      {
        "value": "CANCELLED",
        "label": "Shipment Cancelled"
      }
    ],
    "shippingMethods": [
      "RORO",
      "CONTAINER"
    ],
    "triStateValues": [
      "YES",
      "NO",
      "BLANK"
    ],
    "twoStateValues": [
      "YES",
      "NO"
    ],
    "soldCurrencies": [
      "JPY",
      "LKR",
      "USD"
    ]
  }
}
```

#### GET /api/v1/vehicles/destinations

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

Distinct destinations in use, alphabetical, for the destination filter. `{ "data": ["Country One", ...] }`. Optional `track=FC|FL` (section 5.9): only destinations of non-deleted vehicles of that effective track; any other value is `400`.

Example (200):

```json example:vehicles.destinations 200
{
  "data": [
    "Country One",
    "Country Two",
    "Local Town"
  ]
}
```

#### GET /api/v1/vehicles/partner-names

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

The partner names for the partner filter (since 1.7.0). The "partner" is the vehicle field `partnerName` (text, up to 200 characters; set on FL vehicles that have a partnership). Distinct values from **non-deleted vehicles of your organisation** of the given **effective** track, trimmed of surrounding spaces, blanks dropped, sorted **without regard to case**, at most **500**. Query `track=FC|FL`, optional, **default `FL`**; any other value is `400 VALIDATION` with `fieldErrors.track`. Answer `{ "data": string[] }`; an empty list is `[]`. Another organisation's names are never returned.

Example (200; the second name belongs to an FC vehicle converted to local, which behaves as FL):

```json example:vehicles.partner-names 200
{
  "data": [
    "Partner One",
    "Partner Two"
  ]
}
```

#### GET /api/v1/vehicles/:serial

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

One vehicle by **serial** (a serial is unique among the organisation's **active** vehicles; a deleted vehicle may share it and is never returned). Unknown, deleted or another organisation's serial: `404`. The detail uses **objects** (`{ id, name }`) for lookups so an edit form can preselect them. `shipmentStatus` is the **effective** status to display (stored value with the ETD and cancelled-row-colour rules applied, `CANCELLED` computed on FC); `storedShipmentStatus` is the stored value (`PENDING`, `BOOKING_RECEIVED` or `SHIPPED`). Use `storedShipmentStatus` only to explain a difference.

Example (200):

```json example:vehicles.detail 200
{
  "data": {
    "id": "v_fc_booked_future",
    "serial": "FC102",
    "track": "FC",
    "convertedToExport": false,
    "convertedToLocal": false,
    "shipmentStatus": "BOOKING_RECEIVED",
    "storedShipmentStatus": "BOOKING_RECEIVED",
    "auctionItemNo": null,
    "chassisNo": "CHASSIS-AAA-2",
    "brand": {
      "id": "brand_a2",
      "name": "Beta Autos"
    },
    "model": {
      "id": "model_a2",
      "name": "Eta Two"
    },
    "grade": null,
    "yom": null,
    "auctionHall": null,
    "supplier": null,
    "purchaseDate": "2026-10-11T18:30:00.000Z",
    "auctionLotNo": null,
    "customer": {
      "id": "cust_a2",
      "name": "Kappa Buyer"
    },
    "destination": "Country Two",
    "hasPartnership": false,
    "partnerName": null,
    "etd": "2026-11-10T18:30:00.000Z",
    "bookingReceivedAt": "2026-01-03T18:30:00.000Z",
    "eta": null,
    "blNo": null,
    "vesselName": null,
    "freightAgent": null,
    "shippingMethod": null,
    "packingAgent": null,
    "vanningDate": null,
    "containerNumber": null,
    "hasInspection": false,
    "inspectionDate": null,
    "inspectionCompany": null,
    "inspectionBy": null,
    "transportBy": null,
    "vehicleLocation": null,
    "massoDate": null,
    "trackingNumber": null,
    "lcNo": null,
    "docsArrivedDate": null,
    "auctionBillPaid": true,
    "logBook": null,
    "extraKey": null,
    "nameChangeDeadline": null,
    "rowColourStatus": null,
    "docSentDate": null,
    "docSentComment": null,
    "recycleDate": null,
    "jibaishake": null,
    "vehicleRemark": null,
    "deliveryDate": null,
    "paidByCustomer": null,
    "sellingPrice": null,
    "sellingPriceCurrency": null,
    "customerVisible": null,
    "portOfLoading": null,
    "portOfDischarge": null,
    "voyageNo": null
  }
}
```

On an FL vehicle the shipping keys are present and `null`; `rowColourStatus` in the detail has `{ id, name, colour }` only (no `transportCellOnly`). `customerVisible, portOfLoading, portOfDischarge, voyageNo` are the customer-release fields (5.7). `bookingReceivedAt` is the time the vehicle entered `BOOKING_RECEIVED`, or `null`.

Example (200):

```json example:vehicles.detail.fl 200
{
  "data": {
    "id": "v_fl_native",
    "serial": "FL201",
    "track": "FL",
    "convertedToExport": false,
    "convertedToLocal": false,
    "shipmentStatus": "PENDING",
    "storedShipmentStatus": "PENDING",
    "auctionItemNo": null,
    "chassisNo": "CHASSIS-LLL-1",
    "brand": {
      "id": "brand_a2",
      "name": "Beta Autos"
    },
    "model": {
      "id": "model_a2",
      "name": "Eta Two"
    },
    "grade": null,
    "yom": null,
    "auctionHall": null,
    "supplier": null,
    "purchaseDate": "2026-10-16T18:30:00.000Z",
    "auctionLotNo": null,
    "customer": {
      "id": "cust_a1",
      "name": "Iota Buyer"
    },
    "destination": "Local Town",
    "hasPartnership": true,
    "partnerName": "Partner One",
    "etd": null,
    "bookingReceivedAt": null,
    "eta": null,
    "blNo": null,
    "vesselName": null,
    "freightAgent": null,
    "shippingMethod": null,
    "packingAgent": null,
    "vanningDate": null,
    "containerNumber": null,
    "hasInspection": false,
    "inspectionDate": null,
    "inspectionCompany": null,
    "inspectionBy": null,
    "transportBy": null,
    "vehicleLocation": null,
    "massoDate": null,
    "trackingNumber": null,
    "lcNo": null,
    "docsArrivedDate": null,
    "auctionBillPaid": null,
    "logBook": null,
    "extraKey": null,
    "nameChangeDeadline": null,
    "rowColourStatus": {
      "id": "rc_cancel",
      "name": "Unit Canceled",
      "colour": "#ff0000"
    },
    "docSentDate": null,
    "docSentComment": null,
    "recycleDate": null,
    "jibaishake": null,
    "vehicleRemark": null,
    "deliveryDate": null,
    "paidByCustomer": true,
    "sellingPrice": 12345,
    "sellingPriceCurrency": "USD",
    "customerVisible": null,
    "portOfLoading": null,
    "portOfDischarge": null,
    "voyageNo": null
  }
}
```

#### GET /api/v1/vehicles/:serial/status-history

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

The shipment status changes of one vehicle, oldest first. `triggerLabel` is human text (for example `ETD saved`, `Automatic — daily job`); `triggeredByName` is `null` when the system did it.

Example (200):

```json example:vehicles.status-history 200
{
  "data": [
    {
      "id": "sh1",
      "fromStatus": null,
      "toStatus": "PENDING",
      "triggerLabel": "Entered manually (legacy)",
      "triggeredByName": "Staff Actor A",
      "createdAt": "2025-12-31T18:30:00.000Z"
    },
    {
      "id": "sh2",
      "fromStatus": "PENDING",
      "toStatus": "BOOKING_RECEIVED",
      "triggerLabel": "ETD saved",
      "triggeredByName": "Staff Actor A",
      "createdAt": "2026-01-01T18:30:00.000Z"
    },
    {
      "id": "sh3",
      "fromStatus": "BOOKING_RECEIVED",
      "toStatus": "PENDING",
      "triggerLabel": "ETD cleared",
      "triggeredByName": null,
      "createdAt": "2026-01-02T18:30:00.000Z"
    },
    {
      "id": "sh4",
      "fromStatus": "PENDING",
      "toStatus": "BOOKING_RECEIVED",
      "triggerLabel": "ETD saved",
      "triggeredByName": "Staff Actor A",
      "createdAt": "2026-01-03T18:30:00.000Z"
    },
    {
      "id": "sh5",
      "fromStatus": "BOOKING_RECEIVED",
      "toStatus": "SHIPPED",
      "triggerLabel": "Automatic — daily job",
      "triggeredByName": null,
      "createdAt": "2026-01-04T18:30:00.000Z"
    }
  ]
}
```

#### GET /api/v1/vehicles/check-chassis

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

Query `chassisNo` (required, 1-100), `excludeId` (a vehicle id to ignore, for edits). `{ "data": { "duplicate": boolean } }`. A *warning only*: a duplicate chassis never blocks a save.

Example (200):

```json example:vehicles.check-chassis 200
{
  "data": {
    "duplicate": true
  }
}
```

#### GET /api/v1/vehicles/next-serial

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

Query `track` (`FC` or `FL`, required). A preview only; the real number is assigned when the vehicle is saved.

Example (200):

```json example:vehicles.next-serial 200
{
  "data": {
    "serial": "FC110"
  }
}
```

### 5.3 Add and edit a vehicle

#### POST /api/v1/vehicles

**Roles:** ADMINISTRATOR, MANAGER

Create. Body fields (type; optional unless marked; empty strings and `null` clear an optional text or id):

| Field | Type and rule |
|---|---|
| `track` (required) | `"FC"` or `"FL"` |
| `isLegacyEntry` (required) | boolean; `true` means you supply the serial number yourself |
| `legacySerialNumber` | positive integer; required when `isLegacyEntry` is true. A serial that an **active** vehicle holds is `409` with `fieldErrors.legacySerialNumber` and `fieldErrors.serial: "already in use"`. A serial held **only by deleted vehicles is free: the create succeeds** (since 1.8.0) and the answer says `serialReused: true`. The counter still follows `lastNumber = max(lastNumber, entered)`: a reused lower number does not move it |
| `reuseDeletedSerial` | **Deprecated since 1.8.0: accepted and ignored.** It used to ask for permission to reuse a deleted vehicle's serial (1.6.0 and 1.7.0 answered `403` for a MANAGER and `409` with a `reason` for everyone else). Reuse is now free, so the field does nothing and no `403` is returned. Stop sending it; it will be rejected as an unknown field in a later MAJOR version |
| `shipmentStatus` | `PENDING`, `BOOKING_RECEIVED` or `SHIPPED` (otherwise the server decides from the ETD) |
| `chassisNo` (required) | string, 1-100 |
| `brandId`, `modelId` (required) | ids |
| `gradeId`, `auctionHallId`, `supplierId`, `customerId`, `freightAgentId`, `packingAgentId`, `inspectionCompanyId`, `inspectionById`, `transportById`, `vehicleLocationId`, `rowColourStatusId` | ids or `null` |
| `yom` | integer 1980 to next year, or `null` |
| `purchaseDate`, `etd`, `eta`, `vanningDate`, `inspectionDate`, `massoDate`, `docsArrivedDate`, `nameChangeDeadline`, `docSentDate`, `recycleDate`, `deliveryDate` | date string or `null` |
| `auctionItemNo`, `auctionLotNo`, `blNo`, `vesselName`, `containerNumber`, `trackingNumber`, `lcNo`, `destination` | text, max 100 |
| `partnerName` | text, max 200; required when `hasPartnership` is true |
| `docSentComment`, `jibaishake` | text, max 500 |
| `vehicleRemark` | text, max 2000 |
| `hasPartnership`, `hasInspection` | boolean, default `false` |
| `shippingMethod` | `"RORO"`, `"CONTAINER"` or `null` |
| `auctionBillPaid`, `logBook`, `extraKey`, `paidByCustomer` | **tri-state**: `true`, `false` or `null` (omitted = `null`) |
| `sellingPrice` | number >= 0 or `null`; `sellingPriceCurrency` text, max 10 |
| `auctionSheetKey` | an upload `key` (6), or `null` |
| `photoKeys` | up to 50 upload keys |
| `documents` | up to 50 of `{ key, name (1-255), documentType }` |

`documentType` is one of `LC, EC, ED, BL, INSPECTION_REPORT, SHAKEN_SHO, FREIGHT_INVOICE, PURCHASE_INVOICE, SALES_INVOICE, MEGI_HENKO, CASH_RECEIPT, OTHER`.

Cross-field rules (each a `400` with a `fieldErrors` entry on the named field): a shipping method needs a `freightAgentId`; `CONTAINER` also needs a `packingAgentId`; `eta` must be after `etd`; not both `auctionHallId` and `supplierId`; `hasPartnership` needs `partnerName`; legacy entry needs `legacySerialNumber`. Every id must belong to your organisation. File keys are checked (they must be inside your organisation's staging folder and the object must exist, section 6). On FL the shipping fields are dropped.

Answers **201 with the new vehicle in the detail shape**, exactly what `GET /vehicles/:serial` returns (section 5.3): names and nested objects, the effective `track`, no `org_id` and no `serialPrefix`. A `409 CONFLICT` means the serial was taken by a concurrent save: retry. **Plus one key, `serialReused: boolean` (since 1.8.0):** `true` when the serial was taken over from a deleted vehicle (the activity log of the creation then records `reusedFromVehicleId`, the id of the most recent deleted vehicle that held it), `false` otherwise (always `false` for an automatically assigned serial: the counter never goes back).

Example (201):

```json example:vehicles.create 201
{
  "data": {
    "id": "vehicle_1",
    "serial": "FC110",
    "track": "FC",
    "convertedToExport": null,
    "convertedToLocal": null,
    "shipmentStatus": "PENDING",
    "storedShipmentStatus": "PENDING",
    "auctionItemNo": null,
    "chassisNo": "CHASSIS-NEW-1",
    "brand": {
      "id": "brand_a1",
      "name": "Alpha Motors"
    },
    "model": {
      "id": "model_a1",
      "name": "Zeta One"
    },
    "grade": {
      "id": "grade_a1",
      "name": "Base"
    },
    "yom": 2021,
    "auctionHall": null,
    "supplier": null,
    "purchaseDate": "2026-10-15T00:00:00.000Z",
    "auctionLotNo": null,
    "customer": {
      "id": "cust_a1",
      "name": "Iota Buyer"
    },
    "destination": "Country One",
    "hasPartnership": false,
    "partnerName": null,
    "etd": null,
    "bookingReceivedAt": null,
    "eta": null,
    "blNo": null,
    "vesselName": null,
    "freightAgent": null,
    "shippingMethod": null,
    "packingAgent": null,
    "vanningDate": null,
    "containerNumber": null,
    "hasInspection": false,
    "inspectionDate": null,
    "inspectionCompany": null,
    "inspectionBy": null,
    "transportBy": null,
    "vehicleLocation": null,
    "massoDate": null,
    "trackingNumber": null,
    "lcNo": null,
    "docsArrivedDate": null,
    "auctionBillPaid": null,
    "logBook": null,
    "extraKey": null,
    "nameChangeDeadline": null,
    "rowColourStatus": null,
    "docSentDate": null,
    "docSentComment": null,
    "recycleDate": null,
    "jibaishake": null,
    "vehicleRemark": "Example remark",
    "deliveryDate": null,
    "paidByCustomer": null,
    "sellingPrice": null,
    "sellingPriceCurrency": null,
    "customerVisible": null,
    "portOfLoading": null,
    "portOfDischarge": null,
    "voyageNo": null,
    "serialReused": false
  }
}
```
Example (400):

```json example:vehicles.create.invalid 400
{
  "error": {
    "code": "VALIDATION",
    "message": "Please fix the highlighted fields.",
    "fieldErrors": {
      "chassisNo": "Chassis number is required",
      "brandId": "Make is required",
      "modelId": "Model is required",
      "legacySerialNumber": "Enter the legacy serial number"
    }
  }
}
```

#### PUT /api/v1/vehicles/:id

**Roles:** ADMINISTRATOR, MANAGER

**Full replace, not a patch.** Send every field again (same fields as create, without `track`, `isLegacyEntry`, `legacySerialNumber`, `shipmentStatus` and the file keys): an optional field you leave out is **cleared**, and a tri-state field you leave out becomes `null`. The serial and the track cannot be changed here. Answers `200` with the vehicle in the detail shape, the same as `GET /vehicles/:serial` (no re-fetch needed). Changing the ETD, the status or the bill can add status history, milestones and notifications on the server.

Example (200):

```json example:vehicles.update 200
{
  "data": {
    "id": "v_fc_booked_future",
    "serial": "FC102",
    "track": "FC",
    "convertedToExport": false,
    "convertedToLocal": false,
    "shipmentStatus": "PENDING",
    "storedShipmentStatus": "PENDING",
    "auctionItemNo": null,
    "chassisNo": "CHASSIS-AAA-2",
    "brand": {
      "id": "brand_a1",
      "name": "Alpha Motors"
    },
    "model": {
      "id": "model_a1",
      "name": "Zeta One"
    },
    "grade": {
      "id": "grade_a1",
      "name": "Base"
    },
    "yom": 2021,
    "auctionHall": null,
    "supplier": null,
    "purchaseDate": "2026-10-15T00:00:00.000Z",
    "auctionLotNo": null,
    "customer": {
      "id": "cust_a1",
      "name": "Iota Buyer"
    },
    "destination": "Country One",
    "hasPartnership": false,
    "partnerName": null,
    "etd": null,
    "bookingReceivedAt": null,
    "eta": null,
    "blNo": null,
    "vesselName": null,
    "freightAgent": null,
    "shippingMethod": null,
    "packingAgent": null,
    "vanningDate": null,
    "containerNumber": null,
    "hasInspection": false,
    "inspectionDate": null,
    "inspectionCompany": null,
    "inspectionBy": null,
    "transportBy": null,
    "vehicleLocation": null,
    "massoDate": null,
    "trackingNumber": null,
    "lcNo": null,
    "docsArrivedDate": null,
    "auctionBillPaid": null,
    "logBook": null,
    "extraKey": null,
    "nameChangeDeadline": null,
    "rowColourStatus": null,
    "docSentDate": null,
    "docSentComment": null,
    "recycleDate": null,
    "jibaishake": null,
    "vehicleRemark": "Example remark",
    "deliveryDate": null,
    "paidByCustomer": null,
    "sellingPrice": null,
    "sellingPriceCurrency": null,
    "customerVisible": null,
    "portOfLoading": null,
    "portOfDischarge": null,
    "voyageNo": null
  }
}
```

#### DELETE /api/v1/vehicles/:id

**Roles:** ADMINISTRATOR, MANAGER

Soft delete. Answers `{ "data": { "deleted": true } }`.

Example (200):

```json example:vehicles.delete 200
{
  "data": {
    "deleted": true
  }
}
```

### 5.4 Quick edits, conversion and serial correction

#### PATCH /api/v1/vehicles/:id/row-colour

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR

Body `{ "rowColourStatusId": string | null }` (the key is required; `null` clears it). Answers `{ "data": { "rowColourStatusId": ... } }`. May change the effective status (a cancelling colour).

Example (200):

```json example:vehicles.row-colour 200
{
  "data": {
    "rowColourStatusId": "rc_done"
  }
}
```

#### PATCH /api/v1/vehicles/:id/auction-bill-paid

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR

Body `{ "auctionBillPaid": true | false | null }`: the key is required and `null` means "not entered".

Example (200):

```json example:vehicles.auction-bill-paid 200
{
  "data": {
    "auctionBillPaid": null
  }
}
```

#### POST /api/v1/vehicles/:id/convert-to-export

**Roles:** ADMINISTRATOR, MANAGER

FL vehicles only. Body `{ "destination": string (1-200) }`. Answers `{ "data": { "converted": true } }`.

Example (200):

```json example:vehicles.convert-to-export 200
{
  "data": {
    "converted": true
  }
}
```

#### POST /api/v1/vehicles/:id/revert-to-local

**Roles:** ADMINISTRATOR, MANAGER

No body. Undoes a conversion to export (back to FL). Answers `{ "data": { "ok": true } }`. The same answer from the three transitions `revert-to-local`, `convert-to-local` (an FC vehicle becomes local) and `revert-to-export` (undoes that); which transition is allowed depends on the vehicle's state, otherwise `400`.

Example (200):

```json example:vehicles.revert-to-local 200
{
  "data": {
    "ok": true
  }
}
```

#### POST /api/v1/vehicles/:id/convert-to-local

**Roles:** ADMINISTRATOR, MANAGER

See `revert-to-local`.

#### POST /api/v1/vehicles/:id/revert-to-export

**Roles:** ADMINISTRATOR, MANAGER

See `revert-to-local`.

#### PATCH /api/v1/vehicles/:id/serial

**Roles:** ADMINISTRATOR

Administrator correction (**ADMINISTRATOR only**, unchanged). Body `{ "serialNumber": positive integer (max 999999999), "reuseDeletedSerial"?: boolean (deprecated, ignored) }`; the prefix stays. Answers `{ "data": { "serial": "FC150", "serialReused": false } }` (since 1.8.0 with `serialReused`). `409` with `fieldErrors.serialNumber` and `fieldErrors.serial: "already in use"` if **another active** vehicle has that number. A number held only by deleted vehicles is **free**: the correction succeeds with `serialReused: true`, and the activity log records `reusedFromVehicleId`. Only an administrator may correct a serial; a MANAGER gets `403`.

Example (200):

```json example:vehicles.serial 200
{
  "data": {
    "serial": "FC150",
    "serialReused": false
  }
}
```
Example (409):

```json example:vehicles.serial.conflict 409
{
  "error": {
    "code": "CONFLICT",
    "message": "Serial FC102 already exists.",
    "fieldErrors": {
      "serialNumber": "Serial FC102 already exists.",
      "serial": "already in use"
    }
  }
}
```

Example (200, the number belonged to a deleted vehicle, so it is reused):

```json example:vehicles.serial.reuse 200
{
  "data": {
    "serial": "FC106",
    "serialReused": true
  }
}
```
### 5.5 Milestones

#### GET /api/v1/vehicles/:serial/milestones

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

Oldest first. `recordedBy` is `null` when the system recorded it.

Example (200):

```json example:milestones.list 200
{
  "data": [
    {
      "type": "BOUGHT",
      "occurredAt": "2026-10-01T00:00:00.000Z",
      "recordedBy": {
        "id": "staff_mgr",
        "name": "Example Manager"
      }
    }
  ]
}
```

#### GET /api/v1/vehicles/:serial/timeline

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

The **Shipment Timeline** of the vehicle detail screen (since 1.4.0): the steps of the physical process, **derived** from fields already on the vehicle. Nothing is stored for it and it is not the same thing as the recorded milestones above. The same derivation the old detail page used. Unknown, deleted or another organisation's serial: `404`. Not paged; ordered as the process runs.

Each step is `{ key, label, completed, date }`; `date` is `null` while not completed, and always `null` for the two flag-based steps. The list is **not fixed**:

| `key` | `label` | Shown | `completed` when | `date` |
|---|---|---|---|---|
| `AUCTION_BILL_PAID` | Auction Bill Paid | always | `auctionBillPaid` is `true` (`false` and `null` both show not completed here) | `null` |
| `TRANSPORT_ASSIGNED` | Rikso Given | always | a transport company is set | `null` |
| `EC_RECEIVED` | EC Received | always | an `EC` document exists | when the earliest EC document was added |
| `INSPECTION_COMPLETED` | Inspection Completed | only once an `INSPECTION_REPORT` document exists | always | when the earliest report was added |
| `LC_OPEN` | LC Open | only when the destination is Sri Lanka or Bangladesh | an LC number is set | `null` |
| `BOOKING_RECEIVED` | Booking Received | always | an ETD is set | when the ETD was saved (falls back to the ETD) |
| `LOADED` | Loaded | only for `CONTAINER` shipments | the vanning date has passed | the vanning date |
| `SHIPPED` | Shipped | always | the ETD has passed | the ETD |
| `DELIVERED` | Delivered | always | the ETA has passed | the ETA |

Example (200):

```json example:vehicles.timeline 200
{
  "data": [
    {
      "key": "AUCTION_BILL_PAID",
      "label": "Auction Bill Paid",
      "completed": true,
      "date": null
    },
    {
      "key": "TRANSPORT_ASSIGNED",
      "label": "Rikso Given",
      "completed": false,
      "date": null
    },
    {
      "key": "EC_RECEIVED",
      "label": "EC Received",
      "completed": false,
      "date": null
    },
    {
      "key": "BOOKING_RECEIVED",
      "label": "Booking Received",
      "completed": true,
      "date": "2026-01-03T18:30:00.000Z"
    },
    {
      "key": "SHIPPED",
      "label": "Shipped",
      "completed": false,
      "date": null
    },
    {
      "key": "DELIVERED",
      "label": "Delivered",
      "completed": false,
      "date": null
    }
  ]
}
```
#### PUT /api/v1/vehicles/:id/milestones/:type

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR

`:type` is one of the nine milestone types (otherwise `400`). Body `{ "occurredAt"?: date string }` (strict; default now; at most one day ahead; year 2000 or later). Records the milestone, or moves its date if it exists. Answers the milestone row.

Example (200):

```json example:milestones.set 200
{
  "data": {
    "type": "AT_EXPORT_YARD",
    "occurredAt": "2026-10-20T00:00:00.000Z",
    "recordedBy": {
      "id": "staff_op",
      "name": "Example Operator"
    }
  }
}
```

#### DELETE /api/v1/vehicles/:id/milestones/:type

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR

Undo. `404` if the vehicle has no such milestone. Answers `{ "data": { "deleted": true } }`.

Example (200):

```json example:milestones.delete 200
{
  "data": {
    "deleted": true
  }
}
```

#### POST /api/v1/vehicles/:id/mark-arrived

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR

Same as `PUT .../milestones/ARRIVED` (same body, same answer).

Example (200):

```json example:milestones.mark-arrived 200
{
  "data": {
    "type": "ARRIVED",
    "occurredAt": "2026-11-01T14:11:48.538Z",
    "recordedBy": {
      "id": "staff_op",
      "name": "Example Operator"
    }
  }
}
```

#### POST /api/v1/vehicles/:id/mark-delivered

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR

Same as `PUT .../milestones/DELIVERED`.

### 5.6 Vehicle files

The endpoints that list, add and delete photos, documents and the auction sheet. How uploading and viewing work is in section 6.

#### GET /api/v1/vehicles/:serial/files

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

Every `url` is a short-lived link (section 6); **never store it**. `unavailable: true` (and `url: null`) appears on a file that cannot be linked; the auction sheet uses `auctionSheetUnavailable: true`.

Example (200):

```json example:files.list 200
{
  "data": {
    "auctionSheetUrl": null,
    "auctionSheetExpiresAt": null,
    "photos": [
      {
        "id": "ph_1",
        "url": "https://api.example.test/f/v1/photo/ph_1/full?o=org_test_a&u=staff_vw&a=staff&exp=1793542608&sig=<signature>",
        "expiresAt": "2026-11-01T14:16:48.000Z",
        "uploaderName": "Example Manager",
        "createdAt": "2026-10-02T00:00:00.000Z"
      }
    ],
    "documents": [
      {
        "id": "doc_1",
        "url": "https://api.example.test/f/v1/document/doc_1/full?o=org_test_a&u=staff_vw&a=staff&exp=1793542608&sig=<signature>",
        "expiresAt": "2026-11-01T14:16:48.000Z",
        "name": "Bill of lading",
        "documentType": "BL",
        "uploaderName": "Example Manager",
        "createdAt": "2026-10-03T00:00:00.000Z"
      }
    ]
  }
}
```

#### GET /api/v1/vehicles/:serial/pdf-images

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

The auction sheet and photos as `data:` URLs, for building a PDF in the browser: `{ "auctionSheetDataUrl": string|null, "photoDataUrls": string[] }`. The server reads images itself (15 MB and 10 seconds each, images only); one that fails is left out.

Example (200):

```json example:files.pdf-images 200
{
  "data": {
    "auctionSheetDataUrl": null,
    "photoDataUrls": [
      "data:image/jpeg;base64,eA=="
    ]
  }
}
```

#### POST /api/v1/uploads/presign

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR

Step one of an upload (6). Body: `{ "vehicleId"?: string, "kind": "AUCTION_SHEET"|"VEHICLE_PHOTO"|"VEHICLE_DOCUMENT", "fileName": string (1-255), "contentType": string, "fileSize": positive integer }`. Leave out `vehicleId` when the vehicle does not exist yet (add-vehicle screen). `400` with `fieldErrors.contentType` or `fieldErrors.fileSize` for a type or size that is not allowed; `404` for a vehicle that is not yours.

Example (200):

```json example:uploads.presign 200
{
  "data": {
    "uploadUrl": "https://storage.example.test/bucket/org/org_test_a/vehicles/v_fc_booked_future/photos/3c132e05-95d1-48c9-8686-94203e2f6e1e-front.jpg?X-Signature=<signature>",
    "key": "org/org_test_a/vehicles/v_fc_booked_future/photos/3c132e05-95d1-48c9-8686-94203e2f6e1e-front.jpg",
    "expiresInSeconds": 300,
    "headers": {
      "Content-Type": "image/jpeg"
    }
  }
}
```

#### POST /api/v1/vehicles/:id/photos

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR

Step three: register an uploaded photo. Body `{ "key": string }`. `201` with the new photo (same keys as an item of `files.list` photos).

Example (201):

```json example:files.photo.add 201
{
  "data": {
    "id": "vehiclePhoto_1",
    "url": "https://api.example.test/f/v1/photo/vehiclePhoto_1/full?o=org_test_a&u=staff_op&a=staff&exp=1793542608&sig=<signature>",
    "expiresAt": "2026-11-01T14:16:48.000Z",
    "uploaderName": "Example Operator",
    "createdAt": "2026-11-01T14:11:48.551Z"
  }
}
```

#### POST /api/v1/vehicles/:id/photos-added

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR

Tells the server "I just uploaded `count` photos" so staff get **one** notification for a batch. Body `{ "count": integer 1-500 }`. Answers `{ "data": { "ok": true } }`.

Example (200):

```json example:files.photos-added 200
{
  "data": {
    "ok": true
  }
}
```

#### POST /api/v1/vehicles/:id/documents

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR

Register an uploaded document (PDF). Body `{ "key": string, "name": string (1-255), "documentType": one of the types above }`. `201` with the document (same keys as an item of `files.list` documents).

Example (201):

```json example:files.document.add 201
{
  "data": {
    "id": "vehicleDocument_1",
    "url": "https://api.example.test/f/v1/document/vehicleDocument_1/full?o=org_test_a&u=staff_op&a=staff&exp=1793542608&sig=<signature>",
    "expiresAt": "2026-11-01T14:16:48.000Z",
    "name": "Export certificate",
    "documentType": "EC",
    "uploaderName": "Example Operator",
    "createdAt": "2026-11-01T14:11:48.647Z"
  }
}
```

#### PUT /api/v1/vehicles/:id/auction-sheet

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR

Replace the auction sheet. Body `{ "key": string }`. Answers `{ "auctionSheetUrl", "auctionSheetExpiresAt" }`.

Example (200):

```json example:files.auction-sheet 200
{
  "data": {
    "auctionSheetUrl": "https://api.example.test/f/v1/auction-sheet/v_fc_booked_future/full?o=org_test_a&u=staff_op&a=staff&exp=1793542608&sig=<signature>",
    "auctionSheetExpiresAt": "2026-11-01T14:16:48.000Z"
  }
}
```

#### DELETE /api/v1/vehicles/:id/photos/:photoId

**Roles:** ADMINISTRATOR, MANAGER

Answers `{ "data": { "deleted": true } }`. The stored object is removed afterwards on a best-effort basis.

Example (200):

```json example:files.photo.delete 200
{
  "data": {
    "deleted": true
  }
}
```

#### DELETE /api/v1/vehicles/:id/documents/:docId

**Roles:** ADMINISTRATOR, MANAGER

Same answer as deleting a photo.

Example (200):

```json example:files.document.delete 200
{
  "data": {
    "deleted": true
  }
}
```

### 5.7 Releasing a vehicle to its customer

Customers see a vehicle only when staff release it (section 4). These endpoints are for ADMINISTRATOR and MANAGER, except the readiness check, which OPERATOR may also read.

#### GET /api/v1/vehicles/:id/release-readiness

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR

Booleans and counts only; changes nothing.

Example (200):

```json example:release.readiness 200
{
  "data": {
    "customerLinked": true,
    "customerVisible": false,
    "photosReleased": 0,
    "photosHidden": 1,
    "documentsReleased": 0,
    "documentsHidden": 1
  }
}
```

#### PATCH /api/v1/vehicles/:id/customer-visibility

**Roles:** ADMINISTRATOR, MANAGER

Body `{ "customerVisible": boolean }` (strict). Showing needs a linked customer and an FC vehicle, otherwise `400` with `fieldErrors.customerVisible`.

Example (200):

```json example:release.visibility 200
{
  "data": {
    "id": "v_fc_booked_future",
    "customerVisible": true
  }
}
```

#### PATCH /api/v1/vehicles/:id/customer-info

**Roles:** ADMINISTRATOR, MANAGER

Body (strict, at least one key): `{ "portOfLoading"?: string|null, "portOfDischarge"?: string|null, "voyageNo"?: string|null }`, each max 100. Answers all three.

Example (200):

```json example:release.info 200
{
  "data": {
    "portOfLoading": "Example Port",
    "portOfDischarge": null,
    "voyageNo": "V001"
  }
}
```

#### PATCH /api/v1/vehicles/:id/documents/:docId

**Roles:** ADMINISTRATOR, MANAGER

Body (strict, at least one key): `{ "documentType"?: type, "visibleToCustomer"?: boolean }`.

Example (200):

```json example:release.document 200
{
  "data": {
    "id": "doc_1",
    "documentType": "BL",
    "visibleToCustomer": true
  }
}
```

#### PATCH /api/v1/vehicles/:id/photos/:photoId

**Roles:** ADMINISTRATOR, MANAGER

Body `{ "visibleToCustomer": boolean }` (strict).

Example (200):

```json example:release.photo 200
{
  "data": {
    "id": "ph_1",
    "visibleToCustomer": true
  }
}
```

#### PATCH /api/v1/vehicles/:id/photos

**Roles:** ADMINISTRATOR, MANAGER

Bulk. Body `{ "visibleToCustomer": boolean, "photoIds": string[] (1-200) }` (strict). Answers how many were updated.

Example (200):

```json example:release.photos 200
{
  "data": {
    "updated": 1,
    "visibleToCustomer": true
  }
}
```

### 5.8 Customers

Customers are the buyers (not the staff). `GET /customers/:id` and the search return `{ id, name }` only, for every role.

#### GET /api/v1/customers

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

Optional `q` (max 200): matches name, email and phone for ADMINISTRATOR, MANAGER and OPERATOR; **name only for a VIEWER**. Name order, not paged. `vehicleCount` is the number of vehicles linked to the customer **including soft-deleted ones** (the count has no deleted filter), so it can be higher than the number of vehicles the list shows.

Example (200):

```json example:customers.list 200
{
  "data": [
    {
      "id": "cust_1",
      "name": "Alpha Buyer",
      "email": "alpha.buyer@example.test",
      "phone": "0771111111",
      "country": "LK",
      "address": "1 Example Road",
      "createdAt": "2026-02-01T00:00:00.000Z",
      "vehicleCount": 0
    },
    {
      "id": "cust_a1",
      "name": "Iota Buyer",
      "email": null,
      "phone": null,
      "country": null,
      "address": null,
      "createdAt": "2026-11-01T14:11:48.462Z",
      "vehicleCount": 0
    },
    {
      "id": "cust_a2",
      "name": "Kappa Buyer",
      "email": null,
      "phone": null,
      "country": null,
      "address": null,
      "createdAt": "2026-11-01T14:11:48.462Z",
      "vehicleCount": 0
    }
  ]
}
```

A VIEWER receives rows **without** `email`, `phone` and `address`:

Example (200):

```json example:customers.list.viewer 200
{
  "data": [
    {
      "id": "cust_1",
      "name": "Alpha Buyer",
      "country": "LK",
      "createdAt": "2026-02-01T00:00:00.000Z",
      "vehicleCount": 0
    },
    {
      "id": "cust_a1",
      "name": "Iota Buyer",
      "country": null,
      "createdAt": "2026-11-01T14:11:48.464Z",
      "vehicleCount": 0
    },
    {
      "id": "cust_a2",
      "name": "Kappa Buyer",
      "country": null,
      "createdAt": "2026-11-01T14:11:48.464Z",
      "vehicleCount": 0
    }
  ]
}
```

#### GET /api/v1/customers/search

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

Query `q` (max 200, default empty) and the optional `track=FC|FL` of section 5.9 (customers who own a non-deleted vehicle of that effective track; `400` for any other value). At most 20 results, name order, for a customer picker. Same for every role.

Example (200):

```json example:customers.search 200
{
  "data": [
    {
      "id": "cust_1",
      "name": "Alpha Buyer"
    }
  ]
}
```

#### GET /api/v1/customers/:id

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

Example (200):

```json example:customers.get 200
{
  "data": {
    "id": "cust_1",
    "name": "Alpha Buyer"
  }
}
```

#### POST /api/v1/customers

**Roles:** ADMINISTRATOR, MANAGER

Body: `{ "name": string (1-150), "email"?: string|null (valid, stored lower case), "phone"?: string|null (max 30), "country"?: string|null (max 100), "address"?: string|null (max 300) }`. `201` with the full customer row (same keys as `GET /customers` for a non-VIEWER). `409` with `fieldErrors.email` if another account in the organisation already has that email (since 1.5.0 this includes two saves at the same moment; before, the loser got a `500`).

Example (201):

```json example:customers.create 201
{
  "data": {
    "id": "user_1",
    "name": "New Buyer",
    "email": "new.buyer@example.test",
    "phone": "0772222222",
    "country": "LK",
    "address": null,
    "createdAt": "2026-11-01T14:11:48.469Z",
    "vehicleCount": 0
  }
}
```

#### PATCH /api/v1/customers/:id

**Roles:** ADMINISTRATOR, MANAGER

Body (a real PATCH, since 1.3.0): any of `name` (1-150, cannot be cleared), `email`, `phone`, `country`, `address` (the limits of create); at least one. **Only the fields you send change**; an absent field is unchanged, and an explicit `null` or a blank string clears an optional field. Unknown fields (including `orgId`) and an empty body are `400`; another organisation's customer is `404`. Answers the full row. The activity log records only the fields that changed.

Example (200):

```json example:customers.update 200
{
  "data": {
    "id": "cust_1",
    "name": "Alpha Buyer",
    "email": "alpha.buyer@example.test",
    "phone": "0771111111",
    "country": "LK",
    "address": "1 Example Road",
    "createdAt": "2026-02-01T00:00:00.000Z",
    "vehicleCount": 0
  }
}
```

### 5.9 Lookups (dropdown data)

Resources: `brands`, `auction-halls`, `suppliers`, `transport-companies`, `inspection-companies`, `inspection-by`, `packing-agents`, `vehicle-locations` (all `{ id, name }`), `models` (needs `brandId`), `grades` (needs `modelId`), `freight-agents` (`{ id, name, offersRoro, offersContainer }`) and the read-only `row-colour-statuses`. For each resource `X`:

- `GET /lookups/X?q=` , every role: case-insensitive partial match on the name, **at most 20 rows**, name order. `models` also requires `?brandId=`, `grades` requires `?modelId=` (`400` without it).
- **Optional `track=FC|FL`** (since 1.7.0), on every `GET /lookups/X?q=` search above, on `GET /lookups/freight-agents`, `GET /lookups/freight-agents/search` and `GET /lookups/row-colour-statuses`, and also on `GET /customers/search` and `GET /vehicles/destinations`: when present, only values that at least one **non-deleted vehicle of that effective track** in your organisation actually uses are returned, so a filter never offers a value that would show an empty table. The track is the one the vehicle behaves as: an FL vehicle converted to export counts as FC, an FC vehicle converted to local counts as FL (the serial prefix is not used). `models` and `grades` still need their `brandId` / `modelId`, `q` and the 20-row limit apply as before, and the shape of every answer is unchanged. **Without `track` nothing changes: use that for forms, which need the full lists. Use `track` only in the filter bar.** Any other value (`ALL`, lower case, empty, `FC,FL`) is `400 VALIDATION` with `fieldErrors.track`.
- `GET /lookups/X/:id`, every role: one row (use it to label a stored id).
- `POST /lookups/X`, ADMINISTRATOR or MANAGER: body `{ "name": string }` (trimmed, 1-150). **Find-or-create:** a name that exists (case-insensitive) returns the existing row; the answer is `200` in both cases. `models` takes `{ "brandId", "name" }`, `grades` `{ "modelId", "name" }` (the parent must be yours, else `404`), `freight-agents` `{ "name", "offersRoro": boolean, "offersContainer": boolean }` (at least one flag true).
- `PATCH /lookups/X/:id`, ADMINISTRATOR or MANAGER: same body; renames. `409` with `fieldErrors.name` if another row already has that name, including two renames to the same name at the same moment (since 1.5.0 the loser gets this `409`, not a `500`). Names are compared without regard to case when checking, so "Toyota" and "toyota" are the same name.

`GET /lookups/freight-agents/search?q=&method=RORO|CONTAINER` returns the agents whose name matches and who offer that shipping method (omit `method` for all). Use it for the freight-agent picker once a shipping method is chosen.

Each concrete route is listed here so the contract can be checked against the code; the answers are the same for every resource of the same kind.

All concrete lookup routes (every resource, `GET` list, `GET` by id, `POST`, `PATCH`) appear in the role matrix in section 3.

Example (200):

```json example:lookups.list 200
{
  "data": [
    {
      "id": "brand_a1",
      "name": "Alpha Motors"
    }
  ]
}
```
Example (200):

```json example:lookups.get 200
{
  "data": {
    "id": "brand_a1",
    "name": "Alpha Motors"
  }
}
```
Example (200):

```json example:lookups.create 200
{
  "data": {
    "id": "brand_1",
    "name": "Delta Cars"
  }
}
```
Example (200):

```json example:lookups.create.existing 200
{
  "data": {
    "id": "brand_a1",
    "name": "Alpha Motors"
  }
}
```
Example (200):

```json example:lookups.rename 200
{
  "data": {
    "id": "brand_a1",
    "name": "Alpha Motors Ltd"
  }
}
```
Example (200):

```json example:lookups.models 200
{
  "data": [
    {
      "id": "model_a1",
      "name": "Zeta One"
    }
  ]
}
```
Example (200):

```json example:lookups.models.create 200
{
  "data": {
    "id": "vehicleModelRef_1",
    "name": "Zeta Two"
  }
}
```
Example (200):

```json example:lookups.freight-agents 200
{
  "data": [
    {
      "id": "fa_a1",
      "name": "Agent A",
      "offersRoro": true,
      "offersContainer": true
    }
  ]
}
```
Example (200):

```json example:lookups.freight-agents.search 200
{
  "data": [
    {
      "id": "fa_a1",
      "name": "Agent A",
      "offersRoro": true,
      "offersContainer": true
    }
  ]
}
```
Example (200):

```json example:lookups.freight-agents.create 200
{
  "data": {
    "id": "freightAgent_1",
    "name": "Agent B",
    "offersRoro": true,
    "offersContainer": false
  }
}
```

#### GET /api/v1/lookups/row-colour-statuses

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

All row colour statuses, for the colour picker and for painting rows (section 4).

Example (200):

```json example:lookups.row-colours 200
{
  "data": [
    {
      "id": "rc_resold",
      "name": "Resold in Auction",
      "colour": "#ff8800",
      "transportCellOnly": false
    },
    {
      "id": "rc_done",
      "name": "Transport Complete",
      "colour": "#00ff00",
      "transportCellOnly": true
    },
    {
      "id": "rc_cancel",
      "name": "Unit Canceled",
      "colour": "#ff0000",
      "transportCellOnly": false
    }
  ]
}
```

### 5.10 Staff management

Administrators and managers can read the list; only an administrator can change it (and only the super-admin can touch other administrators, section 3).

#### GET /api/v1/staff

**Roles:** ADMINISTRATOR, MANAGER

Optional `q` (name or email, max 200). Name order, not paged.

Example (200):

```json example:staff.list 200
{
  "data": [
    {
      "id": "staff_mgr",
      "name": "Example Manager",
      "email": "manager@example.test",
      "phone": "0770000000",
      "role": "MANAGER",
      "loginEnabled": true,
      "lastActiveAt": "2026-10-30T09:00:00.000Z"
    },
    {
      "id": "staff_op",
      "name": "Example Operator",
      "email": "operator@example.test",
      "phone": "0770000000",
      "role": "OPERATOR",
      "loginEnabled": true,
      "lastActiveAt": "2026-10-30T09:00:00.000Z"
    },
    {
      "id": "staff_vw",
      "name": "Example Viewer",
      "email": "viewer@example.test",
      "phone": "0770000000",
      "role": "VIEWER",
      "loginEnabled": true,
      "lastActiveAt": "2026-10-30T09:00:00.000Z"
    },
    {
      "id": "staff_a1",
      "name": "Staff Actor A",
      "email": null,
      "phone": null,
      "role": null,
      "loginEnabled": null,
      "lastActiveAt": null
    }
  ]
}
```

#### POST /api/v1/staff

**Roles:** ADMINISTRATOR

Body: `{ "name": string (1-150), "email": string, "phone"?: string|null, "role": role, "password": string (12-72 bytes) }`. `201` with the member. `409` with `fieldErrors.email` for a duplicate email; `403`/`400` for the super-admin rules.

Example (201):

```json example:staff.create 201
{
  "data": {
    "id": "user_1",
    "name": "New Operator",
    "email": "new.operator@example.test",
    "phone": null,
    "role": "OPERATOR",
    "loginEnabled": true,
    "lastActiveAt": null
  }
}
```

#### PATCH /api/v1/staff/:id

**Roles:** ADMINISTRATOR

Body (a real PATCH, since 1.3.0): any of `{ "name", "email", "phone": string|null, "role", "active": boolean, "password": string }`, at least one. **Only the fields you send change**: an absent field is unchanged (it does not reset the role or switch the account off), `phone: null` (or blank) clears the phone, and an empty, blank or `null` `password` leaves the password unchanged. Unknown fields and an empty body are `400`. A new password, a deactivation or a role change **revokes that person's sessions**. The activity log records only the fields that changed (a password change is recorded as a flag, never the value).

Example (200):

```json example:staff.update 200
{
  "data": {
    "id": "staff_op",
    "name": "Example Operator",
    "email": "operator@example.test",
    "phone": "0770000000",
    "role": "OPERATOR",
    "loginEnabled": true,
    "lastActiveAt": "2026-10-30T09:00:00.000Z"
  }
}
```

#### POST /api/v1/staff/:id/active

**Roles:** ADMINISTRATOR

Body `{ "active": boolean }`. Deactivating revokes the person's sessions at once. The answer is the member with `loginEnabled` updated.

Example (200):

```json example:staff.active 200
{
  "data": {
    "id": "staff_op",
    "name": "Example Operator",
    "email": "operator@example.test",
    "phone": "0770000000",
    "role": "OPERATOR",
    "loginEnabled": false,
    "lastActiveAt": "2026-10-30T09:00:00.000Z"
  }
}
```

---

### 5.11 Dashboard

Both are computed on the server for the whole organisation (FC and FL, effective values). No query parameters.

#### GET /api/v1/dashboard/stats

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

Counts and short lists for the home screen. `pendingFc`, `bookingReceivedFc` and `shippedFc` are the FC status counts; `pendingVehicles` and `bookingReceivedVehicles` are short lists of `{ id, serial, brand, model, yom, customerName }` (open one with the serial); `trackSplit` is `{ fc, fl }`; each `...Distribution` array is `{ id?, name | status, count }` ready for a chart. `unpaidAuctionBills` lists vehicles whose bill is not paid. `transportCompleteStatusId` is the id of the "Transport Complete" row colour (or `null` if the organisation has none): the "In Progress" transport bar is `GET /vehicles?rowColourNot=<that id>`. Empty arrays are normal for a new organisation, so the example shows some of them empty; treat each array as `[{...}]` with the keys the matching list shows.

Example (200):

```json example:dashboard.stats 200
{
  "data": {
    "totalVehicles": 10,
    "pendingFc": 2,
    "bookingReceivedFc": 2,
    "shippedFc": 2,
    "pendingVehicles": [
      {
        "id": "v_fc_pending",
        "serial": "FC101",
        "brand": "Alpha Motors",
        "model": "Zeta One",
        "yom": 2020,
        "customerName": "Iota Buyer"
      },
      {
        "id": "v_fc_to_local",
        "serial": "FC107",
        "brand": "Alpha Motors",
        "model": "Zeta One",
        "yom": null,
        "customerName": null
      }
    ],
    "bookingReceivedVehicles": [
      {
        "id": "v_fc_booked_future",
        "serial": "FC102",
        "brand": "Beta Autos",
        "model": "Eta Two",
        "yom": null,
        "customerName": "Kappa Buyer"
      },
      {
        "id": "v_fl_to_export",
        "serial": "FL202",
        "brand": "Alpha Motors",
        "model": "Zeta One",
        "yom": null,
        "customerName": null
      }
    ],
    "trackSplit": {
      "fc": 9,
      "fl": 1
    },
    "shipmentStatusDistribution": [
      {
        "status": "PENDING",
        "count": 2
      },
      {
        "status": "BOOKING_RECEIVED",
        "count": 2
      },
      {
        "status": "SHIPPED",
        "count": 2
      }
    ],
    "exportVolumeByDestination": [],
    "transportByCompany": [],
    "transportCompleteStatusId": null,
    "vehicleLocationDistribution": [],
    "transportByDistribution": [],
    "freightAgentDistribution": [
      {
        "id": "fa_a1",
        "name": "Agent A",
        "count": 1
      }
    ],
    "shippingMethodDistribution": [],
    "brandDistribution": [
      {
        "id": "brand_a1",
        "name": "Alpha Motors",
        "count": 8
      },
      {
        "id": "brand_a2",
        "name": "Beta Autos",
        "count": 2
      }
    ],
    "unpaidAuctionBills": [
      {
        "id": "v_fc_pending",
        "serial": "FC101",
        "brand": "Alpha Motors",
        "model": "Zeta One",
        "yom": 2020,
        "customerName": "Iota Buyer"
      },
      {
        "id": "v_fc_booked_past",
        "serial": "FC103",
        "brand": "Alpha Motors",
        "model": "Zeta One",
        "yom": null,
        "customerName": null
      },
      {
        "id": "v_fc_shipped",
        "serial": "FC104",
        "brand": "Alpha Motors",
        "model": "Zeta One",
        "yom": null,
        "customerName": null
      },
      {
        "id": "v_fc_to_local",
        "serial": "FC107",
        "brand": "Alpha Motors",
        "model": "Zeta One",
        "yom": null,
        "customerName": null
      },
      {
        "id": "v_fl_to_export",
        "serial": "FL202",
        "brand": "Alpha Motors",
        "model": "Zeta One",
        "yom": null,
        "customerName": null
      }
    ]
  }
}
```

#### GET /api/v1/dashboard/trends

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

Monthly series for charts (`month` is a label such as `Oct 2026`).

Example (200):

```json example:dashboard.trends 200
{
  "data": {
    "bookingsVsArrivals": [
      {
        "month": "Sep 2026",
        "bookings": 1,
        "arrivals": 0
      },
      {
        "month": "Oct 2026",
        "bookings": 2,
        "arrivals": 0
      },
      {
        "month": "Nov 2026",
        "bookings": 3,
        "arrivals": 0
      }
    ],
    "vehiclesEntered": [
      {
        "month": "Nov 2026",
        "count": 10
      }
    ],
    "cumulativeGrowth": [
      {
        "month": "Nov 2026",
        "total": 10
      }
    ],
    "docsTurnaround": []
  }
}
```

### 5.12 Reports

Each report takes `track` (`FC` default, or `FL`) except `by-freight-agent`. Every report groups the same vehicle summary `{ id, serial, vehicleLabel, chassisNo, auctionLotNo, auctionHallName, destination, customerName, freightAgentName, shippingMethod, etd, eta, status }` (`status` is the effective status) and a `statusCounts` object with the four statuses.

#### GET /api/v1/reports/by-customer

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

Groups by customer. Each group has `customerId, customerName, country, vehicles, statusCounts` and, **except for a VIEWER**, `email` and `phone`. `customerOptions`, `destinationOptions` and `auctionHallOptions` feed the report's filters.

Example (200):

```json example:reports.by-customer 200
{
  "data": {
    "customers": [
      {
        "customerId": "cust_a1",
        "customerName": "Iota Buyer",
        "email": null,
        "phone": null,
        "country": null,
        "vehicles": [
          {
            "id": "v_fc_pending",
            "serial": "FC101",
            "vehicleLabel": "2020 Alpha Motors Zeta One",
            "chassisNo": "CHASSIS-AAA-1",
            "auctionLotNo": null,
            "auctionHallName": null,
            "destination": "Country One",
            "customerName": "Iota Buyer",
            "freightAgentName": "Agent A",
            "shippingMethod": null,
            "etd": null,
            "eta": null,
            "status": "PENDING"
          }
        ],
        "statusCounts": {
          "PENDING": 1,
          "BOOKING_RECEIVED": 0,
          "SHIPPED": 0,
          "CANCELLED": 0
        }
      },
      {
        "customerId": "cust_a2",
        "customerName": "Kappa Buyer",
        "email": null,
        "phone": null,
        "country": null,
        "vehicles": [
          {
            "id": "v_fc_booked_future",
            "serial": "FC102",
            "vehicleLabel": "Beta Autos Eta Two",
            "chassisNo": "CHASSIS-AAA-2",
            "auctionLotNo": null,
            "auctionHallName": null,
            "destination": "Country Two",
            "customerName": "Kappa Buyer",
            "freightAgentName": null,
            "shippingMethod": null,
            "etd": "2026-11-10T18:30:00.000Z",
            "eta": null,
            "status": "BOOKING_RECEIVED"
          }
        ],
        "statusCounts": {
          "PENDING": 0,
          "BOOKING_RECEIVED": 1,
          "SHIPPED": 0,
          "CANCELLED": 0
        }
      }
    ],
    "customerOptions": [
      {
        "id": "cust_a1",
        "name": "Iota Buyer"
      },
      {
        "id": "cust_a2",
        "name": "Kappa Buyer"
      }
    ],
    "destinationOptions": [
      "Country One",
      "Country Two"
    ],
    "auctionHallOptions": []
  }
}
```
Example (200):

```json example:reports.by-customer.viewer 200
{
  "data": {
    "customers": [
      {
        "customerId": "cust_a1",
        "customerName": "Iota Buyer",
        "country": null,
        "vehicles": [
          {
            "id": "v_fc_pending",
            "serial": "FC101",
            "vehicleLabel": "2020 Alpha Motors Zeta One",
            "chassisNo": "CHASSIS-AAA-1",
            "auctionLotNo": null,
            "auctionHallName": null,
            "destination": "Country One",
            "customerName": "Iota Buyer",
            "freightAgentName": "Agent A",
            "shippingMethod": null,
            "etd": null,
            "eta": null,
            "status": "PENDING"
          }
        ],
        "statusCounts": {
          "PENDING": 1,
          "BOOKING_RECEIVED": 0,
          "SHIPPED": 0,
          "CANCELLED": 0
        }
      },
      {
        "customerId": "cust_a2",
        "customerName": "Kappa Buyer",
        "country": null,
        "vehicles": [
          {
            "id": "v_fc_booked_future",
            "serial": "FC102",
            "vehicleLabel": "Beta Autos Eta Two",
            "chassisNo": "CHASSIS-AAA-2",
            "auctionLotNo": null,
            "auctionHallName": null,
            "destination": "Country Two",
            "customerName": "Kappa Buyer",
            "freightAgentName": null,
            "shippingMethod": null,
            "etd": "2026-11-10T18:30:00.000Z",
            "eta": null,
            "status": "BOOKING_RECEIVED"
          }
        ],
        "statusCounts": {
          "PENDING": 0,
          "BOOKING_RECEIVED": 1,
          "SHIPPED": 0,
          "CANCELLED": 0
        }
      }
    ],
    "customerOptions": [
      {
        "id": "cust_a1",
        "name": "Iota Buyer"
      },
      {
        "id": "cust_a2",
        "name": "Kappa Buyer"
      }
    ],
    "destinationOptions": [
      "Country One",
      "Country Two"
    ],
    "auctionHallOptions": []
  }
}
```

#### GET /api/v1/reports/by-auction-hall

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

`{ auctionHalls: [{ ...group }], auctionHallOptions }`; the example is empty because the fake data has no auction-hall vehicles. A group has `auctionHallId, auctionHallName, vehicles, statusCounts`.

Example (200):

```json example:reports.by-auction-hall 200
{
  "data": {
    "auctionHalls": [],
    "auctionHallOptions": []
  }
}
```

#### GET /api/v1/reports/by-destination

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

Example (200):

```json example:reports.by-destination 200
{
  "data": {
    "destinations": [
      {
        "destination": "Country One",
        "vehicles": [
          {
            "id": "v_fc_pending",
            "serial": "FC101",
            "vehicleLabel": "2020 Alpha Motors Zeta One",
            "chassisNo": "CHASSIS-AAA-1",
            "auctionLotNo": null,
            "auctionHallName": null,
            "destination": "Country One",
            "customerName": "Iota Buyer",
            "freightAgentName": "Agent A",
            "shippingMethod": null,
            "etd": null,
            "eta": null,
            "status": "PENDING"
          },
          {
            "id": "v_fc_booked_past",
            "serial": "FC103",
            "vehicleLabel": "Alpha Motors Zeta One",
            "chassisNo": "CHASSIS-AAA-3",
            "auctionLotNo": null,
            "auctionHallName": null,
            "destination": "Country One",
            "customerName": null,
            "freightAgentName": null,
            "shippingMethod": null,
            "etd": "2026-10-26T18:30:00.000Z",
            "eta": null,
            "status": "SHIPPED"
          }
        ],
        "statusCounts": {
          "PENDING": 1,
          "BOOKING_RECEIVED": 0,
          "SHIPPED": 1,
          "CANCELLED": 0
        }
      },
      {
        "destination": "Country Two",
        "vehicles": [
          {
            "id": "v_fc_booked_future",
            "serial": "FC102",
            "vehicleLabel": "Beta Autos Eta Two",
            "chassisNo": "CHASSIS-AAA-2",
            "auctionLotNo": null,
            "auctionHallName": null,
            "destination": "Country Two",
            "customerName": "Kappa Buyer",
            "freightAgentName": null,
            "shippingMethod": null,
            "etd": "2026-11-10T18:30:00.000Z",
            "eta": null,
            "status": "BOOKING_RECEIVED"
          },
          {
            "id": "v_fl_to_export",
            "serial": "FL202",
            "vehicleLabel": "Alpha Motors Zeta One",
            "chassisNo": "CHASSIS-LLL-2",
            "auctionLotNo": null,
            "auctionHallName": null,
            "destination": "Country Two",
            "customerName": null,
            "freightAgentName": null,
            "shippingMethod": null,
            "etd": "2026-11-07T18:30:00.000Z",
            "eta": null,
            "status": "BOOKING_RECEIVED"
          }
        ],
        "statusCounts": {
          "PENDING": 0,
          "BOOKING_RECEIVED": 2,
          "SHIPPED": 0,
          "CANCELLED": 0
        }
      }
    ],
    "destinationOptions": [
      "Country One",
      "Country Two"
    ]
  }
}
```

#### GET /api/v1/reports/by-freight-agent

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

Example (200):

```json example:reports.by-freight-agent 200
{
  "data": {
    "freightAgents": [
      {
        "freightAgentId": "fa_a1",
        "freightAgentName": "Agent A",
        "vehicles": [
          {
            "id": "v_fc_pending",
            "serial": "FC101",
            "vehicleLabel": "2020 Alpha Motors Zeta One",
            "chassisNo": "CHASSIS-AAA-1",
            "auctionLotNo": null,
            "auctionHallName": null,
            "destination": "Country One",
            "customerName": "Iota Buyer",
            "freightAgentName": "Agent A",
            "shippingMethod": null,
            "etd": null,
            "eta": null,
            "status": "PENDING"
          }
        ],
        "statusCounts": {
          "PENDING": 1,
          "BOOKING_RECEIVED": 0,
          "SHIPPED": 0,
          "CANCELLED": 0
        }
      }
    ],
    "freightAgentOptions": [
      {
        "id": "fa_a1",
        "name": "Agent A"
      }
    ]
  }
}
```

### 5.13 Activity log (ADMINISTRATOR)

#### GET /api/v1/activity-log

**Roles:** ADMINISTRATOR

Newest first. Query: `page`, `pageSize` (section 1), `entity`, `entityId`, `actorId`, `action` (exact text, each up to 100), `dateFrom`, `dateTo` (dates or timestamps, both ends included; a bare date means midnight UTC, so send the end of the day for `dateTo`). `before` and `after` are JSON snapshots (or `null`). **Storage addresses, object keys, bucket names and the storage account id are replaced with `[file address removed]`, `[file key removed]` or `[storage name removed]` when you read the log**, including in old rows; new file entries hold the file id, kind and name only. `actorName` is the actor's display name.

Example (200):

```json example:activity-log.list 200
{
  "data": {
    "rows": [
      {
        "id": "al_1",
        "actorId": "staff_mgr",
        "actorName": "Example Manager",
        "action": "UPDATE_VEHICLE",
        "entity": "Vehicle",
        "entityId": "v_fc_booked_future",
        "before": {
          "destination": "Country One"
        },
        "after": {
          "destination": "Country Two"
        },
        "createdAt": "2026-10-30T08:00:00.000Z"
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 50,
    "totalPages": 1
  }
}
```

#### GET /api/v1/activity-log/filters

**Roles:** ADMINISTRATOR

The distinct `entity` and `action` values in use, for the filter dropdowns.

Example (200):

```json example:activity-log.filters 200
{
  "data": {
    "entities": [
      "Vehicle"
    ],
    "actions": [
      "UPDATE_VEHICLE"
    ]
  }
}
```

### 5.14 Notifications and push devices

Every call acts on the signed-in person only. These are the catch-up path for the live stream (section 7).

#### GET /api/v1/notifications

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

Newest first, paged (section 1; default `pageSize` 50). `vehicleSerial` is `null` when there is no linked vehicle or it was deleted; use it to open the vehicle (`vehicleId` is not what the detail route takes). `event` is a machine name such as `BOOKING_RECEIVED`, `SHIPPED`, `PHOTOS_ADDED`, `DOCUMENTS_READY`, `VEHICLE_PURCHASED`, `AUCTION_BILL_PAID`, `DOCUMENT_UPLOADED`, `PAYMENT_REMINDER`, `RIKSO_REMINDER`, `LC_REMINDER`, `ETD_APPROACHING`, `MISSING_DOCUMENTS`, `SHIPMENT_REVERTED_TO_PENDING`, `VEHICLE_LINK_REQUESTED`, `LINK_REQUEST_APPROVED`, `LINK_REQUEST_REJECTED`, `ARRIVAL_NOT_RECORDED`, `NEW_STOCK`, `ENQUIRY_RECEIVED`, `CHAT_MESSAGE`; treat an unknown `event` as a generic notification.

Example (200):

```json example:notifications.list 200
{
  "data": {
    "rows": [
      {
        "id": "n_1",
        "event": "BOOKING_RECEIVED",
        "title": "Booking received",
        "body": "FC102 now has a booking.",
        "isRead": false,
        "vehicleId": "v_fc_booked_future",
        "createdAt": "2026-10-30T10:00:00.000Z",
        "vehicleSerial": "FC102"
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 50,
    "totalPages": 1
  }
}
```

#### GET /api/v1/notifications/unread-count

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

Example (200):

```json example:notifications.unread 200
{
  "data": {
    "count": 1
  }
}
```

#### POST /api/v1/notifications/:id/read

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

No body. **Idempotent:** an id that is not yours, or already read, changes nothing and still answers `200`.

Example (200):

```json example:notifications.read 200
{
  "data": {
    "read": true
  }
}
```

#### POST /api/v1/notifications/read-all

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

No body. Marks all of your notifications read.

Example (200):

```json example:notifications.read-all 200
{
  "data": {
    "read": true
  }
}
```

#### POST /api/v1/device-tokens

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

Register a phone for push. Body `{ "expoPushToken": string, "platform": "ios" | "android" }`. A token moves to the most recent person who registers it (shared phones). The web app does not need this.

Example (200):

```json example:device-tokens.register 200
{
  "data": {
    "id": "deviceToken_1",
    "expoPushToken": "ExponentPushToken[example-new]",
    "platform": "ios",
    "lastSeenAt": "2026-11-01T14:11:48.775Z"
  }
}
```

#### DELETE /api/v1/device-tokens

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER

Body `{ "expoPushToken": string }`. Idempotent. Token values are never written to logs or error messages.

Example (200):

```json example:device-tokens.unregister 200
{
  "data": {
    "unregistered": true
  }
}
```

### 5.15 Customer administration (ADMINISTRATOR, MANAGER)

These manage the customers' own sign-in (the customer app) and what they see.

#### PATCH /api/v1/customers/:id/login-access

**Roles:** ADMINISTRATOR, MANAGER

Body `{ "loginEnabled": boolean }` (strict). Switching it on needs an email address on the customer (`400` with `fieldErrors.loginEnabled` otherwise). The customer then sets a password through the customer app.

Example (200):

```json example:customers.login-access 200
{
  "data": {
    "id": "cust_1",
    "loginEnabled": false
  }
}
```

#### PATCH /api/v1/customers/:id/agent

**Roles:** ADMINISTRATOR, MANAGER

Body `{ "agentId": string | null }` (strict): the staff member who answers this customer's chat. Must be an active staff member (`400` with `fieldErrors.agentId`), or `null` to clear it.

Example (200):

```json example:customers.agent 200
{
  "data": {
    "id": "cust_1",
    "assignedAgentId": "staff_op"
  }
}
```

#### GET /api/v1/staff/customers/active

**Roles:** ADMINISTRATOR, MANAGER

Customers active in the app in the last few minutes (at most 200, most recent first): `[{ id, name, companyName, lastActiveAt }]`.

Example (200):

```json example:customers.active 200
{
  "data": [
    {
      "id": "cust_1",
      "name": "Alpha Buyer",
      "companyName": null,
      "lastActiveAt": "2026-11-01T14:11:48.474Z"
    }
  ]
}
```

#### GET /api/v1/link-requests

**Roles:** ADMINISTRATOR, MANAGER

Requests from customers to be linked to a vehicle by serial. Query (strict): `status` (`PENDING` default, `APPROVED`, `REJECTED`), `page`, `pageSize` (1-50, default 20). `matchedVehicle` is the vehicle the entered serial matches (or `null`) with flags saying whether it already belongs to this customer or another one.

Example (200):

```json example:link-requests.list 200
{
  "data": {
    "rows": [
      {
        "id": "lr_1",
        "status": "PENDING",
        "serialEntered": "FC104",
        "createdAt": "2026-10-29T00:00:00.000Z",
        "decidedAt": null,
        "customer": {
          "id": "cust_1",
          "name": "Alpha Buyer",
          "email": "alpha.buyer@example.test",
          "companyName": null
        },
        "vehicle": {
          "id": "v_fc_shipped",
          "serial": "FC104"
        },
        "matchedVehicle": {
          "id": "v_fc_shipped",
          "serial": "FC104",
          "ownedByThisCustomer": false,
          "ownedByAnotherCustomer": false
        }
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 20
  }
}
```

#### POST /api/v1/link-requests/:id/approve

**Roles:** ADMINISTRATOR, MANAGER

Body `{ "vehicleId"?: string }` (strict; to link a different vehicle than the one the serial matched). `409` if the request was already decided or the vehicle is linked to another customer. The customer is notified.

Example (200):

```json example:link-requests.approve 200
{
  "data": {
    "id": "lr_1",
    "status": "APPROVED",
    "vehicle": {
      "id": "v_fc_shipped",
      "serial": "FC104"
    }
  }
}
```

#### POST /api/v1/link-requests/:id/reject

**Roles:** ADMINISTRATOR, MANAGER

Body `{ "reason"?: string (plain text, max 500) }` (strict). The reason reaches the customer as a chat message from staff.

Example (200):

```json example:link-requests.reject 200
{
  "data": {
    "id": "lr_1",
    "status": "REJECTED"
  }
}
```

#### GET /api/v1/faqs

**Roles:** ADMINISTRATOR, MANAGER

All FAQs including unpublished drafts, in `sortOrder`.

Example (200):

```json example:faqs.list 200
{
  "data": [
    {
      "id": "faq_1",
      "question": "How long does shipping take?",
      "answer": "About four weeks.",
      "sortOrder": 1,
      "published": true
    }
  ]
}
```

#### POST /api/v1/faqs

**Roles:** ADMINISTRATOR, MANAGER

Body (strict): `{ "question": string (1-500), "answer": string (1-5000), "sortOrder"?: integer 0-10000 (default 0), "published"?: boolean (default true) }`. `201`.

Example (201):

```json example:faqs.create 201
{
  "data": {
    "id": "faq_1",
    "question": "Can I visit the yard?",
    "answer": "Yes, by appointment.",
    "sortOrder": 2,
    "published": true
  }
}
```

#### PATCH /api/v1/faqs/:id

**Roles:** ADMINISTRATOR, MANAGER

Body: any of the four fields (strict, at least one).

Example (200):

```json example:faqs.update 200
{
  "data": {
    "id": "faq_1",
    "question": "How long does shipping take?",
    "answer": "About four weeks.",
    "sortOrder": 1,
    "published": false
  }
}
```

#### DELETE /api/v1/faqs/:id

**Roles:** ADMINISTRATOR, MANAGER

Example (200):

```json example:faqs.delete 200
{
  "data": {
    "deleted": true
  }
}
```

### 5.16 Customer chat (ADMINISTRATOR, MANAGER, OPERATOR)

Staff answer customers' questions. See the role matrix: an OPERATOR sees only the conversations of customers assigned to them. VIEWER: `403`. Customers write from the customer app; staff cannot start a conversation.

#### GET /api/v1/chat/conversations

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR (scoped to assigned customers)

The inbox. Query (strict): `page`, `pageSize` (1-50, default 20), `status` (`open` default, `handled`, `all`). Newest activity first. Each row has `unreadCount` (since 1.9.0): the customer messages that no staff member has read yet. The read marker is **one per conversation, shared by all staff who can see it**: when anyone calls `POST .../read`, it is read for everyone. A conversation that existed before 1.9.0 shows all its customer messages as unread until someone opens it once.

Example (200):

```json example:chat.inbox 200
{
  "data": {
    "rows": [
      {
        "id": "conv_1",
        "customer": {
          "id": "cust_1",
          "name": "Alpha Buyer",
          "companyName": null
        },
        "vehicle": {
          "id": "v_fc_pending",
          "serial": "FC101"
        },
        "lastMessageAt": "2026-10-30T12:00:00.000Z",
        "handled": false,
        "lastMessage": {
          "senderType": "CUSTOMER",
          "snippet": "Where is my vehicle now?",
          "createdAt": "2026-10-30T12:00:00.000Z"
        },
        "unreadCount": 1
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 20
  }
}
```

#### GET /api/v1/chat/conversations/:id/messages

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR (scoped to assigned customers)

Query (strict): `page`, `pageSize` (1-50, default 20). `senderType` is `CUSTOMER` or `STAFF`; `senderName` is the staff member's name for a `STAFF` message and `null` for a customer's message.

Example (200):

```json example:chat.messages 200
{
  "data": {
    "conversation": {
      "id": "conv_1",
      "customer": {
        "id": "cust_1",
        "name": "Alpha Buyer"
      },
      "vehicle": {
        "id": "v_fc_pending",
        "serial": "FC101"
      },
      "handled": false
    },
    "rows": [
      {
        "id": "msg_1",
        "senderType": "CUSTOMER",
        "senderName": null,
        "body": "Where is my vehicle now?",
        "createdAt": "2026-10-30T12:00:00.000Z"
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 20
  }
}
```

#### POST /api/v1/chat/conversations/:id/messages

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR (scoped to assigned customers)

Body `{ "body": string }` (strict; plain text, 1 to 2000 characters after trimming, no control characters). `201`. The customer gets an alert and, if they are connected, a live event.

Example (201):

```json example:chat.reply 201
{
  "data": {
    "id": "message_1",
    "senderType": "STAFF",
    "body": "It left the port yesterday.",
    "createdAt": "2026-11-01T14:11:48.799Z"
  }
}
```

#### POST /api/v1/chat/conversations/:id/handled

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR (scoped to assigned customers)

Body `{ "handled": boolean }` (strict). Marks the conversation handled or open.

Example (200):

```json example:chat.handled 200
{
  "data": {
    "id": "conv_1",
    "handled": true
  }
}
```

#### POST /api/v1/chat/conversations/:id/read

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR (scoped to assigned customers)

No body. Call it when a staff member opens the conversation: every customer message up to now becomes read for staff, and `unreadCount` in the inbox goes to 0 until the customer writes again. It never changes the customer's own unread count. Calling it again is harmless; the marker never moves backwards. Writes ActivityLog `MARK_CHAT_READ` (no text). A conversation out of scope (another agent's customer, another org, an unknown id) is `404 Conversation not found.`

Example (200):

```json example:chat.read 200
{
  "data": {
    "id": "conv_1",
    "unreadCount": 0
  }
}
```

### 5.17 Public stock and website enquiries (ADMINISTRATOR, MANAGER)

The vehicles for sale on the public website, and the messages visitors send. These routes **exist only when the operator has switched the public stock on** (`PUBLIC_STOCK_ENABLED`); otherwise they answer `404 Route not found.` A listing is `DRAFT`, `PUBLISHED` or `SOLD`. Prices are whole numbers in one currency (the API says `LKR`) as `price: { amount, currency }`, or `null`.

#### GET /api/v1/stock

**Roles:** ADMINISTRATOR, MANAGER

Query (strict): `page`, `pageSize` (1-50, default 20), `status` (`DRAFT`, `PUBLISHED`, `SOLD`). Items have the same keys as the detail (`images` is a list of the listing's images).

Example (200):

```json example:stock.list 200
{
  "data": {
    "rows": [
      {
        "id": "stock_2",
        "slug": "beta-two-2019-def456",
        "status": "PUBLISHED",
        "make": "Beta",
        "model": "Two",
        "year": 2019,
        "price": {
          "amount": 1200000,
          "currency": "LKR"
        },
        "mileageKm": 60000,
        "bodyType": "SUV",
        "fuel": "Diesel",
        "transmission": "Manual",
        "colour": "Blue",
        "description": null,
        "publishedAt": "2026-10-25T00:00:00.000Z",
        "images": []
      },
      {
        "id": "stock_1",
        "slug": "alpha-one-2020-abc123",
        "status": "DRAFT",
        "make": "Alpha",
        "model": "One",
        "year": 2020,
        "price": {
          "amount": 1500000,
          "currency": "LKR"
        },
        "mileageKm": 42000,
        "bodyType": "Sedan",
        "fuel": "Petrol",
        "transmission": "Automatic",
        "colour": "White",
        "description": "Example listing.",
        "publishedAt": null,
        "images": [
          {
            "id": "simg_1",
            "url": "https://img.example.test/stock/15207a1250a022d4/00000001-0000-4000-8000-000000000000.jpg",
            "altText": "Side view",
            "sortOrder": 0
          }
        ]
      }
    ],
    "total": 2,
    "page": 1,
    "pageSize": 20
  }
}
```

#### POST /api/v1/stock

**Roles:** ADMINISTRATOR, MANAGER

Body (strict): `{ "make": string (1-60), "model": string (1-80), "year"?: integer 1950-2100|null, "price"?: whole number > 0|null, "mileageKm"?: integer 0-5,000,000|null, "bodyType"?, "fuel"?, "transmission"?, "colour"?: string max 40|null, "description"?: string max 5000|null }`. `201` with the new listing as a DRAFT with no images.

Example (201):

```json example:stock.create 201
{
  "data": {
    "id": "stockVehicle_1",
    "slug": "beta-two-2019-06729f",
    "status": "DRAFT",
    "make": "Beta",
    "model": "Two",
    "year": 2019,
    "price": {
      "amount": 1200000,
      "currency": "LKR"
    },
    "mileageKm": 60000,
    "bodyType": "SUV",
    "fuel": "Diesel",
    "transmission": "Manual",
    "colour": "Blue",
    "description": "Another example.",
    "publishedAt": null,
    "images": []
  }
}
```

#### GET /api/v1/stock/:id

**Roles:** ADMINISTRATOR, MANAGER

Example (200):

```json example:stock.get 200
{
  "data": {
    "id": "stock_1",
    "slug": "alpha-one-2020-abc123",
    "status": "DRAFT",
    "make": "Alpha",
    "model": "One",
    "year": 2020,
    "price": {
      "amount": 1500000,
      "currency": "LKR"
    },
    "mileageKm": 42000,
    "bodyType": "Sedan",
    "fuel": "Petrol",
    "transmission": "Automatic",
    "colour": "White",
    "description": "Example listing.",
    "publishedAt": null,
    "images": [
      {
        "id": "simg_1",
        "url": "https://img.example.test/stock/15207a1250a022d4/00000001-0000-4000-8000-000000000000.jpg",
        "altText": "Side view",
        "sortOrder": 0
      }
    ]
  }
}
```

#### PATCH /api/v1/stock/:id

**Roles:** ADMINISTRATOR, MANAGER

Body: any of the create fields (strict, at least one). Answers the listing.

Example (200):

```json example:stock.update 200
{
  "data": {
    "id": "stock_1",
    "slug": "alpha-one-2020-abc123",
    "status": "DRAFT",
    "make": "Alpha",
    "model": "One",
    "year": 2020,
    "price": {
      "amount": 1450000,
      "currency": "LKR"
    },
    "mileageKm": 42000,
    "bodyType": "Sedan",
    "fuel": "Petrol",
    "transmission": "Automatic",
    "colour": "White",
    "description": "Example listing.",
    "publishedAt": null,
    "images": [
      {
        "id": "simg_1",
        "url": "https://img.example.test/stock/15207a1250a022d4/00000001-0000-4000-8000-000000000000.jpg",
        "altText": "Side view",
        "sortOrder": 0
      }
    ]
  }
}
```

#### DELETE /api/v1/stock/:id

**Roles:** ADMINISTRATOR, MANAGER

Example (200):

```json example:stock.delete 200
{
  "data": {
    "deleted": true
  }
}
```

#### POST /api/v1/stock/:id/publish

**Roles:** ADMINISTRATOR, MANAGER

Body `{ "notifyCustomers"?: boolean }` (strict). Only a `DRAFT` with at least one image (`400` with `fieldErrors.images` otherwise); any other status is `409`.

Example (200):

```json example:stock.publish 200
{
  "data": {
    "id": "stock_1",
    "slug": "alpha-one-2020-abc123",
    "status": "PUBLISHED",
    "make": "Alpha",
    "model": "One",
    "year": 2020,
    "price": {
      "amount": 1500000,
      "currency": "LKR"
    },
    "mileageKm": 42000,
    "bodyType": "Sedan",
    "fuel": "Petrol",
    "transmission": "Automatic",
    "colour": "White",
    "description": "Example listing.",
    "publishedAt": "2026-11-01T14:11:48.815Z",
    "images": [
      {
        "id": "simg_1",
        "url": "https://img.example.test/stock/15207a1250a022d4/00000001-0000-4000-8000-000000000000.jpg",
        "altText": "Side view",
        "sortOrder": 0
      }
    ]
  }
}
```

#### POST /api/v1/stock/:id/unpublish

**Roles:** ADMINISTRATOR, MANAGER

Body `{}` (strict). From `PUBLISHED` or `SOLD` back to `DRAFT`.

Example (200):

```json example:stock.unpublish 200
{
  "data": {
    "id": "stock_2",
    "slug": "beta-two-2019-def456",
    "status": "DRAFT",
    "make": "Beta",
    "model": "Two",
    "year": 2019,
    "price": {
      "amount": 1200000,
      "currency": "LKR"
    },
    "mileageKm": 60000,
    "bodyType": "SUV",
    "fuel": "Diesel",
    "transmission": "Manual",
    "colour": "Blue",
    "description": null,
    "publishedAt": null,
    "images": []
  }
}
```

#### POST /api/v1/stock/:id/mark-sold

**Roles:** ADMINISTRATOR, MANAGER

Body `{}` (strict). Only from `PUBLISHED` (`409` otherwise).

Example (200):

```json example:stock.mark-sold 200
{
  "data": {
    "id": "stock_2",
    "slug": "beta-two-2019-def456",
    "status": "SOLD",
    "make": "Beta",
    "model": "Two",
    "year": 2019,
    "price": {
      "amount": 1200000,
      "currency": "LKR"
    },
    "mileageKm": 60000,
    "bodyType": "SUV",
    "fuel": "Diesel",
    "transmission": "Manual",
    "colour": "Blue",
    "description": null,
    "publishedAt": "2026-10-25T00:00:00.000Z",
    "images": []
  }
}
```

#### POST /api/v1/stock/:id/images/presign

**Roles:** ADMINISTRATOR, MANAGER

Step one of a stock image upload (public bucket, section 6). Body `{ "contentType": "image/jpeg"|"image/png"|"image/webp", "fileSize": integer up to 8 MB }` (strict). **This is the one answer that contains a `publicUrl`**: stock images are public by design.

Example (200):

```json example:stock.images.presign 200
{
  "data": {
    "uploadUrl": "https://storage.example.test/bucket/stock/15207a1250a022d4/312b75a9-74cd-46b7-b7d2-2af7d6fb2507.jpg?X-Signature=<signature>",
    "key": "stock/15207a1250a022d4/312b75a9-74cd-46b7-b7d2-2af7d6fb2507.jpg",
    "publicUrl": "https://img.example.test/stock/15207a1250a022d4/312b75a9-74cd-46b7-b7d2-2af7d6fb2507.jpg",
    "expiresInSeconds": 300,
    "headers": {
      "Content-Type": "image/jpeg"
    }
  }
}
```

#### POST /api/v1/stock/:id/images

**Roles:** ADMINISTRATOR, MANAGER

Step three: body `{ "key": string, "altText"?: string|null (max 200) }` (strict). The key must be one this API issued for your organisation (`400` otherwise); at most 20 images per listing (`409`). `201` with the whole listing.

Example (201):

```json example:stock.images.add 201
{
  "data": {
    "id": "stock_1",
    "slug": "alpha-one-2020-abc123",
    "status": "DRAFT",
    "make": "Alpha",
    "model": "One",
    "year": 2020,
    "price": {
      "amount": 1500000,
      "currency": "LKR"
    },
    "mileageKm": 42000,
    "bodyType": "Sedan",
    "fuel": "Petrol",
    "transmission": "Automatic",
    "colour": "White",
    "description": "Example listing.",
    "publishedAt": null,
    "images": [
      {
        "id": "simg_1",
        "url": "https://img.example.test/stock/15207a1250a022d4/00000001-0000-4000-8000-000000000000.jpg",
        "altText": "Side view",
        "sortOrder": 0
      },
      {
        "id": "stockImage_1",
        "url": "https://img.example.test/stock/15207a1250a022d4/00000002-0000-4000-8000-000000000000.jpg",
        "altText": "Rear view",
        "sortOrder": 1
      }
    ]
  }
}
```

#### POST /api/v1/stock/:id/images/reorder

**Roles:** ADMINISTRATOR, MANAGER

Body `{ "imageIds": string[] }` (strict): every image of the listing exactly once, in the new order.

Example (200):

```json example:stock.images.reorder 200
{
  "data": {
    "id": "stock_1",
    "slug": "alpha-one-2020-abc123",
    "status": "DRAFT",
    "make": "Alpha",
    "model": "One",
    "year": 2020,
    "price": {
      "amount": 1500000,
      "currency": "LKR"
    },
    "mileageKm": 42000,
    "bodyType": "Sedan",
    "fuel": "Petrol",
    "transmission": "Automatic",
    "colour": "White",
    "description": "Example listing.",
    "publishedAt": null,
    "images": [
      {
        "id": "simg_1",
        "url": "https://img.example.test/stock/15207a1250a022d4/00000001-0000-4000-8000-000000000000.jpg",
        "altText": "Side view",
        "sortOrder": 0
      }
    ]
  }
}
```

#### PATCH /api/v1/stock/:id/images/:imageId

**Roles:** ADMINISTRATOR, MANAGER

Body `{ "altText"?: string|null, "sortOrder"?: integer }` (strict, at least one).

Example (200):

```json example:stock.images.update 200
{
  "data": {
    "id": "stock_1",
    "slug": "alpha-one-2020-abc123",
    "status": "DRAFT",
    "make": "Alpha",
    "model": "One",
    "year": 2020,
    "price": {
      "amount": 1500000,
      "currency": "LKR"
    },
    "mileageKm": 42000,
    "bodyType": "Sedan",
    "fuel": "Petrol",
    "transmission": "Automatic",
    "colour": "White",
    "description": "Example listing.",
    "publishedAt": null,
    "images": [
      {
        "id": "simg_1",
        "url": "https://img.example.test/stock/15207a1250a022d4/00000001-0000-4000-8000-000000000000.jpg",
        "altText": "Left side",
        "sortOrder": 0
      }
    ]
  }
}
```

#### DELETE /api/v1/stock/:id/images/:imageId

**Roles:** ADMINISTRATOR, MANAGER

`409` when it is the last image of a published listing. Answers the listing.

Example (200):

```json example:stock.images.delete 200
{
  "data": {
    "id": "stock_1",
    "slug": "alpha-one-2020-abc123",
    "status": "DRAFT",
    "make": "Alpha",
    "model": "One",
    "year": 2020,
    "price": {
      "amount": 1500000,
      "currency": "LKR"
    },
    "mileageKm": 42000,
    "bodyType": "Sedan",
    "fuel": "Petrol",
    "transmission": "Automatic",
    "colour": "White",
    "description": "Example listing.",
    "publishedAt": null,
    "images": []
  }
}
```

#### GET /api/v1/enquiries

**Roles:** ADMINISTRATOR, MANAGER

Messages from the website's contact form. Query (strict): `page`, `pageSize` (1-50, default 20), `status` (`open` default, `handled`, `all`). These contain a visitor's name, email and phone: show them to ADMINISTRATOR and MANAGER only (the API already does).

Example (200):

```json example:enquiries.list 200
{
  "data": {
    "rows": [
      {
        "id": "enq_1",
        "name": "Example Visitor",
        "email": "visitor@example.test",
        "phone": "+94 77 000 0000",
        "message": "Is this still available?",
        "stockSlug": "alpha-one-2020-abc123",
        "handled": false,
        "createdAt": "2026-10-28T00:00:00.000Z"
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 20
  }
}
```

#### POST /api/v1/enquiries/:id/handled

**Roles:** ADMINISTRATOR, MANAGER

Body `{ "handled": boolean }` (strict).

Example (200):

```json example:enquiries.handled 200
{
  "data": {
    "id": "enq_1",
    "handled": true
  }
}
```

### 5.18 Administrator tools

#### POST /api/v1/admin/jobs/daily-checks

**Roles:** ADMINISTRATOR

Runs the daily reminders and shipment-status job now. No body. It takes the same lock as the scheduled run and is idempotent. `status` is `ran`, `skipped_overlap` (a run is in progress here), `skipped_locked` (another instance holds the lock) or `failed` (the detail is only in the server log). `result` appears when it ran. Every call is recorded in the activity log with who pressed the button.

Example (200):

```json example:admin.daily-checks 200
{
  "data": {
    "status": "skipped_locked",
    "durationMs": 0
  }
}
```

---

## 6. Files: viewing and uploading

### What `url` holds today (contract version 1.0.0 and later)

On every staff file response (`GET /vehicles/:serial/files`, the photo, document and auction-sheet registration answers) each file's `url` is **a short-lived link on this API's own domain**:

`https://api.example.test/f/v1/<kind>/<id>/<variant>?o=<org>&u=<you>&a=staff&exp=<unix seconds>&sig=<signature>`

- `kind` is `photo`, `document` or `auction-sheet`; `id` is the database id (the vehicle id for an auction sheet); `variant` is `full` in every link the API gives staff. Do not edit a link: changing any part of it breaks its signature.
- **It expires.** `expiresAt` says when (5 minutes after issue by default; the operator sets it). **Never store a `url`**, never put it in a database, a bookmark, a cache or a log. Store the file `id` and ask `GET /vehicles/:serial/files` again when you need a fresh link (a page that stays open for a long time should re-fetch before `expiresAt`).
- **The link is not the authorization.** Every time it is opened, the API checks again that you are still an active staff member of that organisation and that the file still exists and is visible, so a deactivated person's links stop working at once. There is no Bearer token on this request (so `<img src>`, `<a href>` and PDF viewers work). A link from one person is useless to another only in the sense that it stops at `exp`; treat it like a password for five minutes.
- **Every failure is the same answer**: `404 { "error": { "code": "NOT_FOUND", "message": "File not found." } }` with `Cache-Control: no-store`. It never says whether the link was wrong, expired, tampered with, or the file was removed. On a 404, ask for fresh links.
- A successful answer is the file with its real type (`image/jpeg`, `image/png`, `image/webp` or `application/pdf`), `Cache-Control: private, max-age=<seconds left, at most 300>`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, `Cross-Origin-Resource-Policy: cross-origin`, `Referrer-Policy: no-referrer`, an `ETag` (conditional requests answer `304`), and for PDFs `Accept-Ranges: bytes` (one range per request; `206`, or `416` for a bad range).
- **What the browser sees:** only the API's own domain. The link contains no storage host, bucket name, account id or object key. A plain `<img>`, `<a>` or `<iframe>` needs no CORS; `fetch()` from another origin needs the app's origin on the API's CORS list (GET).
- **When file links are not configured** (`FILE_LINK_SECRET` unset, a development or early-staging setup), `url` is `null` and `unavailable: true` for every file. Production always has them.
- *Earlier behaviour:* before this version `url` held a presigned storage address. If you are migrating from that, remove any code that parses `url` or expects a storage host; the `docs/storage-migration.md` checklist lists what to change.

### Uploading: three steps, direct to storage

File bytes never pass through this API. A file is added in three steps.

1. **Presign:** `POST /uploads/presign` with `{ vehicleId?, kind, fileName, contentType, fileSize }` (5.6). The answer has `uploadUrl`, `key`, `expiresInSeconds` (300) and `headers`. The API chooses the `key` (`org/<org>/vehicles/<vehicleId>/{photos|documents|auction-sheet}/<random>-<safe name>.<ext>`, or `org/<org>/uploads/staging/...` when there is no vehicle yet); the client never makes one up. The extension comes from the signed content type, never from the file name.
2. **PUT the bytes** straight to `uploadUrl` with an HTTP `PUT`, the body being the raw file, and **exactly** the headers the answer lists (`Content-Type: <the contentType you asked for>`), no `Authorization` header and no extra headers. The signature fixes the object key, the content type and the exact length, so a different type or size is refused by storage. The link works for 300 seconds and for one object. A successful PUT is an HTTP 200 from the storage host with an empty body.
3. **Register** the `key` with the vehicle: `POST /vehicles/:id/photos` `{ key }`, `POST /vehicles/:id/documents` `{ key, name, documentType }`, `PUT /vehicles/:id/auction-sheet` `{ key }`, or in `POST /vehicles` the fields `photoKeys`, `documents[].key`, `auctionSheetKey`. The API builds the stored address itself; **a client never sends an address**. It checks that the key is inside your organisation's folder for that vehicle, that the object exists and that it is within the size limit.

| Kind | Content types | Largest |
|---|---|---|
| `VEHICLE_PHOTO`, `AUCTION_SHEET` | `image/jpeg`, `image/png`, `image/webp` | 10 MB |
| `VEHICLE_DOCUMENT` | `application/pdf` | 20 MB |

Nothing else is accepted, stored or served (no SVG, HTML or anything a browser can run). At most 50 photos and 50 documents can be attached in one `POST /vehicles`. A photo's thumbnail is made by the server after registration, on a best-effort basis; ask for a `thumb` link only through the links the API returns.

**CORS requirement (storage, not this API).** The PUT goes from the browser to the storage host, so the storage bucket must have a CORS rule allowing `PUT` with the `Content-Type` header from the staff web app's origin (the operator sets this on the bucket; it is not in this repository). The iOS app is not a browser and needs no CORS.

**What this exposes to the browser, stated plainly.** (a) **The presigned `uploadUrl` contains the storage host name and the storage account id.** It is staff-only, valid 300 seconds, and good for one key, one type and one size; this exposure is accepted (docs/security-model.md). Never log it, never send it to analytics. (b) **Stock-image uploads** (`POST /stock/:id/images/presign`) go to the *public* stock bucket and its answer also carries a `publicUrl`; the stock images are public on the website by design. (c) Nothing else shows a storage host: not the file links above, not the activity log (redacted), not any error.

Deleting a photo or document removes its row and then, best effort, the stored object.

---

## 7. Live updates

Staff clients can keep a Server-Sent Events (SSE) stream open for instant notifications and chat events. It is an optimisation: **the stream has no replay**, so the lists are always the truth.

#### GET /api/v1/notifications/stream

**Roles:** ADMINISTRATOR, MANAGER, OPERATOR, VIEWER (event stream)

- **Connect:** `GET /api/v1/notifications/stream` with `Authorization: Bearer <accessToken>` (any staff role). **The token must be in the header; a token in the URL (query string) is never accepted**, because URLs end up in logs. Answers `200`, `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-store`, `X-Accel-Buffering: no`.
- **Frame format:** first the text `retry: 5000` (reconnect after 5 seconds) and a comment `: connected`; then every 25 seconds a comment line `: ping` (heartbeat; ignore comment lines). Events look like `id: <event id>`, `event: <name>`, `data: <json>`, a blank line.
- **`event: notification`:** `data` has exactly these keys: `id, event, title, body, vehicleId, createdAt` (strings or `null`; `id` is the notification's id, the same as in `GET /notifications`).
- **`event: message`:** a new customer chat message (sent to the staff the message is routed to: the customer's assigned agent when that agent can use chat, otherwise all active administrators and managers): `data` has `conversationId, messageId, senderType ("STAFF" | "CUSTOMER"), createdAt`. It carries no text; fetch the conversation (5.16).
- **`event: reauth`** `{"reason":"token_expired"}`: sent just before the server closes the stream **when the access token expires** (about 20 minutes after it was issued). Refresh the token (section 2) and reconnect.
- **`event: closed`** with `{"reason":"replaced"}`: you opened a fourth stream for the same person, so the oldest was closed (limit 3 per person); with `{"reason":"unauthorized"}`: the account is no longer allowed (deactivated, removed). Do not reconnect on `unauthorized`; sign in again.
- **`event: shutdown`** `{"reason":"server_shutting_down"}`: the server is restarting. Reconnect after a short random delay (a few seconds).
- **Refusals:** `401` without a valid token (an ordinary JSON error). `429 RATE_LIMITED` when the server is at its stream capacity (`Retry-After: 30`) or after more than 30 connection attempts a minute from one address (`Retry-After: 60`).
- **Account changes close the stream:** the server re-checks the account against the database every 60 seconds and closes with `closed/unauthorized` if it is no longer allowed.
- **Catch-up after every (re)connect:** call `GET /notifications` (first page) and `GET /notifications/unread-count`, and refetch the chat inbox if the screen is open. Events published while you were disconnected are not replayed, and `Last-Event-ID` is not honoured.
- **One server instance.** An event reaches only the streams held by the instance that produced it. The API runs as a single instance today, so this is invisible; if it ever runs more than one, the catch-up calls above are what keep clients correct.

**Browsers cannot set an `Authorization` header with `EventSource`.** Options, in the order we recommend:
1. **`fetch()` with a streaming body reader** (`response.body.getReader()`) in the browser, parsing the SSE frames yourself, or a small library that does this (such as `@microsoft/fetch-event-source`, which sends custom headers). Needs the app origin on `CORS_ALLOWED_ORIGINS` (section 1). This is the straightforward choice.
2. **A Next.js route handler that proxies the stream** (the browser connects to the Next server with its own session; the Next server opens the API stream with the Bearer token and pipes the bytes through, disabling response buffering). The API then sees the Next server's address for the rate limit (section 9), so many users share the 30 a minute connection limit; keep one upstream stream per signed-in person and do not reconnect in a tight loop.
3. **Poll** `GET /notifications/unread-count` every 30 to 60 seconds (well inside the 300 a minute limit) and load the list when the count changes. Works everywhere; no instant updates.
4. *Not available:* a token in the query string, cookies, WebSockets.

The iOS app can use `URLSession` with a normal header.

---

## 8. Differences from the old app, and what is not built

This section is built from this repository's own documents (`docs/implementation-plan.md`, `docs/api-contract.md`, the ADRs). **The old Next.js application's source is not in this repository, so this list is not complete.** Where the repository cannot tell, it says so. Confirm anything marked *unknown* with the people who own the old app before you plan around it.

### Behaviour that differs

| Area | Old Next.js app / earlier API | This API |
|---|---|---|
| Sessions | NextAuth cookie session in the browser | Bearer access token (20 minutes) plus a rotating refresh token (30 days). No cookies. Changing a password here revokes the API's refresh tokens but does **not** touch a separate old-app cookie session |
| Failed sign-in | Web form collapsed every failure into a generic message | `400 VALIDATION` for a wrong password, `403 FORBIDDEN` for a locked account, both as JSON. **The original mobile API contract says the same** (`docs/legacy/mobile-api-reference.md`, lines 54-56) |
| Refresh failures | `403` "Session expired. Please sign in again." for an unknown, expired, used or revoked token or a deactivated account (original contract, lines 67-69) | The same (section 2) |
| Vehicle list default order | The original **mobile** contract says `serial` descending, track `FC` (`docs/legacy/mobile-api-reference.md` lines 126, 134-135). The old **web** screen is said to have opened by purchase date, newest first (`docs/implementation-plan.md`; that code is not in this repository) | **`serial` descending**, default track `FC`, 17 sort keys: the same as the original mobile contract (decided; no change). If the new screen should open by purchase date, send `sort=purchaseDate&dir=desc` explicitly |
| Create and update answers | *Unknown* (the old server actions' return values are not recorded here) | `POST /vehicles` and `PUT /vehicles/:id` return the detail shape of `GET /vehicles/:serial` (since 1.1.0) |
| File addresses | A stored public address, later a presigned storage address, in `url` | A short-lived link on the API's own domain (section 6). Never stored |
| Upload registration | The client sent the file's public address | The client sends the `key` the presign returned; the server builds the address |
| Upload answer | Included a public address | `{ uploadUrl, key, expiresInSeconds, headers }`; no public address (stock-image uploads keep `publicUrl`) |
| Live updates | Pusher | Server-Sent Events plus the notification list (section 7) |
| Scheduled jobs | Cron route of the old app | An in-process scheduler in this API; `POST /admin/jobs/daily-checks` runs it on demand. The two must not both run (duplicate reminders) |
| Customer contact details | *Unknown* (not recorded here) | Hidden from VIEWER by decision (section 3) |
| Activity log | May have held full file addresses | New rows hold file id, kind and name only; every read redacts storage addresses, keys and names |
| Auction bill, log book, extra key | Tri-state | Unchanged: `null` is "not entered" |
| Rate limits | *Unknown* | Per client address (section 9) |
| Database | The same database and schema; this repository now owns migrations (additive-first). The old app may still be running against it | n/a |

### Not built (the migration team should plan for these)

| What | Status |
|---|---|
| A bulk or import endpoint for vehicles (spreadsheet import, bulk edit) | Not built. *Unknown* whether the old app had one |
| Export of lists or reports to CSV or Excel | Not built; reports are JSON. A PDF for one vehicle is built client-side from `GET /vehicles/:serial/pdf-images` |
| Restoring a deleted vehicle, or listing deleted vehicles | Not built (soft delete is one-way through the API) |
| Deleting a staff account | Not built (deactivate only). Likewise no delete for customers, lookups, notifications or activity-log rows |
| Staff "forgot password" by email | Not built. A person changes their own password while signed in (`POST /profile/password`); an administrator sets another person's (`PATCH /staff/:id`) |
| "Sign out everywhere" button | Not built (it happens as a side effect of a password change, a deactivation or a role change) |
| Reordering a vehicle's photos | Not built (photos are listed oldest first) |
| Editing a photo's or document's name or replacing its file | Not built (delete and add again); only the release flags and a document's type can be changed |
| Creating a chat conversation from the staff side | Not built; customers start conversations. Chat has no attachments, read receipts or typing indicators |
| Cursor pagination, `Last-Event-ID` replay on the stream, WebSockets | Not built |
| Reserving a vehicle, a cost / CIF estimator, phone or OTP login, WhatsApp sending | Deliberately out of scope for now |
| An OpenAPI description or generated client | Not built (this document and its test are the contract) |
| A trusted way for a server-side caller to pass the real end-user address (section 9) | Built in 1.2.0, optional (off until the operator sets a secret) |
| Amounts for customers | Never: customers see no price or total anywhere |
| A global search endpoint across customers, vehicles and stock | Not built; use `q` on the list endpoints |

### What this document does not know

- Which old server actions had *no* equivalent here beyond the gaps above.
- The exact old validation messages. Messages here are the new API's; rely on `fieldErrors` keys and `code`, not on message text.
- Whether the old app enforced anything on the client that the server here does not (for example field masks); this API validates on the server and returns `fieldErrors` keyed by field name.

---

## 9. Operational facts

Names only. Values come from the operator; nothing here is a secret.

**Base address.** `https://api.example.test` (placeholder). One address for the API and for its file links (`FILE_LINK_BASE_URL`). `GET /health` (no token) answers `{ "data": { "status": "ok" } }` and is the liveness check.

**One instance.** The API runs as a single instance; its rate limiters, event bus and stream connections live in memory. A redeploy or restart ends every open stream (`shutdown` event) and resets the rate-limit counters.

**Rate limits** (per client address, a rolling minute): see section 1 for the list. They are limits per address, not per person.

**Client address: what the API sees.** The limits and the logs use the API's idea of the client address, set by the `CLIENT_IP_SOURCE` setting (the operator must choose it deliberately; production refuses to start without it):

| `CLIENT_IP_SOURCE` | Address the limits use | Use when |
|---|---|---|
| `socket` (default) | The TCP peer. Every forwarding header is ignored | The API is reached directly, or the host's headers have not been verified |
| `hops` | The `X-Forwarded-For` entry added by exactly `TRUST_PROXY_HOPS` trusted proxies | The number of proxies in front is known and the API is reachable only through them |
| `header` | The one header named by `CLIENT_IP_HEADER`, which the host's edge overwrites on every request | The hosting edge provides such a header |

**What this means for a server-side caller (the Next.js server).** The API sees **the caller's address**, the same for every user, unless the caller proves itself and passes the visitor's address (next subsection). Ordinary forwarding headers (`X-Forwarded-For` and similar) are ignored in `socket` mode and cannot be trusted from you in the other modes. **Without the trusted forwarder**:
- All users of the web app share one 300 a minute overall bucket, one 10 a minute `auth/login` bucket, one 10 a minute `auth/refresh` bucket, one 20 a minute `device-tokens` bucket, one 60 a minute `uploads/presign` bucket and one 30 a minute stream bucket. **Signing every user in through the Next server will hit 429 as soon as more than ten sign-ins or refreshes happen in a minute across the whole company.**
- Account lockout (5 wrong passwords) is per account, so it still works.
- Requests answered from a browser or CDN cache never reach the API and use no limit (but this API sends `no-store`).

### Server-side callers: passing the real visitor address

Since contract 1.2.0 the API supports a **trusted forwarder** (decision record: `docs/adr/adr-0008-trusted-forwarder-for-server-side-callers.md`). It is **optional and off** until the operator sets `TRUSTED_FORWARDER_SECRET`. Ask the operator whether it is on before you rely on it. When it is on, a server-side caller signs the visitor's address and the API uses that address for the rate limits, the sign-in lockout keys and its logs. The secret stays on your server; **never put it in browser code**.

Send these three request headers on every call you make on behalf of one visitor (on any route, staff, customer or public):

| Header | Value |
|---|---|
| `X-Client-IP` | The visitor's address: exactly one IPv4 or IPv6 address. No list, no port, no brackets, no spaces, no zone id (`%eth0`) |
| `X-Forwarder-Timestamp` | The time you signed, in unix seconds, digits only |
| `X-Forwarder-Signature` | `base64url(HMAC-SHA256(secret, "v1|<ip>|<timestamp>"))`: the text is the three parts joined by `|`; the secret is the shared secret used as the key (UTF-8 bytes); the result is base64url **without** padding, always 43 characters |

How the API decides (anything else and it **ignores the three headers entirely**, answers the request normally as if you had not sent them, and logs one masked warning a minute; it never rejects the request for this reason):

1. The three headers are present once each, the address is one valid IP address, the timestamp is digits, the signature is 43 canonical base64url characters.
2. The timestamp is at most **60 seconds old** and at most **30 seconds in the future** (clock skew). Sign each call, or sign once and reuse for under a minute.
3. The signature matches the current secret, or the previous secret while the operator is rotating. Compared in constant time.

A fake worked example (the secret, address and time are made up; the signature below is the real result for them, and the contract test recomputes it):

```json forwarder-example
{
  "secret": "example-only-forwarder-key-0123456789-abcdef",
  "ip": "203.0.113.7",
  "timestamp": 1800000000,
  "signedText": "v1|203.0.113.7|1800000000",
  "signature": "eNY2Avo-w-pxT0KwcCwoxEkLZ8TDMnr-WC1XiFrTc_w",
  "headers": {
    "X-Client-IP": "203.0.113.7",
    "X-Forwarder-Timestamp": "1800000000",
    "X-Forwarder-Signature": "eNY2Avo-w-pxT0KwcCwoxEkLZ8TDMnr-WC1XiFrTc_w"
  }
}
```

In words, for any language: build the text `v1|` + address + `|` + timestamp; compute HMAC with SHA-256 using the secret as the key; encode the 32 result bytes as base64url and drop any `=` padding; send the address, the timestamp and that string in the three headers. Node's `crypto.createHmac("sha256", secret).update(text).digest("base64url")`, .NET's `HMACSHA256`, and PowerShell's `[System.Security.Cryptography.HMACSHA256]` all produce the same bytes; only the final encoding step (base64url, no padding) needs care.

Things to know:
- **Sign the real visitor.** Take the address from the connection your own server accepted (or from your host's own trusted header), never from a header the visitor can set. A caller that signs a constant gets the shared-bucket behaviour back.
- **The ordinary headers still do nothing.** `X-Forwarded-For`, `X-Real-IP` and the like never change the address; only a valid signature does. A wrong, expired or tampered signature is not an error you can detect from the answer: the request just counts against your own address. Watch for unexpected `429` and ask the operator to check the warnings.
- **Rotation.** The operator can accept the old and the new secret at once. Switch your signer to the new secret whenever the operator says the new one is current.
- **Browsers can still call the API directly** for sign-in, refresh, upload presign and the stream (each browser has its own address; add the app's origin to `CORS_ALLOWED_ORIGINS`). Use whichever suits the app; the two can be mixed.
- If the forwarder is off, the options in order of preference are: let the browser call the API directly for those routes; refresh once per session and as late as possible; ask the operator to turn the forwarder on.

**Storage.** Photos and documents live in object storage the browser never reads from; uploads go direct to storage with a presigned `PUT` (section 6). Public stock images live in a separate public bucket.

**Logs.** The server logs the method, the route pattern, the status and the duration; never a URL, a query, a header, an address or a token.

---

## 10. Changes and versioning

This contract has its own version, `MAJOR.MINOR.PATCH`, at the top of this file.

- **MAJOR** (breaking): removing or renaming a field or endpoint, changing a type or the meaning of a value, tightening a limit, changing an error code or an allowed role.
- **MINOR** (compatible): a new endpoint, a new optional request field, a new key in a response. **Clients must ignore response keys they do not know**, and must treat an unknown enum value (an `event`, a `documentType`) as a generic one.
- **PATCH**: wording, examples, clarifications.

Breaking changes are announced here before they ship. The test `tests/staff-frontend-contract.test.ts` makes drift visible: it fails when an example's key set no longer matches what the route returns, when a route is added or removed without a section here, or when a role in the code and in the matrix disagree. A change to the API is not finished until this file and the test are updated in the same change.

### Changelog

| Version | Date | Change |
|---|---|---|
| 1.9.0 | 2026-11-07 | **Additive:** `unreadCount` on every inbox row of `GET /chat/conversations`, and the new `POST /chat/conversations/:id/read` (mark read for staff). Nothing existing changed or was removed |
| 1.8.0 | 2026-11-05 | **Behaviour change (free reuse of serials, ADR 0009):** a serial is unique among **non-deleted** vehicles only. Deleting a vehicle frees its serial: `POST /vehicles` (legacy serial) and `PATCH /vehicles/:id/serial` now **succeed** for a serial held only by deleted vehicles (they used to answer `409`); a clash with an **active** vehicle is still `409`, and its `fieldErrors` now also has `serial: "already in use"` (the old `legacySerialNumber` / `serialNumber` key stays). **Additive:** `serialReused: boolean` on the answers of create and of the correction. **Removed:** the reasons `SERIAL_PREVIOUSLY_USED` and `SERIAL_REUSE_NOT_ENABLED` (added in 1.6.0 and never needed by a released client): the code is no longer returned and no `reason` is returned at all. **Deprecated:** the body field `reuseDeletedSerial` is accepted and ignored (no `403` for a MANAGER any more). A client that assumed a serial identifies one vehicle for ever must key on the vehicle `id` |
| 1.7.0 | 2026-11-04 | **Additive; with no new query parameter every existing answer is byte-for-byte the same** (except the new `isSuperAdmin` key of the profile): optional `track=FC\|FL` on the filter-bar lookups, `GET /customers/search`, `GET /vehicles/destinations` and `GET /lookups/row-colour-statuses` (only values used by non-deleted vehicles of that effective track; other values are `400`); new `GET /vehicles/partner-names`; `isSuperAdmin` on `GET` and `PATCH /profile`; the `X-Contract-Version` header on every `/api/v1` answer (also exposed to browsers). The timeline steps are listed in full (section 5.5) |
| 1.6.0 | 2026-11-04 | **Additive:** an optional `reason` string on `409` errors only (`SERIAL_PREVIOUSLY_USED`, `SERIAL_REUSE_NOT_ENABLED`); an optional `reuseDeletedSerial` flag on `POST /vehicles` and `PATCH /vehicles/:id/serial` (a MANAGER who sends `true` gets `403`; reuse of a deleted serial is not enabled yet, so an administrator gets `409`); a deleted vehicle's serial is now reported as such instead of "already exists". `fieldErrors` is documented as one string per field. The default list order is confirmed as `serial` descending, track `FC` |
| 1.5.1 | 2026-11-03 | Wording only: section 8 now cites the original mobile contract (`docs/legacy/mobile-api-reference.md`) for the sign-in and refresh statuses and the default list order, and `docs/legacy-parity-report.md` compares every legacy endpoint with this API. No behaviour changed |
| 1.5.0 | 2026-11-03 | **Compatible fix:** every create or update with a unique key answers `409 CONFLICT` with a field error when two requests collide, never `500`: customer create and update (`fieldErrors.email`), staff create, update and own profile (`email`), lookup create and rename (`name`), vehicle create with a legacy serial (`legacySerialNumber`) and serial correction (`serialNumber`). Verified with concurrent requests against a real database |
| 1.4.0 | 2026-11-01 | **Additive:** the vehicle detail (and the answers of `POST /vehicles` and `PUT /vehicles/:id`) gains `storedShipmentStatus`; its `shipmentStatus` is, and always was in the code, the effective value. New `GET /vehicles/:serial/timeline` (the derived Shipment Timeline of the detail screen). Documentation fix: 1.0.0 to 1.3.0 wrongly called the detail's `shipmentStatus` the stored value |
| 1.3.0 | 2026-11-01 | **Behaviour change (PATCH semantics):** `PATCH /customers/:id`, `PATCH /staff/:id` and `PATCH /profile` now change only the fields sent. Before, they replaced the whole record, so an omitted field was cleared (customer, profile phone) or required (`role` and `active` on staff). Full bodies still work. Unknown fields and empty bodies are now `400`. A password change keeps revoking the caller's own refresh token |
| 1.2.0 | 2026-11-01 | New, optional and compatible: the **trusted forwarder** (`X-Client-IP`, `X-Forwarder-Timestamp`, `X-Forwarder-Signature`, section 9). No response changes. Off unless the operator sets `TRUSTED_FORWARDER_SECRET` |
| 1.1.0 | 2026-11-01 | **Breaking for create and update:** `POST /vehicles` and `PUT /vehicles/:id` now answer with the detail shape of `GET /vehicles/:serial` instead of the stored row (no `org_id`, no `serialPrefix`, no `serialNumber`). A client that read those keys from the 1.0.0 answer must be updated. Also: every answer has `X-Request-Id`, and `Access-Control-Expose-Headers` lists `Retry-After`, `X-RateLimit-*` and `X-Request-Id` |
| 1.0.0 | 2026-11-01 | First complete staff contract. Describes the API as it stands: **own-domain signed file links** in every staff `url` (before: presigned storage addresses), file registration **by `key`** (before: by address), the key-only presign answer, the 20-minute access token with rotating refresh, database-checked roles, the VIEWER contact-detail rule, and the default vehicle sort `serial desc` |

---

## 11. Facts checked against the code

The numbers below are asserted by the contract test against the constants in the code. If a limit changes, the test fails until this block (and the prose above) are updated.

```json facts
{
  "accessTokenSeconds": 1200,
  "globalRateLimitPerMinute": 300,
  "fileLinkRateLimitPerMinute": 240,
  "minPasswordLength": 12,
  "maxPasswordBytes": 72,
  "defaultPageSize": 50,
  "maxPageSize": 100,
  "uploadUrlSeconds": 300,
  "maxImageBytes": 10485760,
  "maxDocumentBytes": 20971520,
  "maxStockImageBytes": 8388608,
  "maxImagesPerStockListing": 20,
  "maxChatMessageLength": 2000,
  "streamRecheckSeconds": 60,
  "forwarderMaxAgeSeconds": 60,
  "forwarderMaxFutureSeconds": 30,
  "defaultVehicleSort": "serial",
  "defaultVehicleSortDirection": "desc",
  "defaultVehicleTrack": "FC",
  "errorStatuses": { "VALIDATION": 400, "FORBIDDEN": 403, "NOT_FOUND": 404, "CONFLICT": 409, "INTERNAL": 500 }
}
```
