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

- Every response has `Cache-Control: no-store`.
- Dates are ISO 8601 strings. Decimals are plain numbers.
- A resource in another org returns 404, never 403.
- `orgId` always comes from the verified token. Any `orgId` in a request is ignored.
- Auth: `Authorization: Bearer <accessToken>` (HS256 JWT, 20 minutes).
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
| GET | /api/v1/customers?q= | any staff | done |
| GET | /api/v1/customers/search?q= | any staff | done |
| GET | /api/v1/customers/:id | any staff | done |
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
| GET | /api/v1/reports/by-customer?track=FC\|FL | any staff | done |
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

### Vehicle files

File bytes never pass through this API; the database stores URLs. A URL is accepted only if it is under `R2_PUBLIC_URL` and inside the caller's own org folder: `org/<orgId>/uploads/staging/` when creating a vehicle, or `org/<orgId>/vehicles/<vehicleId>/{photos|documents|auction-sheet}/` for an existing one. Anything else is 400 with `fieldErrors.url`. When `R2_PUBLIC_URL` is not set, every file URL is refused.

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | /api/v1/vehicles/:serial/files | any staff | Auction sheet, photos, documents |
| GET | /api/v1/vehicles/:serial/pdf-images | any staff | Auction sheet and photos as data URLs for the PDF export. The server re-checks each stored URL, refuses redirects, caps size (15 MB) and time (10 s), and returns images only; a failed image is skipped |
| POST | /api/v1/vehicles/:id/photos | ADMINISTRATOR, MANAGER, OPERATOR | `{ url }`, 201 |
| POST | /api/v1/vehicles/:id/photos-added | ADMINISTRATOR, MANAGER, OPERATOR | `{ count }`. One notification for a batch of photos |
| POST | /api/v1/vehicles/:id/documents | ADMINISTRATOR, MANAGER, OPERATOR | `{ url, name, documentType }`, 201 |
| PUT | /api/v1/vehicles/:id/auction-sheet | ADMINISTRATOR, MANAGER, OPERATOR | `{ url }`. Replaces the sheet |
| DELETE | /api/v1/vehicles/:id/photos/:photoId | ADMINISTRATOR, MANAGER | |
| DELETE | /api/v1/vehicles/:id/documents/:docId | ADMINISTRATOR, MANAGER | |

Deleting removes the database row. Removing the stored object needs the object-storage SDK and is not done yet; the object is left in place.

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

### Not built yet

| Area | Why |
|---|---|
| File presign (`POST /uploads/presign`) and deleting stored objects | Needs an S3-compatible SDK, not added yet. Until then clients cannot upload through this API. |
| Customer accounts and login | Out of scope (CLAUDE.md, ADR 0001). Customers exist only as records. |

## Known doc drift

The vehicle list `sort` default in code is `purchaseDate desc`. Follow the code.
