# Legacy parity report

Compares the **original mobile API contract** (`docs/legacy/mobile-api-reference.md`, "the legacy document") with the current API. Written 2026-11-03. Read-only: nothing here changed a behaviour.

## How to read it

**Marks**

| Mark | Meaning |
|---|---|
| SAME | The current API does what the legacy document says |
| ADDITIVE | The current API does more (a new endpoint, key, parameter or code); a client built to the legacy document is not broken by it, unless noted |
| CHANGED | The current API behaves differently from what the legacy document says or implies; the effect on an old client is stated |
| MISSING | The legacy document describes it and the current API does not have it |
| UNKNOWN | The legacy document does not say, so nothing can be compared; what is needed to settle it is stated |

**Evidence tags**

- **[T]** pinned by `tests/legacy-contract.test.ts` (fake data; the test names the legacy lines it pins)
- **[C]** read from the current code (file and line)
- **[D]** read from a real response of the current API for fake data (the examples in `docs/staff-frontend-integration.md`)
- **[P]** from `docs/implementation-plan.md`, the porting brief written from the old app

The legacy document describes **response shapes only in outline**: it names a few keys and otherwise says `VehicleListRow[]`, "full vehicle detail", "KPI cards" and similar. Everywhere a key set is not listed there, the row is UNKNOWN and says what is needed (the old TypeScript types or one real old response). The old route handlers (`app/api/v1`) and `lib/vehicle-list-url.ts` are not in this repository.

## Summary

- **Every legacy endpoint exists** under the same method and path: 54 of 54 (3 public auth routes, 51 staff routes). **MISSING: none.** Roles match the legacy document where it states them. [T] [C]
- **CHANGED (5):** file `url` values; customer contact details for a VIEWER (two endpoints); role and deactivation checks on every request; `vehicleCount`; redaction in the activity log.
- **ADDITIVE:** the whole write side (the legacy API was read-only apart from notifications and device tokens), rate limits with a new `RATE_LIMITED` 429, `X-Request-Id`, exposed CORS headers, the notification stream, 409 now in use, and some extra keys and parameters.
- **UNKNOWN:** most response key sets (the legacy document does not list them), a few messages, and whether the original refresh rotation revoked every session on reuse.

## 1. Authentication (legacy lines 17-83)

| Aspect | Legacy | Current | Mark | Effect on a client built to the legacy contract / what is needed |
|---|---|---|---|---|
| `POST /api/v1/auth/login`, `/auth/refresh`, `/auth/logout` | Three public routes, no bearer token | Same method and path, public | SAME [C] | |
| Sign-in body | `{ email, password }` | Same | SAME [T] | |
| Sign-in `200` keys | `accessToken`, `accessTokenExpiresIn` 1200, `refreshToken`, `refreshTokenExpiresAt`, `user { id, name, email, role, orgId }` | Exactly those keys; 1200; about 30 days | SAME [T] [D] | |
| Wrong password | `400 VALIDATION` | `400 VALIDATION`, message "Invalid email or password." | SAME (status and code) [T] | The legacy document gives no message text |
| Unknown email | "wrong credentials": `400 VALIDATION` | `400`, identical body to a wrong password | SAME [T] | |
| Deactivated account | Not stated (`400` for "wrong credentials" is implied) | `400`, identical body (the account is filtered out of the lookup) | UNKNOWN [C] `staff-auth.service.ts` `loginEnabled` filter, `mobile-auth.service.ts:108` | Needs the old route handler to confirm it was not a `403` |
| Validation error | `400 VALIDATION`, `fieldErrors { field: "..." }` | `400`, "Please check your email and password.", `fieldErrors.email` / `fieldErrors.password` as strings | SAME [T] | |
| Locked account | `403 FORBIDDEN` after 5 failures, 15 minutes | `403 FORBIDDEN` after 5 failures, 15 minutes | SAME [T] | Message text not in the legacy document |
| Rate limit on sign-in | Not stated | 10 a minute per client address, `429 RATE_LIMITED` with `Retry-After` | ADDITIVE [D] | A client with no 429 handling shows a generic error when many people sign in from one address |
| Access token | JWT, 20 minutes | 20 minutes | SAME [T] | |
| Refresh body | `{ refreshToken }` | Same | SAME [T] | |
| Refresh `200` | Same shape as sign-in; the sent token is revoked | Same keys; a new pair; the sent token stops working | SAME [T] | |
| Refresh failure | `403 FORBIDDEN` "Session expired. Please sign in again." for unknown, expired, used/revoked, deactivated | The same status, code and exact message for all five cases | SAME [T] | |
| Refresh with a missing body | Not stated | `400 VALIDATION` "A refresh token is required." | UNKNOWN [C] `mobile-auth.service.ts:117` | Needs the old route handler |
| Reusing a rotated refresh token | `403` | `403`. Inside 10 seconds nothing else happens (a lost race). **Later than 10 seconds, the whole family of that user's sessions is revoked** | UNKNOWN [C] `mobile-auth.service.ts:130-136` | The `403` is the same; the revoke-everything part is not in the legacy document. Needs the old service code to know whether it was original |
| Rate limit on refresh | Not stated | 10 a minute per client address | ADDITIVE [D] | As for sign-in |
| Logout | Body `{ refreshToken }`, `200 { loggedOut: true }`, idempotent (unknown or revoked token is still success) | The same, plus an optional `expoPushToken` in the body that also removes that device | SAME [T]; the extra field is ADDITIVE [C] `mobile-auth.service.ts:218` | |
| Revoked when | Admin deactivation, or the password changed by the user or an admin | Both, and **also a role change** | SAME [T]; role change ADDITIVE [C] `user.service.ts:271` | An old client is signed out slightly more often |
| The next refresh after either event | `403 FORBIDDEN` | `403 FORBIDDEN` | SAME [T] | |
| Authorization checked against | A JWT verified locally, no database read per request ([P] section 4.2) | The role and the active flag are read from the database on every request (cached 30 seconds, cleared at once in the same process) | **CHANGED** [C] `staff-auth-state.service.ts` | A deactivated person, or one whose role was lowered, is stopped on the next request instead of when the access token expires (up to 20 minutes). Only stricter. A client sees `401` or `403` sooner |
| Customers | Cannot use this API | A customer token is refused with `401` on every staff route | SAME [T] (route inventory) | |

## 2. Envelope, error codes, caching (legacy lines 85-109, 349-359)

| Aspect | Legacy | Current | Mark | Effect / needed |
|---|---|---|---|---|
| Success | `{ data }` | Exactly `{ data }` | SAME [T] | |
| Error | `{ error: { code, message, fieldErrors? } }`, `fieldErrors` only on `VALIDATION`, values are strings | The same | SAME [T] | |
| `400 VALIDATION`, `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `500 INTERNAL` | As stated | As stated | SAME [T] | |
| `409 CONFLICT` | "Reserved for future write endpoints; unused" | Used: a taken serial, a duplicate email or name, a decision already made | ADDITIVE [T] | None for a read-only client |
| `429 RATE_LIMITED` | Not in the table | New code, with `Retry-After` and `X-RateLimit-*` | ADDITIVE [D] | A legacy client that switches on the code table has no case for it |
| Another organisation's resource | `404`, never `403`, same as a missing one | Identical `404` body | SAME [T] | |
| `Cache-Control: no-store` on every response | Yes | Yes on every `/api/v1` response (file links under `/f/v1` and the customer and public zones have their own rules, outside this document) | SAME [T] | |
| Tri-state `auctionBillPaid`, `logBook`, `extraKey` | `true`, `false` or `null`; never coerce `null` | The same; the `BLANK` filter means `null` | SAME [T] | |
| Dates | ISO 8601 strings | The same | SAME [T] | |
| `org_id` never a request parameter | Always from the token | The same; a body or query value naming an organisation is not used | SAME [T] | |
| Extra headers | None | `X-Request-Id` on every answer; `Access-Control-Expose-Headers` lists it and the rate-limit headers | ADDITIVE [T] | |

## 3. Vehicles (legacy lines 111-199)

| Aspect | Legacy | Current | Mark | Effect / needed |
|---|---|---|---|---|
| `GET /vehicles` roles | Any staff role | Any staff role | SAME [T] | |
| Parameters | `page`, `pageSize`, `track`, `q`, `status` (repeatable), `destination`, `customer`, `rowColour`, `rowColourNot`, `brand`, `model`, `grade`, `hall`, `supplier`, `agent`, `packingAgent`, `location`, `transport`, `currency`, `method`, `billPaid`, `logBook`, `extraKey`, `paidByCustomer`, `partnership`, `converted`, `etdFrom/To`, `etaFrom/To`, `sort`, `dir` | Every one is still accepted with the legacy values | SAME [T] | One extra parameter exists (`convertedLocal`): ADDITIVE [C] `vehicle.schema.ts` |
| Defaults | `page` 1, `pageSize` 50, `track` `FC`, `sort` `serial`, `dir` `desc`, no filters | The same | SAME [T] | **Held** by decision: the default sort and track are not to change until the old route handler is checked. `docs/implementation-plan.md` says the old web code defaulted to `purchaseDate desc`; that is not what the legacy mobile document says |
| `pageSize` | 1 to 100 | 1 to 100; `0` and `101` are `400`, never clamped | SAME [T] | |
| Invalid filter value | `400 VALIDATION` (not a silent fallback) | `400 VALIDATION` | SAME [T] | |
| `status` values | `PENDING`, `BOOKING_RECEIVED`, `SHIPPED`, `CANCELLED` | The same, repeatable | SAME [T] | |
| Sort keys | 14 keys | All 14 accepted | SAME [T] | |
| `BLANK` | "field is null (not entered)" | Same; distinct from `NO` | SAME [T] | |
| Response wrapper | `{ rows, total, page, pageSize, totalPages }` | Exactly those keys | SAME [T] | |
| Row keys | `VehicleListRow[]`, not listed | 54 keys today (including `shipmentStatus` stored and `effectiveShipmentStatus`) | UNKNOWN [D] | Needs the old `VehicleListRow` type to say which keys were added or lost |
| `GET /vehicles/filter-options` | The exact object on lines 150-167 | Exactly equal | SAME [T] | |
| `GET /vehicles/destinations` | `string[]` | `string[]` | SAME [D] | |
| `GET /vehicles/:serial` | Full detail by serial; `404` if absent or another organisation's | Same path and `404` | SAME [T] | |
| Detail keys | Not listed | 59 keys [D] | UNKNOWN | Needs the old detail type or one real old response |
| **(a) Detail `shipmentStatus`: stored or effective?** | Not stated in the legacy document | Effective (a past ETD reads `SHIPPED`; a cancelled row colour reads `CANCELLED` on FC). New key `storedShipmentStatus` carries the stored value | Value: **UNKNOWN in the document**, and the ported service comment says the old detail already used the effective value ("Same computed guard on read the vehicles table uses", `vehicle.service.ts` in the first port commit, `f4837b8`), so SAME is the best reading. `storedShipmentStatus`: ADDITIVE [C] [T] | Needs the old route handler or one old response to be certain. A client reading only `shipmentStatus` is unaffected either way |
| `GET /vehicles/:serial/status-history` | Chronological transitions; always empty for FL | Same path; FL returns `[]` | SAME [T] | Row keys UNKNOWN (current: `id`, `fromStatus`, `toStatus`, `triggerLabel`, `triggeredByName`, `createdAt` [D]) |
| **(b) `GET /vehicles/:serial/files`** | `{ auctionSheetUrl, photos, documents }`, **"plain public R2 URLs (not presigned)"** | Same three top keys. **Every `url` is now a short-lived link on this API's own domain** (`/f/v1/...`, signed, 5 minutes by default, 15 at most). Each item gains `expiresAt`; the sheet gains `auctionSheetExpiresAt`; items also carry `uploaderName`, `createdAt` (documents also `name`, `documentType`) | **CHANGED** (values), ADDITIVE (keys) [D] | A client that stores or caches the `url`, or loads it after 5 minutes, gets a `404` (every failure is one identical `404`). It must refetch the list (cheap) and use the link right away. A client that only displays the link works. Nothing in the link reveals the storage host. See section 9 |
| `GET /vehicles/:serial/pdf-images` | Auction sheet and photos as base64 data URLs; "for parity with the web PDF export" | Same path; `{ auctionSheetDataUrl, photoDataUrls }` | UNKNOWN [D] | The legacy document gives no key names |

## 4. Customers (legacy lines 201-207)

| Aspect | Legacy | Current | Mark | Effect / needed |
|---|---|---|---|---|
| `GET /customers?q=` | Full list with `vehicleCount`, "optionally filtered by name/email/phone"; any staff role | Same path; any staff role; rows `id, name, email, phone, country, address, createdAt, vehicleCount` | SAME for ADMINISTRATOR, MANAGER, OPERATOR [D] | Row keys beyond `vehicleCount` UNKNOWN in the legacy document |
| **(d) Same, as a VIEWER** | Same as every other role (not stated otherwise) | **No `email`, `phone` or `address` keys at all** (absent, not null), and `q` matches the name only | **CHANGED** [T] [D] | A viewer client that shows or searches email and phone gets nothing: the column is empty and the search finds fewer people. By decision (a viewer must not see contact details). See section 9 |
| `vehicleCount` | Not defined | Counts vehicles that are **not soft-deleted** | **CHANGED** (probably): the ported code counted soft-deleted vehicles [C] before this API's fix; the legacy document does not say | Counts can be lower than an old client showed. UNKNOWN whether the original counted deleted ones; needs the old query |
| `GET /customers/search?q=` | `{ id, name }` results | Exactly `{ id, name }` | SAME [T] | |
| `GET /customers/:id` | `{ id, name }`; `404` if not found | Exactly `{ id, name }`; `404` | SAME [T] | |
| Write side | None | Create, update (now a real PATCH), login access, agent assignment | ADDITIVE | |

## 5. Lookups (legacy lines 209-228)

| Aspect | Legacy | Current | Mark | Effect / needed |
|---|---|---|---|---|
| Every list and `:id` path in the table (brands, models, grades, auction halls, suppliers, transport companies, packing agents, vehicle locations, inspection companies, inspection-by, freight agents and search, row colour statuses) | Any staff role | All 13 list and search paths and all 11 id paths exist, any staff role | SAME [T] (route inventory) | |
| Search | Optional `?q=`, up to 20 matches | Up to 20 | SAME [T] | |
| Parents | Models need `brandId`; grades need `modelId` | `400` without them | SAME [T] | |
| Unknown `:id` | `404 NOT_FOUND` | `404 NOT_FOUND` (11 resources checked) | SAME [T] | |
| Freight agents | Full list with `offersRoro` / `offersContainer`; search takes `method=RORO\|CONTAINER` | Keys exactly `id, name, offersContainer, offersRoro`; `method=AIR` is `400` | SAME [T] | |
| Row colour statuses | Full list only, no search | A full list (keys `id, name, colour, transportCellOnly` [D]) | SAME [T]; key names UNKNOWN in the legacy document | |
| Write side | None | Create and rename for each | ADDITIVE | |

## 6. Reports and dashboard (legacy lines 230-245)

| Aspect | Legacy | Current | Mark | Effect / needed |
|---|---|---|---|---|
| `GET /reports/by-customer`, `/by-auction-hall`, `/by-destination` | `track` is `FC` or `FL`, no `ALL`, default `FC` | The same; `ALL` is `400` | SAME [T] | |
| `GET /reports/by-freight-agent` | No `track` | No `track` | SAME [T] | |
| Report keys | Not listed | See [D] | UNKNOWN | Needs the old report types |
| **(d) `by-customer` as a VIEWER** | Not stated | Groups have **no `email` or `phone`** keys | **CHANGED** [D] | As for customers: a viewer client expecting contact details gets none |
| `GET /dashboard/stats`, `/dashboard/trends` | No query params; KPI cards and breakdowns; four trend series (bookings vs arrivals, vehicles entered, cumulative growth, docs turnaround) | Four series present under `bookingsVsArrivals`, `vehiclesEntered`, `cumulativeGrowth`, `docsTurnaround` | SAME in substance [D]; exact keys UNKNOWN | |

## 7. Notifications, device tokens, push (legacy lines 247-307)

| Aspect | Legacy | Current | Mark | Effect / needed |
|---|---|---|---|---|
| `GET /notifications?page=&pageSize=` | `{ rows, total, page, pageSize, totalPages }`, page 1, pageSize 1-100 default 50 | Exactly those keys and bounds; own notifications only | SAME [T] | Item keys UNKNOWN beyond `id` and `vehicleSerial` (current: `id, event, title, body, isRead, vehicleId, vehicleSerial, createdAt` [D]) |
| `GET /notifications/unread-count` | `{ count }` | Exactly `{ count }` | SAME [T] | |
| `POST /notifications/:id/read` | `{ read: true }`, idempotent; an already-read id or someone else's id is a no-op, **never 404** | The same; another person's notification stays unread | SAME [T] | |
| `POST /notifications/read-all` | Marks every unread notification of the caller | The same; others untouched; answers `{ read: true }` | SAME [T]; the answer body UNKNOWN in the legacy document | |
| Real-time delivery | Push (Expo), no socket | Push, **and** a Server-Sent Events stream `GET /notifications/stream` | ADDITIVE | |
| `POST /device-tokens` | Body `{ expoPushToken, platform: "ios"\|"android" }`; re-registering under another user reassigns; `400` if not a real Expo token | The same, all three | SAME [T] | Response keys UNKNOWN in the legacy document (current: `id, expoPushToken, platform, lastSeenAt` [D]) |
| `DELETE /device-tokens` | `{ unregistered: true }`, idempotent | Same | SAME [T] | |
| Rate limit on device tokens | Not stated | 20 a minute per client address | ADDITIVE | |
| **(c) Push `data` payload** | `event`, `vehicleId`, `vehicleSerial`, `notificationId`; `vehicleSerial` and `notificationId` the same values as `GET /notifications`; `null` when there is no vehicle | Exactly those four keys on the wire (built from a shared part `{ event, vehicleId }` and a per-device part `{ vehicleSerial, notificationId }`, merged in `expo-push.ts`); `notificationId` is the recipient's own row id; both are `null` with no vehicle | SAME [T] | The pin reads the merged message the Expo client would send |

## 8. Profile, staff, organization, activity log (legacy lines 309-347)

| Aspect | Legacy | Current | Mark | Effect / needed |
|---|---|---|---|---|
| `GET /profile` | The caller's own profile, any role | Same; keys `id, name, email, phone, role` [D] | SAME; keys UNKNOWN in the legacy document | |
| Profile write side | None | `PATCH /profile`, `POST /profile/password` | ADDITIVE | |
| `GET /staff?q=` | Administrator or Manager only; `403` for Operator and Viewer | The same | SAME [T] | Row keys UNKNOWN (current: `id, name, email, phone, role, loginEnabled, lastActiveAt`) |
| The `Administrator` row in the list | Not stated | Hidden from everyone except that account itself | UNKNOWN [C] | Needs the old Users page behaviour; a manager's list is one row shorter |
| `GET /organization` | `{ name }` | Exactly `{ name }` | SAME [T] | |
| `GET /activity-log`, `/activity-log/filters` | Administrator only | The same | SAME [T] | |
| Filters response | `{ entities, actions }` | Exactly those keys | SAME [T] | |
| List parameters | `page`, `pageSize` (1-100, 50), `entity`, `action` (partial, case-insensitive), `entityId`, `actorId`, `dateFrom`, `dateTo` | All accepted | SAME [T] | |
| Row keys | `id, actorId, actorName, action, entity, entityId, before, after, createdAt` | Exactly those nine | SAME [T] | |
| **Values of `before` and `after`** | The stored values | Any storage address, object key or file name is **redacted** on read; new entries about files hold only the file id, kind and name | **CHANGED** [C] `storage-redaction.ts` | An old client that showed a file address from the log shows a placeholder; the log is for who did what, not for fetching files |
| `dateTo` | "Inclusive range" | Compared with `<=` at the instant given, so `dateTo=2026-11-03` stops at the start of that day | UNKNOWN [C] | The legacy wording could mean the whole day; needs the old query |

## 9. The CHANGED rows, and what I recommend

None of these was changed back. Each needs your decision.

| # | What changed | Who it affects | Recommendation |
|---|---|---|---|
| 1 | File `url` values are short-lived signed links on this API's own domain (legacy: plain public R2 URLs) | Any mobile client that stores or reuses a file URL | **Version.** This is deliberate (ADR 0007) and closes public access to the bucket. Keep it, and tell the iOS app: load a link straight after fetching it and never persist it; the keys (`id`) are stable, the `url` is not. Do not restore public URLs |
| 2 | A VIEWER gets no contact details in `GET /customers` and `GET /reports/by-customer`, and cannot search by them | A client with a viewer role | **Keep.** It is a decision about privacy, applied on the server. Tell the iOS app that the keys are absent for the VIEWER role and not to render those columns |
| 3 | Role and active flag are checked against the database on every request (legacy: token only) | Everyone | **Keep.** It only makes access end sooner; nothing a legacy client did can now succeed that failed before. Expect a `401` or `403` earlier than the 20-minute token expiry |
| 4 | `vehicleCount` excludes soft-deleted vehicles | Customer list screens | **Keep** (deleted vehicles are hidden everywhere else). Confirm with the old query whether the original counted them; if it did, this is a bug fix |
| 5 | Activity log `before` and `after` are redacted for storage addresses | Anyone showing log details | **Keep.** Restoring raw values would put storage addresses back into a response |

**MISSING:** none.

**UNKNOWN, and what would settle each:**

- Response key sets for the vehicle row, the detail, status history, files items, reports, dashboard, notification items, staff rows, device-token and profile answers: the old TypeScript types, or one old response of each. Until then these are treated as unchanged.
- Detail `shipmentStatus` (stored or effective): the old route handler or one old response; the port comment suggests effective.
- Refresh with a missing body (message and status), a deactivated account at sign-in, reuse of a rotated token later than 10 seconds (does the original revoke every session?), `vehicleCount`, the hidden `Administrator` row, and `dateTo` in the activity log: the old route handlers and services.
- The default sort and track of the old **web** code (the legacy mobile document and this API agree on `serial` descending and `FC`): `lib/vehicle-list-url.ts` `VEHICLE_LIST_DEFAULTS` and the old `GET /vehicles` handler. Held by decision.

## 10. ADDITIVE, in one place

The write side (create, update, delete and their routes for vehicles, files, milestones, customers, lookups, staff, profile, organization, FAQs, chat, stock, enquiries, release flags, link requests, admin job), the notification stream, rate limits and `RATE_LIMITED`, `X-Request-Id`, exposed CORS headers, `409` in use, `storedShipmentStatus`, `GET /vehicles/:serial/timeline`, `expiresAt` on file items, the optional `expoPushToken` on logout, the trusted forwarder headers, and the customer and public zones (separate prefixes, separate tokens). None of them changes a legacy route.
