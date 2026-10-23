# API contract

Source of truth for clients. Update this file in the same PR that changes behaviour.

## Envelope

Success: `{ "data": <payload> }`
Error: `{ "error": { "code": "...", "message": "...", "fieldErrors": { "field": ["msg"] } } }` (`fieldErrors` optional)

## Error codes

| Code | HTTP |
|---|---|
| VALIDATION | 400 |
| UNAUTHENTICATED | 401 |
| FORBIDDEN | 403 |
| NOT_FOUND | 404 |
| CONFLICT | 409 |
| INTERNAL | 500 |

## Conventions

- Every response has `Cache-Control: no-store`.
- Dates are ISO 8601 strings. Decimals are plain numbers.
- A resource in another org returns 404, never 403.
- Auth: `Authorization: Bearer <accessToken>` (HS256 JWT, 20 minutes).
- Roles: `ADMINISTRATOR | MANAGER | OPERATOR | VIEWER`.

## Endpoints

Status: `todo` / `done`. Roles column is the allow-list. Fill from the CargoDev action files, do not guess.

| Method | Path | Roles | Status |
|---|---|---|---|
| GET | /health | public | done |
| POST | /api/v1/auth/login | public | todo |
| POST | /api/v1/auth/refresh | public | todo |
| POST | /api/v1/auth/logout | public | todo |
| GET | /api/v1/vehicles | any staff | todo |
| GET | /api/v1/vehicles/:serial | any staff | todo |
| POST | /api/v1/vehicles | ADMINISTRATOR, MANAGER | todo |
| PATCH | /api/v1/vehicles/:id | ADMINISTRATOR, MANAGER | todo |

Add the remaining endpoints from the replication brief as they are built.

## Known doc drift

The vehicle list `sort` default in code is `purchaseDate desc`. Follow the code.
