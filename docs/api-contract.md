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
| POST | /api/v1/auth/logout | public | done |

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
| POST | /api/v1/device-tokens `{ "expoPushToken", "platform" }` | done |
| DELETE | /api/v1/device-tokens `{ "expoPushToken" }` (idempotent) | done |

### Not built yet

| Area | Why |
|---|---|
| Vehicles (list, detail, filters, mutations, files) | `vehicle.service` is not ported yet. |
| File presign | Needs an S3-compatible SDK. |
| Cron | Depends on `reminder.service`, which needs `vehicle.service`. |
| Live in-app notification stream | Not built. Mobile gets Expo push; clients poll `/notifications/unread-count`. |

## Known doc drift

The vehicle list `sort` default in code is `purchaseDate desc`. Follow the code.
