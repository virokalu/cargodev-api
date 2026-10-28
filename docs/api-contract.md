# API contract

Source of truth for clients. Update this file in the same PR that changes behaviour.

## Envelope

Success: `{ "data": <payload> }`
Error: `{ "error": { "code": "...", "message": "...", "fieldErrors": { "field": "message" } } }` (`fieldErrors` optional, one message per field)

## Error codes

| Code | HTTP |
|---|---|
| VALIDATION | 400 |
| UNAUTHENTICATED | 401 |
| FORBIDDEN | 403 |
| NOT_FOUND | 404 |
| CONFLICT | 409 |
| RATE_LIMITED | 429 |
| INTERNAL | 500 |

`UNAUTHENTICATED` is only ever produced by the auth hook, and `RATE_LIMITED` only by the per-IP limiter. Services never throw either.

## Conventions

- Every response has `Cache-Control: no-store`, except the customer file endpoints (`private, max-age=300` by default) and the successful `GET`s under `/api/public` (`public, max-age=60`). Errors and the enquiry `POST` are `no-store` even there.
- Dates are ISO 8601 strings. Decimals are plain numbers.
- A resource in another org returns 404, never 403.
- `orgId` always comes from the verified token. Any `orgId` in a request is ignored.
- Auth: `Authorization: Bearer <accessToken>` (HS256 JWT, 20 minutes). The token proves who signed in; it does not decide what they may do. On every staff request the API reads the user from the database (through a short in-process cache, `STAFF_AUTH_CACHE_SECONDS`, default 30): a user who is deactivated, removed or not staff of the token's org gets `401 UNAUTHENTICATED`, and the role used for the route's role list is the DATABASE role, not the token's `role` claim. A role change or deactivation made through this API applies on the next request. An open notification stream is re-checked every 60 seconds and ends with `event: closed` (`reason: unauthorized`) when the user is no longer allowed.
- Roles: `ADMINISTRATOR | MANAGER | OPERATOR | VIEWER`.
- Create endpoints return 201. Malformed JSON returns 400 `VALIDATION`.
- New passwords are 12 to 72 bytes (bcrypt ignores anything longer). Login accepts any length so older passwords keep working.
- Rate limits (per IP): 300 requests/minute overall, 10/minute on each `/auth/*` endpoint.

## Endpoints

Status: `todo` / `done`. Roles column is the allow-list. Taken from the CargoDev action and route files, not guessed.
"any staff" means any of the four roles with a valid token.

### Auth and health

| Method | Path | Roles | Status |
|---|---|---|---|
| GET | /health | public | done |
| POST | /api/v1/auth/login | public | done |
| POST | /api/v1/auth/refresh | public | done |
| POST | /api/v1/auth/logout `{ "refreshToken", "expoPushToken"? }` | public | done |

Logout is idempotent. If `expoPushToken` is sent, that device token is removed, but only if it belongs to the user and org the refresh token was issued to, so signing out can never unregister someone else's device.

### Customers

| Method | Path | Roles | Status |
|---|---|---|---|
| GET | /api/v1/customers?q= | any staff | done. **VIEWER gets rows without `email`, `phone` and `address` (the keys are absent) and `q` matches the name only**; every other role gets the full row and may search by email and phone |
| GET | /api/v1/customers/search?q= | any staff | done. `{ id, name }` only, for every role |
| GET | /api/v1/customers/:id | any staff | done. `{ id, name }` only, for every role |
| POST | /api/v1/customers | ADMINISTRATOR, MANAGER | done |
| PATCH | /api/v1/customers/:id | ADMINISTRATOR, MANAGER | done |

### Staff and profile

| Method | Path | Roles | Status |
|---|---|---|---|
| GET | /api/v1/staff?q= | ADMINISTRATOR, MANAGER | done |
| POST | /api/v1/staff | ADMINISTRATOR | done |
| PATCH | /api/v1/staff/:id | ADMINISTRATOR | done |
| POST | /api/v1/staff/:id/active `{ "active": boolean }` | ADMINISTRATOR | done |
| GET | /api/v1/profile | any staff | done |
| PATCH | /api/v1/profile | any staff | done |
| POST | /api/v1/profile/password | any staff | done |
| GET | /api/v1/organization | any staff | done |

### Dashboard, reports, activity log

| Method | Path | Roles | Status |
|---|---|---|---|
| GET | /api/v1/dashboard/stats | any staff | done |
| GET | /api/v1/dashboard/trends | any staff | done |
| GET | /api/v1/reports/by-customer?track=FC\|FL | any staff | done. Each customer group carries `email` and `phone`, **except for a VIEWER (the keys are absent)** |
| GET | /api/v1/reports/by-auction-hall?track=FC\|FL | any staff | done |
| GET | /api/v1/reports/by-destination?track=FC\|FL | any staff | done |
| GET | /api/v1/reports/by-freight-agent | any staff | done |
| GET | /api/v1/activity-log | ADMINISTRATOR | done |
| GET | /api/v1/activity-log/filters | ADMINISTRATOR | done |

### Lookups

Reads are `any staff`. `?q=` is a case-insensitive partial match, capped at 20 results.
Writes (POST create, PATCH rename) are ADMINISTRATOR and MANAGER. POST is find-or-create: a name that already exists (case-insensitive) returns the existing row with 200 and logs nothing, so it is the one create endpoint that does not return 201. Every write that changes data writes an ActivityLog row. Names are trimmed and 1-150 characters.

| Method | Path | Status |
|---|---|---|
| GET | /api/v1/lookups/{brands, auction-halls, suppliers, transport-companies, inspection-companies, inspection-by, packing-agents, vehicle-locations}?q= | done |
| GET | /api/v1/lookups/{same resources}/:id | done |
| GET | /api/v1/lookups/models?brandId=&q= and /models/:id | done |
| GET | /api/v1/lookups/grades?modelId=&q= and /grades/:id | done |
| GET | /api/v1/lookups/freight-agents, /freight-agents/search?q=&method=RORO\|CONTAINER, /freight-agents/:id | done |
| GET | /api/v1/lookups/row-colour-statuses | done |
| POST | /api/v1/lookups/{same resources} `{ "name" }` | done |
| PATCH | /api/v1/lookups/{same resources}/:id `{ "name" }` | done |
| POST | /api/v1/lookups/models `{ "brandId", "name" }` (brand must be in your org, else 404) | done |
| POST | /api/v1/lookups/grades `{ "modelId", "name" }` (model must be in your org, else 404) | done |
| POST / PATCH | /api/v1/lookups/freight-agents[/:id] `{ "name", "offersRoro", "offersContainer" }` (at least one flag true) | done |

### Notifications and device tokens

All `any staff`, and every endpoint acts only on the token's own user and org.

| Method | Path | Status |
|---|---|---|
| GET | /api/v1/notifications?page=&pageSize= | done |
| GET | /api/v1/notifications/unread-count | done |
| POST | /api/v1/notifications/read-all | done |
| POST | /api/v1/notifications/:id/read (idempotent; an id that is not yours changes nothing) | done |
| POST | /api/v1/device-tokens `{ "expoPushToken", "platform" }` (20/min per IP) | done |
| DELETE | /api/v1/device-tokens `{ "expoPushToken" }` (idempotent, 20/min per IP) | done |

A device token moves to the most recent user who registers it (shared phones). Token values are never written to logs or error responses.

### Vehicles (read)

All `any staff`. Every query is scoped to the token's org and excludes soft-deleted vehicles. Track and shipment status are the *effective* ones (a converted vehicle follows its new track; CANCELLED is computed for FC only).

| Method | Path | Status |
|---|---|---|
| GET | /api/v1/vehicles | done |
| GET | /api/v1/vehicles/filter-options | done |
| GET | /api/v1/vehicles/destinations | done |
| GET | /api/v1/vehicles/:serial (404 for another org's, deleted or unknown serial) | done |
| GET | /api/v1/vehicles/:serial/status-history | done |

`GET /vehicles` query: `page`, `pageSize` (max 100, default 50), `track` (FC default, FL, ALL), `q`, `status` (repeatable: PENDING, BOOKING_RECEIVED, SHIPPED, CANCELLED), `destination`, `partner`, `customer`, `rowColour`, `rowColourNot`, `brand`, `model`, `grade`, `hall`, `supplier`, `agent`, `packingAgent`, `location`, `transport`, `method` (RORO, CONTAINER), `billPaid`/`logBook`/`extraKey`/`paidByCustomer` (YES, NO, BLANK), `partnership`, `converted`, `convertedLocal` (YES, NO), `currency`, `etdFrom`/`etdTo`/`etaFrom`/`etaTo` (YYYY-MM-DD, inclusive), `sort`, `dir`. Tri-state values keep BLANK (not entered) distinct from NO (false). `sort=shipmentStatus` orders by the effective status.

### Vehicles (write)

Every write is scoped to the token's org by id; another org's, a deleted or an unknown id is 404. Each one writes an ActivityLog row in the same transaction.

| Method | Path | Roles | Notes |
|---|---|---|---|
| POST | /api/v1/vehicles | ADMINISTRATOR, MANAGER | 201. Returns the vehicle. Serial is assigned by the server (legacy entry: `isLegacyEntry` + `legacySerialNumber`) |
| PUT | /api/v1/vehicles/:id | ADMINISTRATOR, MANAGER | **Full replace**, not a patch: an omitted optional field is cleared. Serial and track cannot be changed here |
| DELETE | /api/v1/vehicles/:id | ADMINISTRATOR, MANAGER | Soft delete |
| PATCH | /api/v1/vehicles/:id/row-colour | ADMINISTRATOR, MANAGER, OPERATOR | `{ "rowColourStatusId": string \| null }` |
| PATCH | /api/v1/vehicles/:id/auction-bill-paid | ADMINISTRATOR, MANAGER, OPERATOR | `{ "auctionBillPaid": true \| false \| null }`. The key is required; `null` means "not entered" |
| POST | /api/v1/vehicles/:id/convert-to-export | ADMINISTRATOR, MANAGER | `{ "destination" }`. FL vehicles only |
| POST | /api/v1/vehicles/:id/revert-to-local, /convert-to-local, /revert-to-export | ADMINISTRATOR, MANAGER | No body |
| PATCH | /api/v1/vehicles/:id/serial | ADMINISTRATOR | `{ "serialNumber": positive integer }`. 409 `CONFLICT` if another vehicle has it |
| GET | /api/v1/vehicles/check-chassis?chassisNo=&excludeId= | any staff | `{ duplicate }`. A warning only, never blocks a save |
| GET | /api/v1/vehicles/next-serial?track=FC\|FL | any staff | `{ serial }`, a hint; the real number is assigned at save |

Every id in a create or update body (model, grade, hall, supplier, customer, agents, locations, row colour, inspection) must belong to the caller's org, otherwise 400 with a field error. A 409 `CONFLICT` means the serial was taken by a concurrent save; retry.

### Vehicle milestones (staff)

The customer timeline: BOUGHT, AUCTION_BILL_PAID, AT_EXPORT_YARD, EXPORT_CERT_ISSUED, BOOKING_RECEIVED, SHIPPED, BL_ISSUED, ARRIVED, DELIVERED. One row per vehicle and type.

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | /api/v1/vehicles/:serial/milestones | any staff | `[{ type, occurredAt, recordedBy: { id, name } \| null }]`, oldest first. `recordedBy` is null when the system recorded it |
| PUT | /api/v1/vehicles/:id/milestones/:type | ADMINISTRATOR, MANAGER, OPERATOR | `{ occurredAt? }` (a date or timestamp; default now; not in the future). Records it, or moves its date if it exists |
| DELETE | /api/v1/vehicles/:id/milestones/:type | ADMINISTRATOR, MANAGER, OPERATOR | Undo. The only way a milestone is ever removed |

Automation records BOOKING_RECEIVED (when a vehicle enters that status) and SHIPPED (the daily job and any edit that makes it shipped; dated by the ETD) in the same transaction as the status change. It only **adds**: clearing an ETD or reverting a status removes nothing.

### Uploads

| Method | Path | Roles | Body | Success |
|---|---|---|---|---|
| POST | /api/v1/uploads/presign | ADMINISTRATOR, MANAGER, OPERATOR | `{ vehicleId?, kind: AUCTION_SHEET \| VEHICLE_PHOTO \| VEHICLE_DOCUMENT, fileName, contentType, fileSize }` | 200 `{ uploadUrl, key, publicUrl, expiresInSeconds: 300, headers: { "Content-Type" } }` |

The vehicle must be the caller's org's (otherwise 404, and nothing is signed). The server builds the key (the client never chooses it): `org/<orgId>/vehicles/<vehicleId>/{photos|documents|auction-sheet}/<uuid>-<safe name>.<ext>`, or `org/<orgId>/uploads/staging/...` when there is no vehicle yet. The extension always comes from the signed content type, never from the file name. The link is signed for the exact size and type, valid 5 minutes. **Only these content types, matched exactly:** photos and auction sheets `image/jpeg`, `image/png`, `image/webp` (up to 10 MB); documents `application/pdf` (up to 20 MB). Anything else (svg, html, gif, "image/jpeg; charset=...", other casing) is a 400. Send the file with a PUT to `uploadUrl` using exactly the returned headers, then pass `publicUrl` to the add-photo / add-document / auction-sheet endpoints. 400 `File storage is not configured.` when storage is off.

### Vehicle files

File bytes never pass through this API; the database stores URLs. A URL is accepted only if it is under `R2_PUBLIC_URL` and inside the caller's own org folder: `org/<orgId>/uploads/staging/` when creating a vehicle, or `org/<orgId>/vehicles/<vehicleId>/{photos|documents|auction-sheet}/` for an existing one. Anything else is 400 with `fieldErrors.url`. When `R2_PUBLIC_URL` is not set, every file URL is refused.

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | /api/v1/vehicles/:serial/files | any staff | `{ auctionSheetUrl, auctionSheetExpiresAt, auctionSheetUnavailable?, photos: [{ id, url, expiresAt, unavailable?, uploaderName, createdAt }], documents: [{ id, url, expiresAt, unavailable?, name, documentType, uploaderName, createdAt }] }`. Every `url` is a **short-lived signed link** (see the note below), not the stored address |
| GET | /api/v1/vehicles/:serial/pdf-images | any staff | Auction sheet and photos as data URLs for the PDF export. The server re-checks each stored URL, refuses redirects, caps size (15 MB) and time (10 s), and returns images only; a failed image is skipped |
| POST | /api/v1/vehicles/:id/photos | ADMINISTRATOR, MANAGER, OPERATOR | `{ url }` (the stored form from the upload), 201 with `{ id, url, expiresAt, uploaderName, createdAt }` where `url` is a signed link |
| POST | /api/v1/vehicles/:id/photos-added | ADMINISTRATOR, MANAGER, OPERATOR | `{ count }`. One notification for a batch of photos |
| POST | /api/v1/vehicles/:id/documents | ADMINISTRATOR, MANAGER, OPERATOR | `{ url, name, documentType }`, 201 with the document and a signed `url` and `expiresAt` |
| PUT | /api/v1/vehicles/:id/auction-sheet | ADMINISTRATOR, MANAGER, OPERATOR | `{ url }`. Replaces the sheet; answers `{ auctionSheetUrl (signed), auctionSheetExpiresAt }` |
| DELETE | /api/v1/vehicles/:id/photos/:photoId | ADMINISTRATOR, MANAGER | |
| DELETE | /api/v1/vehicles/:id/documents/:docId | ADMINISTRATOR, MANAGER | |

**File `url` values are short-lived. Clients must not store them.** On every staff file endpoint the `url` field holds a signed link on the storage API host that stops working at `expiresAt` (`STAFF_SIGNED_URL_TTL_SECONDS`, 60 to 900 seconds, default 600). Use it to display or download now; keep the file's `id` and ask the API again later (never cache, bookmark, share or save the link). The link is derived from the stored address only if that address is on the configured public base AND inside the caller's own org folder; any other row has `url: null` and `unavailable: true`. A new file is still registered with the stored form of its address (the `publicUrl` the upload step returned), which is an identifier, not a working link. Customers never receive a link or an address (they use the id-based file endpoints). The answers stay `Cache-Control: no-store`.

Deleting removes the database row and then the stored object (best effort: a storage failure never blocks the delete, and only objects inside the caller's own org folder are ever removed). Without the object-storage SDK installed the object is left in place.

### Live notification stream

`GET /api/v1/notifications/stream` (any staff role). Server-Sent Events: `Content-Type: text/event-stream`, `Cache-Control: no-store`.

- **Auth:** `Authorization: Bearer <accessToken>` header only. A token in the URL is never accepted (URLs end up in logs).
- **Frames:** `id: <event id>`, `event: <type>`, `data: <json>`. The stream opens with `retry: 5000` and a `: connected` comment, then a `: ping` comment every 25 seconds.
- **`event: notification`** data: `{ id, event, title, body, vehicleId, createdAt }` (`id` is the notification id).
- **`event: reauth`** (`{"reason":"token_expired"}`) is sent just before the server closes the stream when the access token expires. Reconnect with a fresh token.
- **`event: closed`** (`{"reason":"replaced"}`): you opened a 4th stream, so the oldest is closed (limit 3 per user).
- **`event: shutdown`**: the server is stopping. Reconnect after a short delay.
- **Errors:** 401 without a valid token. 429 `RATE_LIMITED` (with `Retry-After`) when the server is at its stream limit or you reconnect too fast (30/min per IP).
- **Catch-up:** the stream is a convenience and has **no replay**. After connecting or reconnecting, call `GET /notifications` (and `/notifications/unread-count`) to get anything you missed.

### Admin jobs

| Method | Path | Roles | Status |
|---|---|---|---|
| POST | /api/v1/admin/jobs/daily-checks | ADMINISTRATOR | done |

Runs the daily job now, taking the same lock as the scheduled run. Idempotent: calling it twice, or while the scheduler runs it, creates no duplicates. Returns `{ data: { status, durationMs, result? } }` where `status` is `ran`, `skipped_overlap` (a run is in progress in this process), `skipped_locked` (another instance holds the lock) or `failed` (the detail is in the server log, never in the response). Every call is written to the activity log with who triggered it.

### Customer API (`/api/customer/v1`)

A separate zone (ADR 0005). Mounted only when `CUSTOMER_JWT_SECRET` is set. Same envelope and `no-store` as the staff API.
**The full app-facing contract (every field, error, limit, the stream and push) is [customer-app-integration.md](customer-app-integration.md); it is guarded by `tests/customer-app-contract.test.ts`.** The tables below are a summary.
Auth: `Authorization: Bearer <customer accessToken>` (15 minutes, audience `customer`). A staff token is 401 here; a customer token is 401 on `/api/v1`.
Request bodies are strict: an unknown field is a 400.

| Method | Path | Auth | Body | Success |
|---|---|---|---|---|
| POST | /auth/register | none | `{ name, email, phone?, companyName?, country? }` | 202 `{ accepted: true }` for every address |
| POST | /auth/verify-email | none | `{ email, code, password }` (code: 6 digits; password: 12 to 72 bytes) | 200 `{ verified: true }` |
| POST | /auth/resend-verification | none | `{ email }` | 202 `{ accepted: true }` for every address |
| POST | /auth/login | none | `{ email, password }` | 200 session (below) |
| POST | /auth/refresh | none | `{ refreshToken }` | 200 session; the old token stops working |
| POST | /auth/logout | none | `{ refreshToken }` | 200 `{ loggedOut: true }` (idempotent) |
| POST | /auth/forgot-password | none | `{ email }` | 202 `{ accepted: true }` for every address |
| POST | /auth/reset-password | none | `{ email, code, newPassword }` | 200 `{ reset: true }`; ends every session |
| POST | /auth/delete-account | customer | `{ password }` | 200 `{ deleted: true }`; anonymises the account, ends every session |
| GET | /me | customer | | 200 profile (below) |
| GET | /photos/:photoId/image?size=thumb\|full | customer | | 200 the image bytes (below) |
| GET | /documents/:documentId/file | customer | | 200 the document bytes (below) |
| PATCH | /me | customer | any of `{ name, phone, companyName, country, destinationPort, language, theme }` (at least one) | 200 profile |

**Session** (login and refresh): `{ accessToken, accessTokenExpiresIn (seconds, 900), refreshToken, refreshTokenExpiresAt (ISO), user: { id, name, email } }`.

**Profile** (exactly these keys): `id, name, email, phone, companyName, country, destinationPort, language ("en" when unset), theme ("light" | "dark" | "system" | null), memberSince (ISO)`.

### Customer read API: what each endpoint returns

Every endpoint needs a customer token (except the version check). **Which vehicles:** the customer's own, same org, not deleted, an export-track vehicle (a local vehicle converted to export counts; an export vehicle converted to local does not), released by staff (`customerVisible`), and not cancelled. Anything else is absent from lists and is `404 { error: { code: "NOT_FOUND", message: "Vehicle not found." } }` on a detail route (the same for a vehicle that does not exist, belongs to someone else, or is not released). Query parameters are strict: an unknown one is a 400. Money is `{ amount: number, currency: string }` or null.

| Method | Path | Success |
|---|---|---|
| GET | /home | `{ name, activeCount, deliveredCount, nextDeparture: { vehicleId, serial, etd } \| null, recentVehicles: Summary[] (up to 3) }` |
| GET | /vehicles?page&pageSize&status&brand&sort&dir | `{ rows: Summary[], total, page, pageSize }` |
| GET | /vehicles/:vehicleId | `Detail` |
| GET | /vehicles/:vehicleId/timeline | `[{ type, label, completed, occurredAt }]`, always the 9 steps in order |
| GET | /vehicles/:vehicleId/photos | `[{ id, createdAt }]` released photos only; fetch the picture from `/photos/:id/image` |
| GET | /documents?page&pageSize&vehicleId | `{ rows: [{ id, name, type, createdAt, vehicle: { id, serial } }], total, page, pageSize }` released documents only; fetch the file from `/documents/:id/file` |
| GET | /purchase-history | `{ deliveredCount, customerSince }` (no total purchase value of any kind: the business does not want customers shown one) |
| GET | /help/faqs | `[{ id, question, answer }]` published, in order |
| POST | /vehicles/link-requests | `{ serial }` -> 202 `{ accepted: true }` (below) |
| GET | /app/min-version | no token: `{ minVersion }` (from `APP_MIN_VERSION`) |

**Summary** (exactly these keys): `id, serial, brand, model, grade, year, chassisNo, destination, status, purchaseDate, etd, eta, portOfLoading, portOfDischarge, vesselName, coverPhotoId, photoCount`. **Detail** is Summary plus `voyageNo, blNo, shippingMethod, containerNumber`. `status` is one of `PENDING, BOOKING_RECEIVED, SHIPPED, ARRIVED, DELIVERED`: the shipping status, overridden by the ARRIVED and DELIVERED milestones. `photoCount` and `coverPhotoId` count released photos only.

**List parameters:** `page` (1 and up, default 1), `pageSize` (1 to 50, default 20), `status` (one of the five above), `brand` (brand name, any case), `sort` = `purchaseDate` (default) | `arrival` (the ETA), `dir` = `desc` (default) | `asc`. Vehicles with no value for the sort field come last in both directions.

**No amount of any kind** is shown to a customer, anywhere (FTJ decision): no price, no per-vehicle amount, no total purchase value. `sort=price` is a 400. **Cancelled vehicles** (row colour "Unit Canceled" / "Resold in Auction") are never shown to customers, with no placeholder card; the cancellation reason and the row colour name stay hidden everywhere (question closed by FTJ). **Never in any customer response:** remarks and internal notes, auction hall, supplier, lot and item numbers, whether the auction bill is paid, transport and location, freight and packing agents, inspection details, selling price and other internal costs, partnership details, row colour, tri-state flags, other customers, the activity log, org and customer ids, or any storage address or key.

**Purchase history:** only the number of delivered vehicles and the member-since date. There is no total purchase value (and no per-currency total): it was removed on the business's instruction. Each vehicle still shows its own `amount`, if staff entered one.

**Link requests:** `serial` must look like `FC1024` or `FL88` (any case). The answer is the same `202` whatever the serial: nothing looks the vehicle up, so a request never confirms or denies that a vehicle exists. Staff (administrators, managers and the customer's assigned agent) are notified and decide later. A repeat of a pending request, or more than 20 pending, is ignored with the same answer. Limits: 10/min per IP and 5/hour per customer. (`/documents/:id/url` from the plan is replaced by `/documents/:id/file`.)

**Photos and documents** are addressed by database id only. The API checks, in order: your account (from the token), the vehicle (yours, same org, not deleted, export track, released by staff), then the file (released by staff; photos and documents are private by default). Only then does it read the object and stream it to you; it never redirects and never reveals where the file is stored. Any failure is the same `404 { error: { code: "NOT_FOUND", message: "File not found." } }`, including a file that exists but is not released. Response headers: `Content-Type` (jpeg, png, webp or pdf only), `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=<CUSTOMER_FILE_CACHE_SECONDS>`, `ETag` (send it back as `If-None-Match` to get a body-less `304`), `Content-Disposition: inline` for images and `attachment; filename=...` for documents. `size=thumb` returns the small version of a photo when one exists and the full image otherwise (default `full`). Limits: 300 requests/min per IP and 120/min per customer; then `429` with `Retry-After`.

How it signs up: `register` creates an unverified account with no password and emails a 6-digit code (valid 10 minutes, 5 attempts). `verify-email` takes that code **and** the password the customer chooses. A customer staff created (login enabled, no password yet) gets in through `forgot-password` then `reset-password`. `CUSTOMER_SELF_SIGNUP=false` turns register off.

Errors: 400 `VALIDATION` for bad input and for any wrong or expired code or credentials (one message each, whatever the cause); 403 `FORBIDDEN` for a locked account or a dead refresh token; 401 `UNAUTHENTICATED` for a bad or expired access token or an account that can no longer sign in; 429 `RATE_LIMITED` (with `Retry-After`).

Rate limits (per IP / per email or customer, from `src/config/customer-rate-limits.ts`; file gateway: 300/min per IP, 120/min per customer): register 5/min, 3/hour; verify-email 10/min, 10/10 min; resend-verification 5/min, 3/10 min; login 10/min, 20/15 min; refresh 30/min; logout 30/min; forgot-password 5/min, 3/hour; reset-password 10/min, 10/10 min; delete-account 5/min, 5/hour; me 60/min. Per-email limits count unknown addresses too.

### Public website API (Phase 2, slice 7)

**The exact contract for the website developer, with full examples, limits, errors and headers, is [website-integration.md](website-integration.md)** (checked against the code by `tests/website-contract.test.ts`). The summary below is for staff-side readers; if they disagree, fix them together.

Everything here exists only when `PUBLIC_STOCK_ENABLED=true` (otherwise 404, for the public routes and the staff stock tools alike). **No authentication**: a token, cookie or org in the request is ignored; the org is the server's default org. **CORS:** `PUBLIC_ALLOWED_ORIGINS` (the website origins), GET / POST / OPTIONS, header `Content-Type` only, no credentials, never `*`; the app origins (`CORS_ALLOWED_ORIGINS`) have no access to these routes and the website origin has none to the rest of the API. Query strings are strict (an unknown parameter is a 400).

| Method | Path | Success |
|---|---|---|
| GET | /api/public/stock?page&pageSize&make&model&bodyType&fuel&transmission&yearMin&yearMax&priceMin&priceMax&mileageMax&q&sort | `{ rows: Card[], total, page, pageSize }`. `pageSize` 1 to 24 (default 12). `sort` = newest (default) \| priceAsc \| priceDesc \| yearDesc \| yearAsc \| mileageAsc. Text filters ignore case; `q` searches make and model as plain text: it is trimmed and cut at 100 characters, `%`, `_` and backslash are literal characters (escaped), and a blank `q` means no search. A row with no price or mileage never matches a price or mileage range |
| GET | /api/public/stock/:slug | `Detail`; a draft, sold, other-org, malformed or unknown slug is the same `404 Stock vehicle not found.` |
| POST | /api/public/enquiries | `{ name, email, phone?, message, stockSlug?, website?, turnstileToken? }` -> **202 `{ accepted: true }`** whatever happens to it (stored; dropped as a bot; listing no longer public) |

**Card** (exactly these keys): `slug, make, model, year, price, mileageKm, bodyType, fuel, transmission, colour, publishedAt, image` (`image` is `{ url, alt }` or null). **Detail** is Card plus `description` and `images: [{ url, alt }]`, in order. `price` is `{ amount, currency: "LKR" }` or null, **never a bare number**: every listing price is in Sri Lankan rupees (whole rupees), with no conversion and no currency parameter (`STOCK_PRICE_CURRENCY` in `src/config/public-stock.ts`; the database column `StockVehicle.priceFob` holds that LKR price, its name is historical). The website must always label it LKR. Multi-currency is deferred (`docs/deferred/currency-localization.md`). **Never** in any public response: ids, the org, the status, internal timestamps, storage keys, serials, customer data, supplier, auction, costs. Only `PUBLISHED` listings are returned. Image URLs are `PUBLIC_STOCK_IMAGE_BASE_URL/<key>` of the PUBLIC bucket; a listing with no public base URL configured has no images.

**Enquiry form rules.** `name` 1 to 100, `email` valid (max 150, stored lower case), `phone` optional (digits, `+`, spaces, dashes, brackets), `message` plain text 1 to 2000 (no control characters), `stockSlug` optional (dropped if not a published listing), body at most 8 KB (413 becomes 400 `Invalid request.`). `website` is a hidden field: if it holds anything the visitor gets the normal 202 and nothing is stored or announced. With `TURNSTILE_SECRET` set a missing, wrong or unverifiable `turnstileToken` is a 400 (fails closed); unset, the check is skipped. Limits: 5 a minute per IP (route), 10 an hour per IP, 3 an hour per email (429 with Retry-After); honeypot hits count. Nothing the visitor typed is written to a log, notification or error. No ActivityLog row is written when a visitor submits (there is no actor).

**Staff stock tools** (`/api/v1`, ADMINISTRATOR and MANAGER, `STOCK_ROLES`; another org's id is 404; each mutation writes an ActivityLog row in the same transaction):

| Method | Path | Notes |
|---|---|---|
| GET / POST | /stock | list (`status`, `page`, `pageSize`) / create a DRAFT `{ make, model, year?, price? (whole rupees, > 0, at most 2,000,000,000, or null), mileageKm?, bodyType?, fuel?, transmission?, colour?, description? }` -> 201; the slug is generated and cannot be set |
| GET / PATCH / DELETE | /stock/:id | one listing with its images / partial edit (null clears; status and slug cannot be edited) / delete with its images and objects |
| POST | /stock/:id/publish | DRAFT -> PUBLISHED, needs at least one image (400 otherwise), `{ notifyCustomers?: boolean }` tells customers who have not switched "new stock" off (at most 1000); 409 if not a draft |
| POST | /stock/:id/unpublish | PUBLISHED or SOLD -> DRAFT |
| POST | /stock/:id/mark-sold | PUBLISHED -> SOLD (no longer public) |
| POST | /stock/:id/images/presign | `{ contentType: jpeg \| png \| webp, fileSize <= 8 MB }` -> a 5 minute signed upload to the PUBLIC bucket, key `stock/<org hash>/<random>.<ext>` (no org id in the address) |
| POST | /stock/:id/images | `{ key, altText? }` registers an uploaded image: the key must be one this API issued for this org (400), unused (409); at most 20 per listing |
| PATCH / DELETE | /stock/:id/images/:imageId | alt text and position / delete (a published listing keeps at least one image) |
| POST | /stock/:id/images/reorder | `{ imageIds }` must be exactly the listing's own images, each once |
| GET | /enquiries?status=open\|handled\|all | the website enquiries inbox |
| POST | /enquiries/:id/handled | `{ handled: boolean }` |

### Chat (Phase 2, slice 6)

Plain text only; no attachments. A message is trimmed, 1 to 2000 characters, with no control characters except line breaks and tabs; line breaks are normalised to `\n`. It is stored exactly as typed and only ever returned as a JSON string (the API never renders it as markup). Bodies are strict: a sender, customer, org or attachment field is a 400.

**Customer** (`/api/customer/v1`, customer token; another customer's or another org's conversation, an unknown id and a bad id are all the same `404 Conversation not found.`):

| Method | Path | Success |
|---|---|---|
| GET | /chat/suggested-questions | `{ questions: string[] }` (static) |
| GET | /conversations?page&pageSize | `{ rows: [{ id, vehicle: { id, serial } \| null, lastMessageAt, lastMessage: { senderType, snippet, createdAt } \| null }], total, page, pageSize }`. The vehicle is named only while the customer may still see it |
| POST | /conversations | `{ vehicleId?, body }` -> 201 `{ conversation: { id, vehicleId }, message }`. A vehicle must be the customer's own and released (otherwise `404 Vehicle not found.`, the same for unknown, someone else's and unreleased). At most 50 conversations (409) and 10 new ones an hour |
| GET | /conversations/:id/messages?page&pageSize | `{ rows: [{ id, senderType: "CUSTOMER" \| "STAFF", body, createdAt }], total, page, pageSize }`, newest first. Staff identity is never shown |
| POST | /conversations/:id/messages | `{ body }` -> 201 the message. 15 a minute per customer (429 with Retry-After) |

**Staff** (`/api/v1`; `CHAT_ROLES` = ADMINISTRATOR, MANAGER, OPERATOR; VIEWER is 403 on every chat route). **Scope** (`src/config/roles.ts`, FTJ decision): ADMINISTRATOR and MANAGER reach every conversation of their org; an OPERATOR reaches only conversations of customers whose `assignedAgentId` is that operator. The assignment, the user's `loginEnabled` and the user's CURRENT role are read from the database on every request, so reassigning a customer removes the old agent's access at once and a deactivated user has none (403). Anything out of scope (another agent's customer, an unassigned customer, another org's conversation, an unknown id) is the same `404 Conversation not found.` The scope applies to the inbox list, reading, replying and marking handled. Link request approval and rejection stay ADMINISTRATOR and MANAGER:

| Method | Path | Success |
|---|---|---|
| GET | /chat/conversations?status=open\|handled\|all&page&pageSize | inbox, newest activity first: `{ rows: [{ id, customer: { id, name, companyName }, vehicle \| null, lastMessageAt, handled, lastMessage }], total, page, pageSize }` |
| GET | /chat/conversations/:id/messages?page&pageSize | `{ conversation: { id, customer, vehicle, handled }, rows: [{ id, senderType, senderName \| null, body, createdAt }], total, page, pageSize }` |
| POST | /chat/conversations/:id/messages | `{ body }` -> 201 the reply (writes ActivityLog `REPLY_CHAT_MESSAGE`, without the text) |
| POST | /chat/conversations/:id/handled | `{ handled: boolean }` -> `{ id, handled }` (`MARK_CONVERSATION_HANDLED` / `REOPEN_CONVERSATION`). A new customer message reopens it |

**Who is told.** After the transaction commits, the other party only gets (1) a live `event: message` on their stream with `{ conversationId, messageId, senderType, createdAt }` (never the text; the client fetches it) and (2) at most one alert per burst (the first message, a change of sender, or a pause of more than 5 minutes) with a fixed text ("New message from <customer name>" for staff, "You have a new message from the CargoDev team." for the customer): no message text ever travels by push or email. Recipients are decided from the database at that moment: the customer's assigned agent if they are an active staff member of the org whose role may open chat; otherwise (no agent, or an agent who cannot open chat) the active administrators and managers. Never a user who could not open the conversation. The live event goes to the same people as the alert. A customer who switched off `CHAT_MESSAGE` alerts still gets the live message.

**Assigned agents (closed by FTJ).** An OPERATOR who is a customer's assigned agent reads and answers that customer's chat (and only theirs). Operators have no access to link request decisions, and VIEWERs have no access to chat at all.

**Rejection reasons.** `POST /link-requests/:id/reject` now takes an optional `{ reason }` (1 to 500 characters, plain text). The reason reaches the customer as a staff chat message ("About your request to link FC999: ...") in their most recent general conversation (created if needed), in the same transaction as the decision. The standing alert still says only that the request could not be approved. The text is not written to the ActivityLog (only `reasonGiven`). Deleting a customer account deletes their conversations, messages, alerts and notification settings.

### Customer alerts, preferences, devices, presence and stream (Phase 2, slice 5)

All under `/api/customer/v1`, customer token. Everything is the token's own customer (org and id from the verified token). A staff token, no token or a disabled customer is 401. Bodies and queries are strict.

| Method | Path | Success |
|---|---|---|
| GET | /alerts?page&pageSize | `{ days: [{ date: "YYYY-MM-DD" (UTC), alerts: [{ id, event, title, body, isRead, vehicleId \| null, createdAt }] }], unreadCount, total, page, pageSize }`, newest first. `vehicleId` is shown only while the customer may still see that vehicle |
| POST | /alerts/mark-read | body `{ ids: string[1..200] }` or `{ all: true }` -> `{ updated }`. An id that is not the customer's changes nothing and is not an error |
| GET / PATCH | /me/notification-preferences | `{ events: { BOOKING_RECEIVED, PHOTOS_ADDED, DOCUMENTS_READY, DEPARTURE_REMINDER, NEW_STOCK, CHAT_MESSAGE: boolean }, departureLeadDays: 3 \| 7 \| 14, pushEnabled, emailEnabled, whatsappEnabled }`. PATCH takes any of those (at least one; events is a partial map). Defaults: all on, 7 days, WhatsApp off and never sent. Link request results (`LINK_REQUEST_APPROVED`, `LINK_REQUEST_REJECTED`) cannot be switched off |
| POST | /devices | `{ expoPushToken, platform: "ios" \| "android", appVersion? }` -> `{ id, platform, lastSeenAt }` (the token is never echoed). At most 10 devices per customer (the oldest is dropped). A token that belongs to a staff device is refused (400) |
| DELETE | /devices/:id | `{ deleted: true }`; another customer's or an unknown device is 404 |
| POST | /presence/heartbeat | `{ ok: true }` always. Writes `lastActiveAt` only if the stored value is older than 60 s. "Active" (for staff) is the last 5 minutes |
| GET | /stream | Server-Sent Events, token in the Authorization header. `event: notification` with `{ id, event, title, body, vehicleId, createdAt }`; `event: reauth` and close at token expiry; at most 3 streams per customer (oldest closed with `event: closed`). Delivers only events published for this customer, never a staff event. No replay: call `GET /alerts` after reconnecting |

**How a customer is told.** Staff actions write the alert in the same transaction, then (after commit) publish to the stream, send Expo push, and queue email: booking received (the staff edit that makes the vehicle Booking Received), photos added (photos released; one alert per 10-minute burst), document ready (export certificate or bill of lading released), departure reminder (the daily job, on the day the ETD is exactly the chosen 3, 7 or 14 days away, once per vehicle per day), link request approved or rejected. Alerts exist only for vehicles the customer may see. A switched-off event produces no alert, push or email; `pushEnabled` and `emailEnabled` switch the channels. Email goes to a verified, enabled, undeleted customer only, after the response, through `src/lib/email.ts`. "New stock" is reserved for slice 7 and not sent yet.

**One-time codes.** Stored as HMAC-SHA256 keyed by `OTP_PEPPER`. At most 5 code requests per address and 20 per IP per hour (register, resend and forgot together, `src/config/otp-limits.ts`); beyond that the answer is the same 202 but no code is issued and no email is sent. Email is sent after the response.

### Staff tools for customers (Phase 2, slice 4)

All under `/api/v1`, staff token. Roles come from `src/config/roles.ts`: **ADMIN** = ADMINISTRATOR, MANAGER; **ARRIVAL** = ADMINISTRATOR, MANAGER, OPERATOR. A customer token is 401. Another org's id, a deleted or an unknown id is 404 (never 403). Bodies are strict (unknown fields are 400). Every mutation writes an ActivityLog row in the same transaction.

| Method | Path | Roles | Body | Success / notes |
|---|---|---|---|---|
| PATCH | /customers/:id/login-access | ADMIN | `{ loginEnabled }` | `{ id, loginEnabled }`. Disabling revokes **all** the customer's sessions and deletes their device tokens in the same transaction, so an access token already issued stops working at the next request. Enabling needs an email address (400 otherwise) |
| PATCH | /customers/:id/agent | ADMIN | `{ agentId \| null }` | `{ id, assignedAgentId }`. The agent must be an active staff member of the same org (400 otherwise) |
| GET | /staff/customers/active | ADMIN | | `[{ id, name, companyName, lastActiveAt }]`, customers seen in the last 5 minutes, newest first |
| GET | /link-requests?status&page&pageSize | ADMIN | | `{ rows, total, page, pageSize }`; status PENDING (default), APPROVED, REJECTED. Each row: `id, status, serialEntered, createdAt, decidedAt, customer { id, name, email, companyName }, vehicle, matchedVehicle { id, serial, ownedByThisCustomer, ownedByAnotherCustomer } \| null` |
| POST | /link-requests/:id/approve | ADMIN | `{ vehicleId? }` | `{ id, status, vehicle { id, serial } }`. Links the vehicle to the customer, notifies them (`LINK_REQUEST_APPROVED`). Does **not** release the vehicle. 409 if already decided or the vehicle belongs to another customer; 400 when no vehicle has the typed serial and none was named |
| POST | /link-requests/:id/reject | ADMIN | `{}` | `{ id, status }`. Notifies the customer (`LINK_REQUEST_REJECTED`) with no reason and no hint about the vehicle. 409 if already decided |
| GET / POST | /faqs | ADMIN | create: `{ question, answer, sortOrder?, published? }` | list includes drafts; create is 201 |
| PATCH / DELETE | /faqs/:id | ADMIN | update: any of the create fields (at least one) | |
| PATCH | /vehicles/:id/customer-visibility | ADMIN | `{ customerVisible }` | `{ id, customerVisible }`. 400 when the vehicle has no customer or is a local (FL) vehicle |
| PATCH | /vehicles/:id/customer-info | ADMIN | any of `portOfLoading, portOfDischarge, voyageNo` (text, empty or null clears), (an amount or currency is an unknown field: 400) | the saved ports and voyage |
| PATCH | /vehicles/:id/documents/:docId | ADMIN | `{ documentType?, visibleToCustomer? }` | `{ id, documentType, visibleToCustomer }`. The document must belong to that vehicle |
| PATCH | /vehicles/:id/photos/:photoId | ADMIN | `{ visibleToCustomer }` | `{ id, visibleToCustomer }` |
| PATCH | /vehicles/:id/photos | ADMIN | `{ visibleToCustomer, photoIds: string[1..200] }` | `{ updated, visibleToCustomer }`. All or nothing: any id that is not this vehicle's is 404 and nothing changes. There is no "all photos" form |
| GET | /vehicles/:id/release-readiness | ADMINISTRATOR, MANAGER, OPERATOR | | Read-only. Booleans and counts only, nothing else: `{ customerLinked, customerVisible, photosReleased, photosHidden, documentsReleased, documentsHidden }`. No ids, names or addresses; another org's, a deleted or an unknown vehicle is 404 |
| POST | /vehicles/:id/mark-arrived | ARRIVAL | `{ occurredAt? }` | the ARRIVED milestone (same as `PUT /milestones/ARRIVED`) |
| POST | /vehicles/:id/mark-delivered | ARRIVAL | `{ occurredAt? }` | the DELIVERED milestone |

ARRIVED and DELIVERED are recorded by staff only; nothing sets them automatically. The daily job reminds staff (`ARRIVAL_NOT_RECORDED` notification) about a vehicle shipped `ARRIVAL_REMINDER_DAYS` (default 45) days ago with no ARRIVED or DELIVERED milestone: on that day, then every 7th day, at most once a day per vehicle. Export-track vehicles that are not cancelled or deleted only. A link request that is ignored (duplicate or over the pending cap) logs a masked warning with the customer id only; the customer's answer is unchanged.

**Staff vehicle detail** (`GET /vehicles/:serial`) now also returns `customerVisible, portOfLoading, portOfDischarge, voyageNo`.

### Not built yet

| Area | Why |
|---|---|
| Live check of the R2 store | The R2 client is built and tested offline (endpoint, checksum settings, signed headers). It has not talked to a real bucket yet; the maintainer runs the first upload and read against staging. |
| Reserve with 48 hour expiry, cost / CIF estimator, phone or any other OTP channel (decided: email codes only), WhatsApp sending, OpenAPI generation, chat attachments | Deferred or declined on purpose. |
| Customer app stock tab and saved vehicles | Pending FTJ decision; proposed design in `docs/deferred/customer-app-stock.md`. No customer-side stock endpoint exists. |
| Customer message inbox for staff | Slice 6 (with chat). |

## Known doc drift

The vehicle list `sort` default in code is `purchaseDate desc`. Follow the code.
