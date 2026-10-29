# Customer app integration contract

**Contract version:** 1.0.0
**Date:** 2026-10-29
**Audience:** a mobile developer (Expo / React Native) who has never seen this repository.
**Scope:** everything under `/api/customer/v1`, and nothing else. Staff routes (`/api/v1`) and the public website routes (`/api/public`) are not part of this contract and the app must not call them.

This document is generated from the code and guarded by `tests/customer-app-contract.test.ts`. Every JSON block tagged `example=<id>` is compared, key by key, with what the real code returns for fake data; every block tagged `request=<id>` is parsed by the real request schema; every route under `/api/customer/v1` must appear in the endpoint index. If you change a customer route or DTO, that test fails until this file is updated in the same change. All values below are fake. `<API_BASE_URL>` stands for the base address of your environment (see section 12).

Contents: 1 Conventions · 2 Authentication · 3 Profile, settings, devices · 4 Vehicles · 5 Files · 6 Link requests · 7 Alerts, FAQs, version, suggested questions · 8 Chat · 9 Live updates and presence · 10 Push notifications · 11 Not built · 12 Environment facts · 13 Changes and versioning

## Endpoint index

Every route in the zone. `auth` is `none` or `customer` (a customer access token).

| # | Method | Path | Auth | Section |
|---|---|---|---|---|
| 1 | POST | `/auth/register` | none | 2.1 |
| 2 | POST | `/auth/verify-email` | none | 2.2 |
| 3 | POST | `/auth/resend-verification` | none | 2.3 |
| 4 | POST | `/auth/login` | none | 2.4 |
| 5 | POST | `/auth/refresh` | none | 2.5 |
| 6 | POST | `/auth/logout` | none | 2.6 |
| 7 | POST | `/auth/forgot-password` | none | 2.7 |
| 8 | POST | `/auth/reset-password` | none | 2.7 |
| 9 | POST | `/auth/delete-account` | customer | 2.8 |
| 10 | GET | `/app/min-version` | none | 7.4 |
| 11 | GET | `/me` | customer | 3.1 |
| 12 | PATCH | `/me` | customer | 3.1 |
| 13 | GET | `/me/notification-preferences` | customer | 3.2 |
| 14 | PATCH | `/me/notification-preferences` | customer | 3.2 |
| 15 | POST | `/devices` | customer | 3.3 |
| 16 | DELETE | `/devices/:id` | customer | 3.3 |
| 17 | GET | `/home` | customer | 4.1 |
| 18 | GET | `/vehicles` | customer | 4.2 |
| 19 | GET | `/vehicles/:vehicleId` | customer | 4.3 |
| 20 | GET | `/vehicles/:vehicleId/timeline` | customer | 4.4 |
| 21 | GET | `/vehicles/:vehicleId/photos` | customer | 4.5 |
| 22 | GET | `/documents` | customer | 4.6 |
| 23 | GET | `/purchase-history` | customer | 4.7 |
| 24 | GET | `/photos/:photoId/image` | customer | 5.1 |
| 25 | GET | `/documents/:documentId/file` | customer | 5.2 |
| 26 | POST | `/vehicles/link-requests` | customer | 6 |
| 27 | GET | `/alerts` | customer | 7.1 |
| 28 | POST | `/alerts/mark-read` | customer | 7.1 |
| 29 | GET | `/help/faqs` | customer | 7.3 |
| 30 | GET | `/chat/suggested-questions` | customer | 7.5 |
| 31 | GET | `/conversations` | customer | 8.1 |
| 32 | POST | `/conversations` | customer | 8.2 |
| 33 | GET | `/conversations/:id/messages` | customer | 8.3 |
| 34 | POST | `/conversations/:id/messages` | customer | 8.4 |
| 35 | GET | `/stream` | customer | 9.1 |
| 36 | POST | `/presence/heartbeat` | customer | 9.2 |

---

## 1. Conventions

**Base path.** `<API_BASE_URL>/api/customer/v1`. All paths in this document are relative to it. HTTPS only.

**Requests.** JSON bodies with `Content-Type: application/json`. Bodies are *strict*: an unknown field is rejected with 400, so never send fields that are not listed. Query strings are strict too. A `POST` that takes no fields (`/presence/heartbeat`) must send `{}` or no body at all with no `Content-Type`; an empty body that claims to be JSON is a 400. Bodies over 1 MiB are rejected with 400.

**Success envelope.** `{ "data": <payload> }`. Lists are wrapped as `{ "data": { "rows": [...], "total": n, "page": n, "pageSize": n } }` unless a section says otherwise.

**Error envelope.** `{ "error": { "code": "...", "message": "...", "fieldErrors": { "field": "message" } } }`. `fieldErrors` appears only on 400 `VALIDATION` responses caused by malformed input, one message per field name. It is an empty object `{}` when the input was wrong as a whole rather than in one field (an unknown field, an empty body, both `ids` and `all`); it is absent on wrong-code and wrong-credential answers and on every other status. Its per-field texts are zod library messages in English, so show your own wording. Show `message` or `fieldErrors` to the user only where a section says so; otherwise branch on `code` and the HTTP status. Never parse `message` for logic.

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION` | 400 | Bad input, wrong or expired code, wrong credentials, malformed JSON |
| `UNAUTHENTICATED` | 401 | Missing, invalid or expired access token, or the account can no longer sign in |
| `FORBIDDEN` | 403 | Locked account, or a dead refresh token (`/auth/refresh`) |
| `NOT_FOUND` | 404 | Not yours, not released, or does not exist (deliberately the same) |
| `CONFLICT` | 409 | Conversation limit reached |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL` | 500 | Server problem. The message is always generic |

**Dates.** ISO 8601 in UTC with milliseconds, for example `2026-05-01T00:00:00.000Z`. The one exception is the alert day group `date`, `YYYY-MM-DD` in UTC. Dates are timestamps, not calendar dates: `etd` and `eta` arrive as midnight timestamps of the server's calendar day, so format them in the UTC calendar, not the phone's zone, to avoid showing the previous day.

**Ids.** Opaque strings, 1 to 64 characters from `A-Z a-z 0-9 _ -`. Store and send them back unchanged; never parse or order them. An id of any other shape in a path is a 404.

**Caching.** Every response sends `Cache-Control: no-store`, except the two file endpoints (section 5), which send `private, max-age=<seconds>`. Do not cache API JSON on the device beyond the screen that uses it.

**Authorization.** Send `Authorization: Bearer <accessToken>` on every route marked `customer`. The token is accepted only in this header, never in a URL or query string.

**Request id.** The API sends no request-id header and reads none. Do not depend on one.

**Rate limits and 429.** Each route has a limit per IP and, for most, a second limit per identifier (the email, or the signed-in customer). Exceeding either gives `429` with body `{ "error": { "code": "RATE_LIMITED", ... } }` and a `Retry-After` header in seconds. For a per-IP limit it is the time left in the window; for a per-identifier limit it is the full window length (an upper bound). Honour it: stop calling that route until it elapses, with no automatic retry loop. Every response from a rate-limited route also carries `x-ratelimit-limit`, `x-ratelimit-remaining` and `x-ratelimit-reset` (informational). On top of the per-route limits there is an overall limit of 300 requests per minute per IP. Per-identifier limits for the auth routes are counted whether or not the address has an account, so a 429 never says anything about an account.

**Errors that can happen on any route.** Not repeated in every table:

| Status | Code | `message` | When |
|---|---|---|---|
| 400 | `VALIDATION` | `Invalid request.` | Malformed JSON, empty body sent as JSON, body over 1 MiB |
| 401 | `UNAUTHENTICATED` | `Missing bearer token.` | Route needs a token and the header is absent (customer routes only) |
| 401 | `UNAUTHENTICATED` | `Invalid or expired token.` | Token is bad, expired, a staff token, or the account is disabled, unverified or deleted (customer routes only) |
| 404 | `NOT_FOUND` | `Route not found.` | Unknown path, or the customer zone is not switched on in this environment (section 12) |
| 429 | `RATE_LIMITED` | `Too many requests. Try again later.` | Any rate limit above |
| 500 | `INTERNAL` | `Something went wrong.` | Unexpected server error |

Example error bodies (one per shape):

```json example=error.plain
{ "error": { "code": "UNAUTHENTICATED", "message": "Invalid or expired token." } }
```

```json example=error.fields
{ "error": { "code": "VALIDATION", "message": "Please fix the highlighted fields.", "fieldErrors": { "email": "Enter a valid email address" } } }
```

```json example=error.rate
{ "error": { "code": "RATE_LIMITED", "message": "Too many requests. Try again later." } }
```

In each endpoint table below, "common" means the rows of the table above that apply (401 only on `customer` routes), and the listed rows are the ones specific to that endpoint.

---

## 2. Authentication lifecycle

### State overview

```
(no account) --register--> (pending: unverified, no password)
(pending) --verify-email {code, password}--> (verified: can sign in)
(verified) --login--> (session: access token 15 min + refresh token 30 days)
(session) --refresh--> (session, new pair; old refresh token dead)
(session) --logout--> (no session on this device)
(any verified) --forgot-password + reset-password--> (new password, ALL sessions ended)
(session) --delete-account--> (anonymised; everything ended)
```

**Tokens.**

| Token | Lifetime | Format | Notes |
|---|---|---|---|
| Access token | 900 seconds (`accessTokenExpiresIn`) | JWT, HS256, audience `customer` | Opaque to the app: do not parse or trust its contents. Treat it as expired when `accessTokenExpiresIn` seconds have passed since you received it, or on any 401 |
| Refresh token | 30 days (`refreshTokenExpiresAt`); each rotation starts a new 30 days | Opaque random string | Single use. Stored server side only as a hash |

Keep both tokens in secure storage only (`expo-secure-store`: Keychain on iOS, Keystore-backed storage on Android). Never put them in AsyncStorage, logs, analytics, crash reports or URLs. The server re-loads the account on **every** request, so a disabled or deleted account gets 401 immediately even with an unexpired access token.

**Session object** (returned by login and refresh; exactly these keys):

```json example=session
{
  "accessToken": "fake-access-token-not-a-real-jwt",
  "accessTokenExpiresIn": 900,
  "refreshToken": "fake-refresh-token-not-real-0123456789abcdefghijklm",
  "refreshTokenExpiresAt": "2026-11-28T09:30:00.000Z",
  "user": { "id": "ckfake0customer00000000001", "name": "Alex Example", "email": "alex@example.test" }
}
```

### 2.1 `POST /auth/register`

Auth: none. Creates an unverified account with **no password** and emails a 6-digit code. **No password is sent here.** The password is chosen at verify-email, together with the code, so nobody can pre-register someone else's address with a password they know.

Request fields:

| Field | Type | Required | Limits |
|---|---|---|---|
| `name` | string | yes | trimmed, 1 to 150 characters |
| `email` | string | yes | trimmed, lower-cased, valid address, up to 150 characters |
| `phone` | string or null | no | up to 30 characters; empty becomes null |
| `companyName` | string or null | no | up to 150 characters |
| `country` | string or null | no | up to 100 characters |

```json request=register
{ "name": "Alex Example", "email": "alex@example.test", "phone": "+10000000000", "companyName": "Example Trading", "country": "Exampleland" }
```

Success: `202` and the identical body for **every** address (new, already registered, pending, staff address, deleted, over a code-request cap, or self sign-up switched off):

```json example=accepted
{ "data": { "accepted": true } }
```

What the app can and must not infer: **nothing**. A 202 does not mean an email was sent, that the address is new, or that it is free. Always move to the "enter your code" screen and say "if this address can be used, we have emailed a code". A registered address gets a different email ("you already have an account") instead of a code, and an address that registered but never verified gets a fresh code. The response time is padded to a floor so timing says nothing either.

| Status | Code | `message` | `fieldErrors` | When |
|---|---|---|---|---|
| 400 | `VALIDATION` | `Please fix the highlighted fields.` | per field (`name`, `email`, `phone`, `companyName`, `country`) | Invalid input. An unknown field gives this message with `fieldErrors: {}` |
| 429 | `RATE_LIMITED` | as common | | see limits |
| common | | | | |

Limits: 5 per minute per IP; 3 per hour per email. Separately, at most 5 codes per hour per address and 20 per hour per IP are *issued* across register, resend-verification and forgot-password together; over that cap you still get the same 202 but no code is sent (this is invisible to the app by design).

### 2.2 `POST /auth/verify-email`

Auth: none. Verifies the address with the emailed code and sets the password in one step. It returns **no tokens**; call login afterwards.

| Field | Type | Required | Limits |
|---|---|---|---|
| `email` | string | yes | as register |
| `code` | string | yes | trimmed, exactly 6 digits (`^\d{6}$`) |
| `password` | string | yes | at least 12 characters and at most 72 **bytes** (UTF-8) |

```json request=verify-email
{ "email": "alex@example.test", "code": "123456", "password": "a-long-fake-passphrase-for-docs" }
```

Code rules: 6 digits; valid 10 minutes; 5 attempts (each submission spends one, right or wrong); single use; a new code (register again, or resend-verification) invalidates the previous one. Password rules: 12 characters minimum, 72 bytes maximum. Multi-byte characters (accents, emoji) use several bytes each, so validate in bytes on the device (`new TextEncoder().encode(p).length <= 72`) to avoid a surprise 400.

Success `200`:

```json example=verified
{ "data": { "verified": true } }
```

| Status | Code | `message` | `fieldErrors` | When |
|---|---|---|---|---|
| 400 | `VALIDATION` | `That code is invalid or has expired.` | none | Wrong code, expired code, used code, attempts exhausted, unknown address, already verified. **All identical on purpose.** On this message let the user retry, request a new code, or start again; never say which |
| 400 | `VALIDATION` | `Please fix the highlighted fields.` | per field (`email`, `code`, `password`) | Malformed input, including a password that is too short or too long |
| 429 | `RATE_LIMITED` | | | see limits |
| common | | | | |

Limits: 10 per minute per IP; 10 per 10 minutes per email. If self sign-up is switched off on the server, a verified self-registered account still cannot sign in (staff must enable it); the app will see the login answer in 2.4.

### 2.3 `POST /auth/resend-verification`

Auth: none. Body `{ "email" }` (same rules as register). Sends a fresh code if the address is a pending, unverified account; otherwise does nothing. The old code stops working.

```json request=email-only
{ "email": "alex@example.test" }
```

Success: `202`, body as `example=accepted`, for every address. Errors: 400 `VALIDATION` (`Please fix the highlighted fields.`, `fieldErrors.email`), 429, common. Limits: 5 per minute per IP; 3 per 10 minutes per email; plus the shared hourly code caps in 2.1. In the app, enforce a visible 60 second cooldown on the button.

### 2.4 `POST /auth/login`

Auth: none.

| Field | Type | Required | Limits |
|---|---|---|---|
| `email` | string | yes | as register |
| `password` | string | yes | 1 to 1000 characters (login accepts any password that was valid when it was set) |

```json request=login
{ "email": "alex@example.test", "password": "a-long-fake-passphrase-for-docs" }
```

Success `200`: the session object above, wrapped (`{ "data": { ...session } }`):

```json example=login
{
  "data": {
    "accessToken": "fake-access-token-not-a-real-jwt",
    "accessTokenExpiresIn": 900,
    "refreshToken": "fake-refresh-token-not-real-0123456789abcdefghijklm",
    "refreshTokenExpiresAt": "2026-11-28T09:30:00.000Z",
    "user": { "id": "ckfake0customer00000000001", "name": "Alex Example", "email": "alex@example.test" }
  }
}
```

| Status | Code | `message` | When |
|---|---|---|---|
| 400 | `VALIDATION` | `Invalid email or password.` | Wrong password, **and** an unknown address, **and** an unverified, disabled, deleted or staff account. All identical, same timing, same lockout behaviour |
| 400 | `VALIDATION` | `Please check your email and password.` (with `fieldErrors`) | Malformed input |
| 403 | `FORBIDDEN` | `This account is temporarily locked after repeated failed sign-in attempts. Try again in a few minutes.` | 5 failed attempts lock the address for 15 minutes. Applies to a real account **and, deliberately, to an address that does not exist** after 5 failures, so it reveals nothing. Show the message; do not retry for 15 minutes |
| 429 | `RATE_LIMITED` | | see limits |
| common | | | |

So the app can never tell "no such account", "not verified yet", "disabled" and "deleted" apart from "wrong password", and must not try. For a user who registered but never finished verifying, the generic failure text should include a hint such as "If you have not verified your email yet, request a new code". Limits: 10 per minute per IP; 20 per 15 minutes per email.

### 2.5 `POST /auth/refresh`

Auth: none (the refresh token is the credential).

| Field | Type | Required | Limits |
|---|---|---|---|
| `refreshToken` | string | yes | 1 to 200 characters |

```json request=refresh
{ "refreshToken": "fake-refresh-token-not-real-0123456789abcdefghijklm" }
```

Success `200`: a new session object (same shape as login; shown as `example=login`). The previous refresh token is **revoked**; the new pair replaces it.

| Status | Code | `message` | When |
|---|---|---|---|
| 403 | `FORBIDDEN` | `Session expired. Please sign in again.` | Unknown, expired or already-used refresh token, or the account can no longer sign in. All identical |
| 400 | `VALIDATION` | `A refresh token is required.` (with `fieldErrors`) | Missing or malformed field |
| 429 | `RATE_LIMITED` | | see limits |
| common | | | |

**Rotation, grace window and reuse detection (read this twice).**

1. Every refresh consumes the presented token and returns a new one. A token can be used **once**.
2. If a token that was already rotated is presented again, the answer is 403. If that happens **more than about 10 seconds** after the rotation, the server treats it as theft and **revokes every session of that customer** (all devices). Within the 10 second grace window it only answers 403, with no mass revocation. The grace window does *not* return a second valid pair: the retry still fails.
3. Therefore the client **must serialise refresh calls** (a single in-flight promise shared by all callers; concurrent 401s must wait for it) and **must persist the new pair before using it**, atomically replacing the old one in secure storage. Do not fire a refresh from two places, and do not refresh from a background task and the UI at once.
4. If a refresh call fails with a network error, you cannot know whether the server rotated. Retry **once** with the same token only if no response at all was received; if you then get 403, the session is gone: sign the user out and show the sign-in screen. Never loop.
5. A 403 on refresh means: clear stored tokens, clear cached customer data, go to sign-in.

Suggested client algorithm: on 401 from any route, await the shared refresh; on success retry the original request once; on 403 sign out; on a second 401 after a successful refresh, sign out. Refresh proactively shortly before `accessTokenExpiresIn` elapses (for example at 80%), through the same shared promise.

Limits: 30 per minute per IP.

### 2.6 `POST /auth/logout`

Auth: none. Body `{ "refreshToken" }` (same rules as refresh). Revokes that refresh token. Idempotent: an unknown, expired or already-revoked token still gets 200.

```json request=logout
{ "refreshToken": "fake-refresh-token-not-real-0123456789abcdefghijklm" }
```

```json example=logged-out
{ "data": { "loggedOut": true } }
```

Errors: 400 `VALIDATION` (`A refresh token is required.`), 429, common. Limits: 30 per minute per IP.

Logout does **not** touch push devices and does not end other devices' sessions. To stop pushes to this phone, call `DELETE /devices/:id` (section 3.3) *before* logging out (it needs the access token), then logout, then wipe secure storage and local caches. Logout does not invalidate the access token itself, which simply expires within 15 minutes; discard it.

### 2.7 `POST /auth/forgot-password` and `POST /auth/reset-password`

**Forgot.** Body `{ "email" }` (`request=email-only`). Sends a 6-digit reset code (10 minutes, 5 attempts, single use) to a customer account whose login is enabled. Always `202` with `example=accepted`, whatever the address. Errors: 400 `VALIDATION` (`fieldErrors.email`), 429, common. Limits: 5 per minute per IP; 3 per hour per email; plus the shared hourly code caps in 2.1.

A customer that staff created in the back office (login enabled, no password yet) also gets in through this pair: forgot-password, then reset-password.

**Reset.**

| Field | Type | Required | Limits |
|---|---|---|---|
| `email` | string | yes | as register |
| `code` | string | yes | exactly 6 digits |
| `newPassword` | string | yes | at least 12 characters, at most 72 bytes |

```json request=reset-password
{ "email": "alex@example.test", "code": "123456", "newPassword": "another-long-fake-passphrase-1" }
```

Success `200`:

```json example=reset
{ "data": { "reset": true } }
```

A successful reset **revokes every session on every device** (their refresh tokens die; their access tokens expire within 15 minutes). It also clears any lockout. It returns no tokens: send the user to login. Errors: 400 `VALIDATION` `That code is invalid or has expired.` (every failure cause identical, no `fieldErrors` key) or `Please fix the highlighted fields.` (with `fieldErrors`), 429, common. Limits: 10 per minute per IP; 10 per 10 minutes per email.

### 2.8 `POST /auth/delete-account`

Auth: customer. Permanent. The app must show a confirmation and ask for the current password.

| Field | Type | Required | Limits |
|---|---|---|---|
| `password` | string | yes | 1 to 1000 characters |

```json request=delete-account
{ "password": "a-long-fake-passphrase-for-docs" }
```

Success `200`:

```json example=deleted
{ "data": { "deleted": true } }
```

What happens: the account row is **anonymised** (name becomes `Deleted customer`; email, phone, address, company, country, destination port, language, theme, password and assigned agent are cleared; login is switched off). It is not erased because the business's vehicle and audit records point at it. Removed outright: all of the customer's refresh sessions (every device is signed out), one-time codes, **push device tokens**, chat conversations and messages, alerts and notification preferences. After success, the access token stops working at once (401), so the app must clear secure storage, caches and any downloaded files, and return to the first screen. The same email address can be registered again later as a new account.

| Status | Code | `message` | `fieldErrors` | When |
|---|---|---|---|---|
| 400 | `VALIDATION` | `Incorrect password.` | `{ "password": "Incorrect password." }` | Wrong password. Counts toward the 5-failure lockout |
| 400 | `VALIDATION` | `Please fix the highlighted fields.` | per field | Missing or unknown field |
| 403 | `FORBIDDEN` | `This account is temporarily locked after repeated failed sign-in attempts. Try again in a few minutes.` | | Locked |
| 404 | `NOT_FOUND` | `Account not found.` | | Account already gone |
| 429 | `RATE_LIMITED` | | | see limits |
| common | | | | |

Limits: 5 per minute per IP; 5 per hour per customer.

---

## 3. Profile, settings, devices

### 3.1 `GET /me` and `PATCH /me`

Auth: customer. `GET` limit: 60 per minute per IP. `PATCH` shares it.

Profile object (exactly these keys on both):

```json example=me
{
  "data": {
    "id": "ckfake0customer00000000001",
    "name": "Alex Example",
    "email": "alex@example.test",
    "phone": "+10000000000",
    "companyName": "Example Trading",
    "country": "Exampleland",
    "destinationPort": "Example Port",
    "language": "en",
    "theme": "dark",
    "memberSince": "2026-01-01T00:00:00.000Z"
  }
}
```

`language` is `"en"` when never set. `theme` is `"light"`, `"dark"`, `"system"` or `null` (not chosen: follow the system). `email` and `memberSince` are read-only.

`PATCH /me` fields (send only what changed; at least one):

| Field | Type | Limits |
|---|---|---|
| `name` | string | trimmed, 1 to 150 characters; cannot be null |
| `phone` | string or null | up to 30 characters; null or empty clears it |
| `companyName` | string or null | up to 150; null or empty clears it |
| `country` | string or null | up to 100; null or empty clears it |
| `destinationPort` | string or null | up to 100; null or empty clears it |
| `language` | string | two lowercase letters, optionally a region: `en`, `si`, `en-GB` |
| `theme` | `"light"` or `"dark"` or `"system"` | |

```json request=update-me
{ "name": "Alex Example", "destinationPort": "Example Port", "language": "en", "theme": "dark" }
```

Success `200`: the full profile, as above. Language and theme are only stored on the server (to follow the user across devices); the app owns translating its own screens. Server-generated texts (alert titles and bodies, FAQs, error messages) are in English.

| Status | Code | `message` | When |
|---|---|---|---|
| 400 | `VALIDATION` | `Please fix the highlighted fields.` | Bad value (`fieldErrors` per field), an empty body `{}`, or an unknown field such as `email` (those last two have `fieldErrors: {}`) |
| 404 | `NOT_FOUND` | `Account not found.` | Account gone |
| 429, common | | | |

### 3.2 `GET` and `PATCH /me/notification-preferences`

Auth: customer. Limit: 30 per minute per IP and per customer (both methods).

```json example=preferences
{
  "data": {
    "events": {
      "BOOKING_RECEIVED": true,
      "PHOTOS_ADDED": true,
      "DOCUMENTS_READY": true,
      "DEPARTURE_REMINDER": true,
      "NEW_STOCK": true,
      "CHAT_MESSAGE": true
    },
    "departureLeadDays": 7,
    "pushEnabled": true,
    "emailEnabled": true,
    "whatsappEnabled": false
  }
}
```

Defaults for a customer who never changed anything: every event on, `departureLeadDays` 7, push on, email on, WhatsApp off. `PATCH` accepts any subset (at least one); `events` may hold any subset of the six keys above:

| Field | Type | Values |
|---|---|---|
| `events` | object | optional keys `BOOKING_RECEIVED`, `PHOTOS_ADDED`, `DOCUMENTS_READY`, `DEPARTURE_REMINDER`, `NEW_STOCK`, `CHAT_MESSAGE`, each a boolean. Any other key (including `LINK_REQUEST_APPROVED` and `LINK_REQUEST_REJECTED`, which are always delivered) is a 400 |
| `departureLeadDays` | number | exactly `3`, `7` or `14`: how many days before departure the reminder is raised |
| `pushEnabled` | boolean | push channel |
| `emailEnabled` | boolean | email channel |
| `whatsappEnabled` | boolean | **stored only; WhatsApp messages are not sent** (section 11). Do not offer it as a working channel |

```json request=update-preferences
{ "events": { "NEW_STOCK": false }, "departureLeadDays": 14, "pushEnabled": true }
```

Success `200`: the full preferences object after the change.

Semantics: switching an *event* off means that alert is not created at all (no alert in the list, no stream event, no push, no email). Switching the *push* or *email* channel off keeps the alerts in the list and stream and stops only that channel. `LINK_REQUEST_APPROVED` and `LINK_REQUEST_REJECTED` cannot be switched off but obey the channel switches.

Errors: 400 `VALIDATION` `Please fix the highlighted fields.` (an unknown event key or a wrong value, or an empty body), 429, common.

### 3.3 `POST /devices` and `DELETE /devices/:id`

Auth: customer. Limits (both): 20 per minute per IP; 30 per hour per customer.

Register the Expo push token after sign-in and whenever it changes (on every cold start is fine; it is an upsert).

| Field | Type | Required | Limits |
|---|---|---|---|
| `expoPushToken` | string | yes | trimmed, 1 to 200 characters, and must be a valid Expo push token (`ExponentPushToken[...]` or `ExpoPushToken[...]`) |
| `platform` | `"ios"` or `"android"` | yes | |
| `appVersion` | string | no | 1 to 32 characters |

```json request=register-device
{ "expoPushToken": "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]", "platform": "ios", "appVersion": "1.0.0" }
```

Success `200` (not 201), the device record. **The token is never echoed back.** Keep the `id`: you need it to delete the device.

```json example=device
{ "data": { "id": "ckfake0device000000000000001", "platform": "ios", "lastSeenAt": "2026-10-29T09:30:00.000Z" } }
```

Behaviour: registering a token that already exists refreshes it (no duplicate). A token previously held by *another customer* on the same phone moves to the current customer. A token that belongs to a staff device is refused. A customer keeps at most 10 devices; registering an 11th removes the least recently seen. A token Expo reports as unregistered is removed by the server automatically.

| Status | Code | `message` | `fieldErrors` | When |
|---|---|---|---|---|
| 400 | `VALIDATION` | `Not a valid Expo push token.` | `{ "expoPushToken": "Not a valid Expo push token" }` | Not an Expo token, or a staff-held token |
| 400 | `VALIDATION` | `Please provide a valid Expo push token.` | per field | Missing field, wrong `platform`, unknown field |
| 429, common | | | | |

`DELETE /devices/:id` removes one of the customer's own devices:

```json example=device-deleted
{ "data": { "deleted": true } }
```

| Status | Code | `message` | When |
|---|---|---|---|
| 404 | `NOT_FOUND` | `Device not found.` | Unknown id, or another customer's device (identical) |
| 429, common | | | |

---

## 4. Vehicles

**Which vehicles a customer sees.** Only vehicles that are: the customer's own, in their organisation, not deleted, on the export track (a local-track vehicle converted to export counts; an export vehicle converted to local does not), **released by staff** (`customerVisible`), and **not cancelled**. Everything else is absent from lists and is `404 NOT_FOUND "Vehicle not found."` on detail routes, identically for "does not exist", "someone else's", "not released yet", "cancelled" and "malformed id". A staff approval of a link request does *not* release the vehicle, so a freshly linked vehicle may not appear for a while.

**What customers can never see, so the app must not expect or design for it:**

- **Cancelled vehicles**: never listed, no placeholder, no reason.
- **Amounts of any kind**: no price, no per-vehicle amount, no total purchase value, no currency, no cost. `sort=price` is rejected.
- **Remarks and internal notes**, auction details (hall, lot and item numbers, whether the auction bill is paid, supplier), transport and location, freight and packing agents, inspection details, partnership details, row colours and internal flags.
- **Other customers**, the activity log, organisation ids, staff names, and any storage address or key.
- Unreleased photos and documents.

The statuses a customer sees: `PENDING`, `BOOKING_RECEIVED`, `SHIPPED`, `ARRIVED`, `DELIVERED`. It is the shipping status, overridden by the ARRIVED and DELIVERED milestones (`DELIVERED` wins over `ARRIVED`). `CANCELLED` is never sent.

**Vehicle summary** (exactly these keys; used in `/home` and `/vehicles`):

```json example=vehicle-summary
{
  "id": "ckfake0vehicle00000000001",
  "serial": "FC1024",
  "brand": "Alpha Motors",
  "model": "Zeta One",
  "grade": "Base",
  "year": 2019,
  "chassisNo": "FAKE-CHASSIS-0001",
  "destination": "Exampleland",
  "status": "BOOKING_RECEIVED",
  "purchaseDate": "2026-09-01T00:00:00.000Z",
  "etd": "2026-11-10T00:00:00.000Z",
  "eta": "2026-12-05T00:00:00.000Z",
  "portOfLoading": "Example Port L",
  "portOfDischarge": "Example Port D",
  "vesselName": "Example Vessel",
  "coverPhotoId": "ckfake0photo000000000001",
  "photoCount": 2
}
```

Every field except `id`, `serial`, `status` and `photoCount` can be `null`. `coverPhotoId` is the first released photo (null if none); `photoCount` counts released photos only.

### 4.1 `GET /home`

Auth: customer. Limits: 120 per minute per IP; 240 per minute per customer (shared by every "read" route in this document: home, vehicles, timeline, photos, documents, purchase history, FAQs, alerts list, suggested questions, conversations list, messages list).

```json example=home
{
  "data": {
    "name": "Alex Example",
    "activeCount": 2,
    "deliveredCount": 1,
    "nextDeparture": { "vehicleId": "ckfake0vehicle00000000001", "serial": "FC1024", "etd": "2026-11-10T00:00:00.000Z" },
    "recentVehicles": [
      {
        "id": "ckfake0vehicle00000000001",
        "serial": "FC1024",
        "brand": "Alpha Motors",
        "model": "Zeta One",
        "grade": "Base",
        "year": 2019,
        "chassisNo": "FAKE-CHASSIS-0001",
        "destination": "Exampleland",
        "status": "BOOKING_RECEIVED",
        "purchaseDate": "2026-09-01T00:00:00.000Z",
        "etd": "2026-11-10T00:00:00.000Z",
        "eta": "2026-12-05T00:00:00.000Z",
        "portOfLoading": "Example Port L",
        "portOfDischarge": "Example Port D",
        "vesselName": "Example Vessel",
        "coverPhotoId": "ckfake0photo000000000001",
        "photoCount": 2
      }
    ]
  }
}
```

`activeCount` is every visible vehicle not yet `DELIVERED`; `deliveredCount` the delivered ones. `nextDeparture` is the soonest upcoming ETD (today or later) among vehicles still `PENDING` or `BOOKING_RECEIVED`, or `null`. `recentVehicles` is up to 3, newest purchase first (vehicles with no purchase date last), as full summary objects (the array may be empty). Counts consider at most the customer's newest 500 visible vehicles.

Errors: common only (401, 429, 500).

### 4.2 `GET /vehicles`

Auth: customer. Query (strict; an unknown parameter is a 400):

| Param | Type | Default | Values |
|---|---|---|---|
| `page` | integer | 1 | 1 to 100000 |
| `pageSize` | integer | 20 | 1 to 50 |
| `status` | string | all | `PENDING`, `BOOKING_RECEIVED`, `SHIPPED`, `ARRIVED`, `DELIVERED` |
| `brand` | string | all | 1 to 100 characters; matches the whole brand name, ignoring case (not a substring search) |
| `sort` | string | `purchaseDate` | `purchaseDate` or `arrival` (the ETA). **`price` is rejected (400)** |
| `dir` | string | `desc` | `asc` or `desc` |

Vehicles with no value for the sort field always come last, in either direction. Ties are broken by id, so paging is stable.

```json example=vehicles
{
  "data": {
    "rows": [
      {
        "id": "ckfake0vehicle00000000001",
        "serial": "FC1024",
        "brand": "Alpha Motors",
        "model": "Zeta One",
        "grade": "Base",
        "year": 2019,
        "chassisNo": "FAKE-CHASSIS-0001",
        "destination": "Exampleland",
        "status": "BOOKING_RECEIVED",
        "purchaseDate": "2026-09-01T00:00:00.000Z",
        "etd": "2026-11-10T00:00:00.000Z",
        "eta": "2026-12-05T00:00:00.000Z",
        "portOfLoading": "Example Port L",
        "portOfDischarge": "Example Port D",
        "vesselName": "Example Vessel",
        "coverPhotoId": "ckfake0photo000000000001",
        "photoCount": 2
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 20
  }
}
```

`total` is the count for the whole filtered list, so the last page is `ceil(total / pageSize)`. A page beyond the end returns an empty `rows`.

| Status | Code | `message` | `fieldErrors` | When |
|---|---|---|---|---|
| 400 | `VALIDATION` | `Invalid query parameters.` | per parameter, for example `sort` | Bad value, `sort=price`, out-of-range `page`/`pageSize` (an unknown parameter gives the message with `fieldErrors: {}`) |
| 429, common | | | | |

### 4.3 `GET /vehicles/:vehicleId`

The summary plus four more keys:

```json example=vehicle-detail
{
  "data": {
    "id": "ckfake0vehicle00000000001",
    "serial": "FC1024",
    "brand": "Alpha Motors",
    "model": "Zeta One",
    "grade": "Base",
    "year": 2019,
    "chassisNo": "FAKE-CHASSIS-0001",
    "destination": "Exampleland",
    "status": "BOOKING_RECEIVED",
    "purchaseDate": "2026-09-01T00:00:00.000Z",
    "etd": "2026-11-10T00:00:00.000Z",
    "eta": "2026-12-05T00:00:00.000Z",
    "portOfLoading": "Example Port L",
    "portOfDischarge": "Example Port D",
    "vesselName": "Example Vessel",
    "coverPhotoId": "ckfake0photo000000000001",
    "photoCount": 2,
    "voyageNo": "V001",
    "blNo": "BL-FAKE-0001",
    "shippingMethod": "CONTAINER",
    "containerNumber": "FAKE0000001"
  }
}
```

`voyageNo`, `blNo`, `shippingMethod` (`"RORO"`, `"CONTAINER"` or null) and `containerNumber` may be null. Errors: 404 `NOT_FOUND` `Vehicle not found.` (all causes identical), 429, common.

### 4.4 `GET /vehicles/:vehicleId/timeline`

Always exactly **9 steps, in this order** (a plain array in `data`, not wrapped):

| # | `type` | `label` |
|---|---|---|
| 1 | `BOUGHT` | Bought |
| 2 | `AUCTION_BILL_PAID` | Auction bill paid |
| 3 | `AT_EXPORT_YARD` | At export yard |
| 4 | `EXPORT_CERT_ISSUED` | Export certificate issued |
| 5 | `BOOKING_RECEIVED` | Booking received |
| 6 | `SHIPPED` | Shipped |
| 7 | `BL_ISSUED` | Bill of lading issued |
| 8 | `ARRIVED` | Arrived |
| 9 | `DELIVERED` | Delivered |

```json example=timeline
{
  "data": [
    { "type": "BOUGHT", "label": "Bought", "completed": true, "occurredAt": "2026-09-01T00:00:00.000Z" },
    { "type": "AUCTION_BILL_PAID", "label": "Auction bill paid", "completed": false, "occurredAt": null },
    { "type": "AT_EXPORT_YARD", "label": "At export yard", "completed": false, "occurredAt": null },
    { "type": "EXPORT_CERT_ISSUED", "label": "Export certificate issued", "completed": false, "occurredAt": null },
    { "type": "BOOKING_RECEIVED", "label": "Booking received", "completed": false, "occurredAt": null },
    { "type": "SHIPPED", "label": "Shipped", "completed": false, "occurredAt": null },
    { "type": "BL_ISSUED", "label": "Bill of lading issued", "completed": false, "occurredAt": null },
    { "type": "ARRIVED", "label": "Arrived", "completed": false, "occurredAt": null },
    { "type": "DELIVERED", "label": "Delivered", "completed": false, "occurredAt": null }
  ]
}
```

`completed` is true exactly when a milestone has been recorded for that step, and then `occurredAt` is its timestamp; otherwise `occurredAt` is null. Steps are recorded by staff and may be completed out of order, so do not assume a later step implies an earlier one. Use `type` as the stable identifier (and for your own translated labels); `label` is English. Errors: as 4.3.

### 4.5 `GET /vehicles/:vehicleId/photos`

A plain array, oldest first, up to 200, released photos only: ids and dates, never addresses.

```json example=photos
{ "data": [ { "id": "ckfake0photo000000000001", "createdAt": "2026-09-02T08:00:00.000Z" }, { "id": "ckfake0photo000000000002", "createdAt": "2026-09-02T08:05:00.000Z" } ] }
```

Fetch the picture with section 5.1. Errors: as 4.3.

### 4.6 `GET /documents`

Released documents of the customer's visible vehicles, newest first. Query (strict): `page` (1+), `pageSize` (1 to 50, default 20), `vehicleId` (optional id; a vehicle that is not the customer's visible vehicle simply matches nothing and yields an empty list).

```json example=documents
{
  "data": {
    "rows": [
      {
        "id": "ckfake0document0000000001",
        "name": "Bill of lading FC1024",
        "type": "BL",
        "createdAt": "2026-10-20T10:00:00.000Z",
        "vehicle": { "id": "ckfake0vehicle00000000001", "serial": "FC1024" }
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 20
  }
}
```

`type` is one of `LC, EC, ED, BL, INSPECTION_REPORT, SHAKEN_SHO, FREIGHT_INVOICE, PURCHASE_INVOICE, SALES_INVOICE, MEGI_HENKO, CASH_RECEIPT, OTHER`; map unknown future values to a generic "document" label. `name` is staff-entered plain text. Download with section 5.2. Errors: 400 `VALIDATION` `Invalid query parameters.` (as 4.2), 429, common.

### 4.7 `GET /purchase-history`

Exactly two values. There is no total purchase value, no amount, no per-currency figure.

```json example=purchase-history
{ "data": { "deliveredCount": 1, "customerSince": "2026-01-01T00:00:00.000Z" } }
```

`deliveredCount` is the number of visible vehicles that have a DELIVERED milestone; `customerSince` is when the account was created (the same value as `memberSince` in `/me`). Errors: 404 `NOT_FOUND` `Account not found.` (account gone), 429, common.

---

## 5. Files (photos and documents)

The app never receives a storage address, an object key, an account id or a signed link, anywhere: not in JSON, not in headers, not in errors. It asks this API for a file **by its database id**, with its access token; the API checks ownership, reads the object and streams the bytes. Nothing redirects.

### 5.1 `GET /photos/:photoId/image`

Auth: customer. Query: `size=thumb` or `size=full` (default `full`). Any other query parameter or value is a 400. `thumb` returns the small version when one exists, otherwise quietly the full image (so do not rely on the size of the bytes).

### 5.2 `GET /documents/:documentId/file`

Auth: customer. No query parameters allowed (any is a 400).

### Request and response (both)

Required request header: `Authorization: Bearer <accessToken>`. Optional: `If-None-Match: <etag>`.

Success `200` headers:

| Header | Value |
|---|---|
| `Content-Type` | `image/jpeg`, `image/png` or `image/webp` for photos; `application/pdf` for documents. Nothing else is ever served (never SVG or HTML) |
| `Content-Length` | byte size, when known |
| `Content-Disposition` | `inline` for photos; `attachment; filename="..."; filename*=UTF-8''...` for documents |
| `ETag` | quoted entity tag |
| `Cache-Control` | `private, max-age=<seconds>` (server setting `CUSTOMER_FILE_CACHE_SECONDS`, default 300). This is the only customer-API response that may be cached |
| `Vary` | `Authorization` |
| `X-Content-Type-Options` | `nosniff` |
| `Content-Security-Policy` | `default-src 'none'; sandbox` |

**Conditional requests.** Send the `ETag` you were given as `If-None-Match`. If unchanged you get `304` with no body and the same `ETag` and `Cache-Control`; keep using your cached copy. The caches of `fetch`, `expo-image` and `expo-file-system` do this for you when they are given the header; make sure the `Authorization` header is attached to every image request (for `expo-image`, `source={{ uri, headers: { Authorization } }}`; and give the cache a key made of the file **id**, not the URL with a changing token).

**No Range support.** A `Range` header is ignored and the whole file is returned with `200`. There is no `Accept-Ranges`. Photos are at most 10 MB and documents at most 20 MB (the limits staff uploads are held to). Show a progress indicator for PDFs, download them to the app's cache directory with the auth header (for example `FileSystem.downloadAsync(url, path, { headers })`), then open them with the system viewer. Do not try to progressively stream a PDF.

**Errors.** All authorisation failures are the **same** answer, so the app cannot tell a private file from a missing one:

| Status | Code | `message` | When |
|---|---|---|---|
| 404 | `NOT_FOUND` | `File not found.` | Unknown id, another customer's file, file not released, vehicle not released or cancelled, bad id shape, file gone from storage, stored type not allowed |
| 400 | `VALIDATION` | `Invalid query parameters.` | Bad `size`, or any query parameter on the document route |
| 429 | `RATE_LIMITED` | | 300 per minute per IP; 120 per minute per customer (this budget is separate from the "read" budget; a list screen loading many thumbnails can hit it, so limit concurrent thumbnail requests to about 6 and use lazy loading) |
| 500 | `INTERNAL` | `File storage is not available.` | Server cannot reach storage. Retry later |
| common | | | |

Error responses are JSON, not bytes: check the status code before treating the body as an image.

**Expiry and revocation.** A file can stop being available at any time (staff un-release it, the vehicle is cancelled, the customer is unlinked). The app learns this only by a `404` on that id. On a 404: remove that id from the local file cache, drop the thumbnail or show a neutral placeholder, and refresh the parent list (`/vehicles/:id/photos` or `/documents`). Copies already cached on the device may be shown until `max-age` elapses, so assume up to 5 minutes of lag by default. On logout, account deletion or a 403 from refresh, delete every cached file.

---

## 6. Link requests

A customer who bought a vehicle that is not yet in their account asks staff to link it by its serial number.

`POST /vehicles/link-requests`, auth: customer.

| Field | Type | Required | Limits |
|---|---|---|---|
| `serial` | string | yes | trimmed and upper-cased by the server; must match `FC` or `FL` followed by 1 to 9 digits, for example `FC1024` |

```json request=link-request
{ "serial": "FC1024" }
```

Success: **always `202`**, whatever the serial:

```json example=link-accepted
{ "data": { "accepted": true } }
```

**Existence is never confirmed.** Nothing looks the vehicle up when you ask. The same 202 comes back for a serial that exists, one that does not, one that belongs to someone else, a repeat of a pending request, and when the customer already has 20 pending requests (repeats and over-cap requests are silently dropped). So the app must say "Thanks, we will check and let you know", never "vehicle found".

| Status | Code | `message` | `fieldErrors` | When |
|---|---|---|---|---|
| 400 | `VALIDATION` | `Enter a serial number such as FC1024.` | `{ "serial": "Enter a serial number such as FC1024" }` | Not an FC/FL serial. Missing or unknown field gives the same message with the matching field error |
| 429 | `RATE_LIMITED` | | | |
| common | | | | |

Limits: 10 per minute per IP; 5 per hour per customer (counted before any work, whatever the outcome). Pending cap: 20 per customer.

**What happens next.** Staff (administrators, managers, and the customer's assigned agent) are notified and decide. The customer learns the result in the app, not by the API answering this call:

- **Approved:** an alert with `event = LINK_REQUEST_APPROVED`, title `Vehicle linked`, body `Your request to link FC1024 was approved.`, `vehicleId` set to the linked vehicle. A stream event and a push (unless the push channel is off) carry the same data. Approval links the vehicle to the account but does **not** release it: the vehicle may still answer `404` on `/vehicles/:id` and be missing from `/vehicles` until staff release it. Treat that 404 gracefully ("being prepared").
- **Rejected:** an alert with `event = LINK_REQUEST_REJECTED`, title `Vehicle request`, body `Your request to link FC1024 could not be approved.`, and `vehicleId = null`. The reason is never in the alert. If staff chose to give one, it arrives as a **chat message** from staff in the customer's most recent conversation that has no vehicle (a new conversation is created if there is none), with the text `About your request to link FC1024: <reason>`. It is announced to the app like any staff chat message (a `message` stream event, and a `CHAT_MESSAGE` alert if it starts a burst).

These two alert types cannot be switched off in preferences. Alert shapes are in section 7.1, push in section 10.

---

## 7. Alerts, FAQs, version, suggested questions

### 7.1 `GET /alerts` and `POST /alerts/mark-read`

`GET /alerts`, auth: customer. Query (strict): `page` (default 1), `pageSize` (1 to 50, default 20). Newest first, paged by page number (not by cursor), grouped by UTC calendar day. Limits: the "read" budget (120 per minute per IP, 240 per minute per customer).

```json example=alerts
{
  "data": {
    "days": [
      {
        "date": "2026-10-29",
        "alerts": [
          {
            "id": "ckfake0alert00000000000001",
            "event": "BOOKING_RECEIVED",
            "title": "Booking received",
            "body": "Your booking for FC1024 has been received.",
            "isRead": false,
            "vehicleId": "ckfake0vehicle00000000001",
            "createdAt": "2026-10-29T09:30:00.000Z"
          }
        ]
      }
    ],
    "unreadCount": 1,
    "total": 1,
    "page": 1,
    "pageSize": 20
  }
}
```

- `days` holds only the days present on that page, newest first; a day can continue on the next page, so merge by `date` when appending pages.
- `unreadCount` is for the whole account (use it for the badge); `total` is all alerts.
- `vehicleId` is shown **only while the customer may still see that vehicle**; otherwise `null` even though the alert had one.
- `title` and `body` are fixed English strings. Localise by `event` in the app if you need other languages; never parse `body`.

Errors: 400 `VALIDATION` `Invalid query parameters.`, 429, common.

`POST /alerts/mark-read`, auth: customer. Limits: 60 per minute per IP; 60 per minute per customer. Send exactly one of:

| Body | Meaning |
|---|---|
| `{ "ids": ["..."] }` | 1 to 200 alert ids |
| `{ "all": true }` | every unread alert |

```json request=mark-read
{ "ids": ["ckfake0alert00000000000001"] }
```

```json example=mark-read
{ "data": { "updated": 1 } }
```

`updated` is how many alerts changed. It is idempotent: an id that is already read, unknown, or someone else's changes nothing and is not an error (so you cannot probe for ids). Errors: 400 `VALIDATION` `Please fix the highlighted fields.` (empty `ids`, more than 200, `all: false`, both keys, unknown field), 429, common.

### 7.2 The alert types

Eight types exist for customers. Alerts are created on the server when the thing happens; the same alert is delivered through the list, the stream (9.1) and push (10). The app owns the screen mapping; this table gives the type and the ids it carries.

| `event` | Carries | When it is raised | Switchable | Suggested screen |
|---|---|---|---|---|
| `BOOKING_RECEIVED` | `vehicleId` | A vehicle moves to "booking received" | yes | Vehicle detail |
| `PHOTOS_ADDED` | `vehicleId` | Staff release photos (at most one alert per vehicle per 10 minutes) | yes | Vehicle photos |
| `DOCUMENTS_READY` | `vehicleId` | Staff release an export certificate or bill of lading | yes | Documents, filtered by `vehicleId` |
| `DEPARTURE_REMINDER` | `vehicleId` | The vehicle's ETD is exactly `departureLeadDays` away (once a day per vehicle) | yes | Vehicle detail |
| `NEW_STOCK` | none (`vehicleId` null) | Staff publish a stock listing and announce it | yes | Nothing specific (stock browsing is not built); open the alerts list |
| `CHAT_MESSAGE` | `vehicleId` when the conversation is about a vehicle, else null. **No conversation id** | A staff message starts a burst (the first, a change of sender, or a gap over 5 minutes) | yes | Chat. Open the conversation for that vehicle, or the conversation list |
| `LINK_REQUEST_APPROVED` | `vehicleId` | Staff approved a link request | no | Vehicle detail; on 404 show "being prepared" and go to the vehicle list |
| `LINK_REQUEST_REJECTED` | none | Staff rejected a link request | no | Chat (a reason may be there) or the alerts list |

Exact texts (these are the templates in the code; `{serial}` is the vehicle serial):

| `event` | `title` | `body` |
|---|---|---|
| `BOOKING_RECEIVED` | `Booking received` | `Your booking for {serial} has been received.` |
| `PHOTOS_ADDED` | `New photos` | `New photos are available for {serial}.` |
| `DOCUMENTS_READY` | `Document ready` | `The export certificate for {serial} is ready.` or `The bill of lading for {serial} is ready.` |
| `DEPARTURE_REMINDER` | `Departure reminder` | `{serial} is due to depart in {n} days.` |
| `NEW_STOCK` | `New stock` | `{make} {model} ({year}) has just been added.` (the year part is dropped if unknown) |
| `CHAT_MESSAGE` | `New message` | `You have a new message from the CargoDev team.` |
| `LINK_REQUEST_APPROVED` | `Vehicle linked` | `Your request to link {serial} was approved.` |
| `LINK_REQUEST_REJECTED` | `Vehicle request` | `Your request to link {serial} could not be approved.` |

An unknown `event` string may appear in future: show the title and body and open the alerts list. Staff-only events never reach customers.

The wire shape of an alert on the stream and in push `data` is in sections 9 and 10; in the list it is the alert object shown in 7.1.

### 7.3 `GET /help/faqs`

Auth: customer. Limit: the "read" budget. Published FAQs in staff order. A plain array, no paging, up to 200. Render `question` and `answer` as **plain text** (staff-entered; never as HTML).

```json example=faqs
{ "data": [ { "id": "ckfake0faq00000000000001", "question": "How long does shipping take?", "answer": "It depends on the route; see your vehicle's ETA." } ] }
```

Errors: 400 `VALIDATION` `Invalid query parameters.` (any query parameter), 429, common.

### 7.4 `GET /app/min-version`

Auth: **none** (it runs before sign-in). Limit: 60 per minute per IP.

```json example=min-version
{ "data": { "minVersion": "1.0.0" } }
```

`minVersion` is `major.minor.patch`, digits only (from the server setting `APP_MIN_VERSION`). How the app reacts: call it at every cold start and when returning to the foreground after a long time, before showing sign-in or any data. Compare numerically per segment (1.10.0 is newer than 1.9.0). If the installed app version is **lower**, block the whole app with a full-screen "Please update" screen and a button to the store; do not call other routes. If the call fails (offline, 5xx, 429) fail **open**: continue, and check again later. Never cache a "must update" result across a successful newer check. Errors: 429, 500, 404 (zone off).

### 7.5 `GET /chat/suggested-questions`

Auth: customer. Limit: the "read" budget. Fixed starters for the chat box (no data from the database):

```json example=suggested-questions
{
  "data": {
    "questions": [
      "Where is my vehicle now?",
      "When will my vehicle ship?",
      "When will my vehicle arrive?",
      "Can I get a copy of my export certificate?",
      "Can I get a copy of my bill of lading?",
      "How do I pay for my vehicle?"
    ]
  }
}
```

Tapping one should put the text in the input (the customer sends it with 8.2 or 8.4); do not auto-send. Errors: common only.

---

## 8. Chat

A customer talks to the CargoDev team in plain text. No attachments, no formatting, no read receipts, no typing indicators, no edit or delete.

**Rules for message text** (send and receive): a string; line endings are normalised to `\n`; leading and trailing whitespace is trimmed; **1 to 2000 characters after trimming** (counted in UTF-16 code units, as `String.length`, so an emoji counts as 2); control characters other than newline and tab are rejected. It is stored exactly as typed and returned as a JSON string: render it as **plain text** (React Native `Text`), never as HTML or markdown.

**Message object** (exactly these keys):

```json example=message
{ "data": { "id": "ckfake0message0000000001", "senderType": "CUSTOMER", "body": "Where is my vehicle now?", "createdAt": "2026-10-29T09:30:00.000Z" } }
```

`senderType` is `"CUSTOMER"` (you) or `"STAFF"`. There is no staff name or avatar: show "CargoDev team".

**No agent assigned.** The customer sees no difference. A message goes to the customer's assigned agent if they have one who can use chat, otherwise to all active administrators and managers. There is no "assigned agent" field and no "waiting for an agent" state in the API; the app should simply show the sent message and, optionally, a static note such as "We usually reply during business hours".

### 8.1 `GET /conversations`

Auth: customer. Query (strict): `page` (default 1), `pageSize` (1 to 50, default 20). Most recently active first. Limit: the "read" budget.

```json example=conversations
{
  "data": {
    "rows": [
      {
        "id": "ckfake0conversation000001",
        "vehicle": { "id": "ckfake0vehicle00000000001", "serial": "FC1024" },
        "lastMessageAt": "2026-10-29T09:30:00.000Z",
        "lastMessage": { "senderType": "STAFF", "snippet": "Your vehicle is at the yard.", "createdAt": "2026-10-29T09:30:00.000Z" }
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 20
  }
}
```

`vehicle` is `null` for a general conversation, and also if it was about a vehicle the customer may no longer see. `lastMessage.snippet` is the first 120 characters (cut with a trailing `…`); `lastMessage` is null only for a conversation with no messages (cannot normally happen). Errors: 400 `VALIDATION` `Invalid query parameters.`, 429, common.

### 8.2 `POST /conversations`

Auth: customer. Starts a **new** conversation with a first message. This is "create", not "get or create": calling it twice makes two conversations. To continue, list conversations and post to an existing one with 8.4. To "chat about this vehicle", look for an existing conversation whose `vehicle.id` matches before creating one.

| Field | Type | Required | Limits |
|---|---|---|---|
| `vehicleId` | string | no | an id of a vehicle the customer may see (section 4); omit for a general conversation |
| `body` | string | yes | the message rules above |

```json request=start-conversation
{ "vehicleId": "ckfake0vehicle00000000001", "body": "Where is my vehicle now?" }
```

Success: `201`.

```json example=conversation-started
{
  "data": {
    "conversation": { "id": "ckfake0conversation000001", "vehicleId": "ckfake0vehicle00000000001" },
    "message": { "id": "ckfake0message0000000001", "senderType": "CUSTOMER", "body": "Where is my vehicle now?", "createdAt": "2026-10-29T09:30:00.000Z" }
  }
}
```

| Status | Code | `message` | `fieldErrors` | When |
|---|---|---|---|---|
| 400 | `VALIDATION` | `Please fix the highlighted fields.` | `body` (for example `Message cannot be empty`, `Message must be 2000 characters or fewer`, `Message contains characters that are not allowed`) | Bad body or unknown field |
| 404 | `NOT_FOUND` | `Vehicle not found.` | | `vehicleId` is not a vehicle the customer may see (all causes identical) |
| 409 | `CONFLICT` | `You have reached the maximum number of conversations.` | | 50 conversations already exist |
| 429 | `RATE_LIMITED` | | | |
| common | | | | |

Limits: 20 per minute per IP; 10 per hour per customer for starting; and the message budget below also applies (15 per minute per customer).

### 8.3 `GET /conversations/:id/messages`

Auth: customer. Query (strict): `page` (default 1), `pageSize` (1 to 50, default 20). **Newest first** (`createdAt` descending, ties by id). Page 1 is the latest messages; to show a chat oldest-to-newest, reverse the rows (or use an inverted list) and load older messages by requesting page 2, 3, and so on. Paging is by page number, so if new messages arrive between page requests, older pages shift: de-duplicate by `id` and prefer re-fetching page 1 over trusting stale offsets. Limit: the "read" budget.

```json example=messages
{
  "data": {
    "rows": [
      { "id": "ckfake0message0000000002", "senderType": "STAFF", "body": "Your vehicle is at the yard.", "createdAt": "2026-10-29T09:35:00.000Z" },
      { "id": "ckfake0message0000000001", "senderType": "CUSTOMER", "body": "Where is my vehicle now?", "createdAt": "2026-10-29T09:30:00.000Z" }
    ],
    "total": 2,
    "page": 1,
    "pageSize": 20
  }
}
```

Errors: 404 `NOT_FOUND` `Conversation not found.` (unknown id, another customer's, malformed id: identical), 400 `VALIDATION` `Invalid query parameters.`, 429, common.

### 8.4 `POST /conversations/:id/messages`

Auth: customer. Body `{ "body" }`, rules above. Success: `201` with the message object (`example=message`).

```json request=send-message
{ "body": "Where is my vehicle now?" }
```

Errors: 400 `VALIDATION` `Please fix the highlighted fields.` with `fieldErrors.body`; 404 `NOT_FOUND` `Conversation not found.`; 429; common. Limits: 60 per minute per IP; **15 per minute per customer** (the budget is shared with starting a conversation). Sending a message reopens a conversation staff had marked handled. Do not auto-retry a send that returned no response: the message may have been stored; refetch page 1 and check before re-sending.

### How new messages and staff replies arrive

Three ways, all carrying **ids only, never the message text**:

1. **Live stream** (9.1): a `message` event `{ conversationId, messageId, senderType: "STAFF", createdAt }` for each staff message. Fetch page 1 of that conversation to get the text. You do not receive stream events for your own messages (not even from another device): refetch when the app returns to the foreground.
2. **Alert:** a `CHAT_MESSAGE` alert when a staff message starts a burst (not for every message).
3. **Push** for that alert (section 10). Its body never contains the message text.

Read state: none. There is no unread flag per message or per conversation. Track "last seen" locally using message ids and `createdAt`, and use the `CHAT_MESSAGE` alert's `isRead` for the badge.

---

## 9. Live updates and presence

### 9.1 `GET /stream` (Server-Sent Events)

Auth: customer, **in the `Authorization` header only** (a token in a URL would end up in logs, so it is not accepted there).

Request headers: `Authorization: Bearer <accessToken>`, `Accept: text/event-stream`. Response `200`, `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-store`, `Connection: keep-alive`. Rate limit to open a stream: 30 per minute per IP; 30 per minute per customer.

Wire format. The first bytes are always a reconnect hint and a comment, then events:

```text
retry: 5000
: connected

id: ckfake0alert00000000000001
event: notification
data: {"id":"ckfake0alert00000000000001","event":"BOOKING_RECEIVED","title":"Booking received","body":"Your booking for FC1024 has been received.","vehicleId":"ckfake0vehicle00000000001","createdAt":"2026-10-29T09:30:00.000Z"}

: ping

```

- `retry: 5000`: if the connection drops, reconnect after 5000 ms (a client that follows the SSE rules does this by itself; reconnect with a fresh token if the old one has expired).
- **Heartbeat:** a comment line `: ping` every 25 seconds. It has no event; ignore it. If nothing at all (not even a ping) arrives for about 60 seconds, treat the connection as dead and reconnect.

**Events** (the `data:` line is JSON):

| `event` | `id:` | `data` keys | Meaning |
|---|---|---|---|
| `notification` | the alert's id | `id`, `event`, `title`, `body`, `vehicleId`, `createdAt` | A new alert (section 7.2). Note: no `isRead` (it is unread). `vehicleId` here is **not** checked against what you may currently see, so it can refer to a vehicle that answers 404 until staff release it |
| `message` | random | `conversationId`, `messageId`, `senderType`, `createdAt` | A staff chat message arrived. `senderType` is `"STAFF"` for the customer's stream |
| `reauth` | none | `reason` (`"token_expired"`) | The access token reached its expiry. The server then closes the stream. Refresh the token and reconnect |
| `closed` | none | `reason` (`"replaced"`) | You opened a 4th stream; the oldest was closed. Do not auto-reconnect immediately (it would evict another one of your own streams in a loop); keep exactly one stream per app |
| `shutdown` | none | `reason` (`"server_shutting_down"`) | The server is restarting. Reconnect after a short random delay (1 to 5 seconds) |

```json example=sse.notification
{ "id": "ckfake0alert00000000000001", "event": "BOOKING_RECEIVED", "title": "Booking received", "body": "Your booking for FC1024 has been received.", "vehicleId": "ckfake0vehicle00000000001", "createdAt": "2026-10-29T09:30:00.000Z" }
```

```json example=sse.message
{ "conversationId": "ckfake0conversation000001", "messageId": "ckfake0message0000000002", "senderType": "STAFF", "createdAt": "2026-10-29T09:35:00.000Z" }
```

```json example=sse.reauth
{ "reason": "token_expired" }
```

```json example=sse.closed
{ "reason": "replaced" }
```

```json example=sse.shutdown
{ "reason": "server_shutting_down" }
```

**Limits and endings.**

- **Per customer: 3 open streams.** Opening another closes the *oldest* of that customer's streams after sending it `event: closed` (`replaced`).
- **Global:** the server holds a fixed number of streams per instance (setting `SSE_MAX_CONNECTIONS`, default 500). When full, the new request is refused with `429 RATE_LIMITED` `Too many open streams. Try again later.` and `Retry-After: 30`. Existing streams are not dropped.
- **Token expiry closes the stream:** at the access token's expiry (at most 15 minutes after it was issued) the server sends `reauth` and ends the stream. The stream does not check the account again while open: a disabled account's stream ends only at token expiry, and the next request fails with 401. Reconnect with a token that has at least a few minutes left (refresh first if needed).
- Errors before the stream starts are ordinary JSON: 401 (bad token), 429 (rate limit or capacity), 404 (zone off).
- A mobile OS suspends sockets in the background. Close the stream when the app goes to the background and reopen it (with catch-up) when it returns to the foreground. Push (section 10) covers the background.

**There is no replay.** Events missed while disconnected are not resent, and `Last-Event-ID` is ignored. The stream is a convenience; the database is the truth. After every (re)connect, and after returning to the foreground, catch up with plain GETs:

1. `GET /alerts` (page 1): new alerts and `unreadCount`.
2. `GET /conversations`, and `GET /conversations/:id/messages` (page 1) for the open chat.
3. `GET /home` or `GET /vehicles` and the open `GET /vehicles/:vehicleId` if a vehicle screen is visible (status changes always produce an alert, so refresh the vehicle when an alert for its `vehicleId` arrives).
4. Dedupe by id: an alert delivered on the stream also appears in the list with the same `id`.

**React Native.** There is no native `EventSource`. Options (verify against your Expo SDK version; none is added to this API repository): a small SSE client that supports custom headers (such as `react-native-sse`), or a streaming `fetch` with a `ReadableStream` reader (available through `expo/fetch`) and your own line parser for the `event:`, `id:` and `data:` fields. Whichever you choose it must send the `Authorization` header (browser-style `EventSource` cannot, which is why the web `EventSource` is not usable). Wrap it in one module: one connection, exponential backoff with jitter (start at the server's 5 seconds, cap at 60), an abort on background, a refresh-then-reconnect on `reauth`, and a catch-up call after each connect.

### 9.2 `POST /presence/heartbeat`

Auth: customer. Body: none; send `{}` (or no body and no `Content-Type`).

```json example=heartbeat
{ "data": { "ok": true } }
```

It records "this customer is using the app now" so staff can see who is online. The answer is identical whether or not anything was written: the server rewrites the stored value at most **once every 60 seconds** per customer, so extra calls are harmless but pointless. Staff treat a customer as **active** if the last heartbeat (or sign-in) was within **5 minutes**. So: send one on app foreground and then roughly every 60 to 120 seconds while the app is in the foreground and the user is present; do not send in the background. Limits: 60 per minute per IP; 30 per minute per customer. Errors: 429, common.

---

## 10. Push notifications

Push is sent through Expo's push service to every device registered with `POST /devices` (section 3.3), for each alert the customer's preferences allow: the event must be switched on (or be non-switchable) and `pushEnabled` must be true. Sending is best effort and happens after the alert is saved. Customers without a registered device get no push.

Exact message sent to Expo, one per device:

```json example=push.message
{
  "to": "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
  "title": "Booking received",
  "body": "Your booking for FC1024 has been received.",
  "data": {
    "event": "BOOKING_RECEIVED",
    "vehicleId": "ckfake0vehicle00000000001",
    "vehicleSerial": "FC1024",
    "notificationId": "ckfake0alert00000000000001"
  },
  "sound": "default"
}
```

- `title` and `body` are the alert's own `title` and `body`: the templates in section 7.2, one per event type, identical to the alert list. Nothing else is added.
- `data` keys: `event` (the alert type), `vehicleId` (string or null), `vehicleSerial` (string or null; the serial of that vehicle), `notificationId` (the alert's id). These are the only keys, and they are ids and a serial only. The app opens the screen from `event` and `vehicleId` using the mapping in 7.2; `notificationId` lets the app mark the alert read when the user taps the push (`POST /alerts/mark-read` with `{ "ids": [notificationId] }`), and dedupe against the stream. Unlike the alert list, the push `vehicleId` is not checked against what the customer may see, so be ready for a 404.
- **No personal text.** There is no customer or staff name and no chat message text in any push, email or stream payload. The strings contain the vehicle serial (and for `NEW_STOCK` the make, model and year); the `LINK_REQUEST_*` bodies contain the serial the customer typed. A chat push is always the generic `New message` / `You have a new message from the CargoDev team.`
- **Sound:** `default`. **No** `channelId`, `categoryId`, `badge`, `priority`, `ttl`, `subtitle` or image is set. On Android, create a notification channel with the id `default` in the app (Expo delivers to it when no channel is named); decide badge counts yourself from `unreadCount`.
- **Per event type** the message is the same shape; only `event`, `title`, `body` and whether `vehicleId`/`vehicleSerial` are set change, as in this table:

| `event` | `data.vehicleId` / `data.vehicleSerial` | Maps to alert |
|---|---|---|
| `BOOKING_RECEIVED` | set | the `BOOKING_RECEIVED` alert |
| `PHOTOS_ADDED` | set | `PHOTOS_ADDED` |
| `DOCUMENTS_READY` | set | `DOCUMENTS_READY` |
| `DEPARTURE_REMINDER` | set | `DEPARTURE_REMINDER` |
| `NEW_STOCK` | both null | `NEW_STOCK` |
| `CHAT_MESSAGE` | set when the conversation is about a vehicle, else null | `CHAT_MESSAGE` |
| `LINK_REQUEST_APPROVED` | set | `LINK_REQUEST_APPROVED` |
| `LINK_REQUEST_REJECTED` | both null | `LINK_REQUEST_REJECTED` |

Push is not guaranteed (the device may be offline or the user may have disabled notifications in the OS). On app foreground always run the catch-up in 9.1. Remote push does not work in Expo Go from SDK 53 on; use a development build, and test on a physical iPhone.

---

## 11. Not built: the app must not call or show these

| Feature | Status |
|---|---|
| Phone number or OTP login / SMS sign-in | Not built. Email and password only. `phone` is a profile field only |
| Total purchase value, price, per-vehicle amount, cost or any currency amount | Never shown to customers (a business decision). No endpoint, no field. `sort=price` is a 400 |
| Stock browsing (a catalogue of vehicles for sale) | Not built in this zone. A `NEW_STOCK` alert exists but has no vehicle to open |
| Reserve a vehicle | Not built |
| Saved / favourite vehicles | Not built |
| Cost estimates | Not built |
| WhatsApp messages | Not sent. `whatsappEnabled` in preferences is stored only |
| Attachments in chat (images, files, voice) | Not built. Text only |
| Chat read receipts, typing indicators, message edit or delete | Not built |
| Cursor pagination, Last-Event-ID replay, WebSocket | Not built (pages and SSE only) |
| Social sign-in, biometric server-side login | Not built (biometrics may only gate local access to stored tokens) |
| Cancelled vehicles | Never visible to customers |

If the product needs one of these, raise it with the API maintainers first.

---

## 12. Environment facts

- **API base URL:** a placeholder per environment, set in the app's build configuration (not hard coded): `<API_BASE_URL_DEV>`, `<API_BASE_URL_STAGING>`, `<API_BASE_URL_PRODUCTION>`. Ask the maintainers for the real values privately. All use HTTPS. Do not send production credentials to a non-production environment or the reverse.
- **Customer zone switch:** the whole customer zone is mounted **only when its secret is configured** on the server (`CUSTOMER_JWT_SECRET`). If it is not, every path under `/api/customer/v1` answers `404 { "error": { "code": "NOT_FOUND", "message": "Route not found." } }`, including `/app/min-version`. Treat a 404 on `/app/min-version` as "this environment is not set up for customers" and show a configuration error in development builds.
- **Minimum app version setting:** `APP_MIN_VERSION` (format `1.2.3`, default `1.0.0`); read through `GET /app/min-version` (section 7.4).
- **Other server settings that change what you see:** `CUSTOMER_SELF_SIGNUP` (default true; when false, `register` does nothing and only customers created and enabled by staff can sign in, via forgot-password and reset-password); `CUSTOMER_FILE_CACHE_SECONDS` (file cache lifetime, default 300, 0 to 86400); `SSE_MAX_CONNECTIONS` (stream capacity). Email (verification codes, reset codes, notification emails) is sent only if an email provider is configured on the server; in an environment without one, codes are not delivered and the sign-up flow cannot be completed.
- **CORS** matters only for web builds; native apps are unaffected.

## 13. Changes and versioning

- This document carries a **contract version** (semantic: `MAJOR.MINOR.PATCH`) and a date at the top.
- **Additive changes** (a new endpoint, a new optional request field, a new key in a response object, a new `event` type, a new enum value) bump MINOR. Clients must ignore unknown keys and tolerate unknown enum values (map unknown alert events, document types and statuses to a generic display).
- **Breaking changes** (removing or renaming a field, changing a type or meaning, tightening a limit, removing an endpoint, changing an error code) bump MAJOR and are announced here, in the "Changelog" below, **before** they are deployed, with the date they take effect. A breaking change ships under a new path version (`/api/customer/v2`) when it cannot be made compatible; the old version keeps working until the date announced. The minimum-version endpoint (7.4) is how old app builds are told to update.
- Fixes to wording or examples bump PATCH.
- The contract test (`tests/customer-app-contract.test.ts`) fails when the code and this document disagree, so a change to a customer route or response cannot merge without updating this file and, where the change is visible to the app, this version.

### Changelog

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-29 | First full contract for the customer zone: auth, profile, preferences, devices, vehicles, files, link requests, alerts, chat, stream and presence, push. |
