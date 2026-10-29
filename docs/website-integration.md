# Website integration: the public API contract

**Contract version:** 1.0.0
**Date:** 2026-10-29

This is the exact contract between the CargoDev API and the FTJ public website. It is written for a developer who has never seen this repository. Everything here was taken from the code, and `tests/website-contract.test.ts` reads the JSON examples and numbers in this file and fails CI if the API stops matching them. If you change the API's public behaviour, change this file in the same PR (see [Changes and versioning](#9-changes-and-versioning)).

The rest of the API (`/api/v1`, `/api/customer/v1`) is not yours. Section 8 lists what the website must never do.

Placeholders used below: `https://api.example.test` is the API base URL, `https://img.example.test` is the public image host, `https://www.example.test` is the website origin. Your operator gives you the real values. All sample data is fake.

## Contents

1. [The routes at a glance](#1-the-routes-at-a-glance)
2. [Stock list](#2-stock-list)
3. [Stock detail](#3-stock-detail)
4. [Enquiry submission](#4-enquiry-submission)
5. [Errors](#5-errors)
6. [Headers, caching, CORS and the client IP](#6-headers-caching-cors-and-the-client-ip)
7. [Settings you need to know](#7-settings-you-need-to-know)
8. [What the website must never do](#8-what-the-website-must-never-do)
9. [Changes and versioning](#9-changes-and-versioning)

## 1. The routes at a glance

| Method | Path | Purpose | Success |
|---|---|---|---|
| GET | `/api/public/stock` | Published stock, filtered, sorted, paged | 200 |
| GET | `/api/public/stock/:slug` | One published vehicle | 200 |
| POST | `/api/public/enquiries` | The contact form | **202** |
| OPTIONS | any of the above | CORS preflight (answered by the CORS layer) | 204 |

These are the only routes under `/api/public`. There are no others.

**Who may call them:** anyone. There is no authentication. A token, cookie or `Authorization` header in the request is ignored, and the vehicle owner (organisation) is fixed on the server, never taken from the request.

**Feature flag:** the routes exist only when the API runs with `PUBLIC_STOCK_ENABLED=true` (default `false`). When it is off, every path above answers **404** with `{"error":{"code":"NOT_FOUND","message":"Route not found."}}`, exactly like any unknown URL; a preflight for them is still answered by the CORS layer, so treat the 404 on the real request as the signal.

```json contract:error-disabled
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Route not found."
  }
}
```

Every response is JSON in one of two envelopes: success `{ "data": ... }` or error `{ "error": { "code", "message", "fieldErrors?" } }` (section 5).

## 2. Stock list

`GET /api/public/stock`

### Query parameters

Every parameter is optional. The query string is **strict**: an unknown parameter is a 400. Repeating a parameter (`?make=a&make=b`) is not supported. Do **not** send a parameter with an empty value (`?make=`, `?yearMin=`): that is a 400 too, so leave it out. The exception is `q`, where an empty or blank value simply means "no search".

| Parameter | Type | Default | Min / max | Meaning |
|---|---|---|---|---|
| `page` | integer | `1` | 1 to 10000 | 1-based page number |
| `pageSize` | integer | `12` | 1 to **24** | Rows per page. 24 is the hard maximum; a larger value is a 400, not silently cut |
| `make` | text | none | 1 to 60 characters (after trimming) | Exact match, ignoring case |
| `model` | text | none | 1 to 60 | Exact match, ignoring case |
| `bodyType` | text | none | 1 to 40 | Exact match, ignoring case |
| `fuel` | text | none | 1 to 40 | Exact match, ignoring case |
| `transmission` | text | none | 1 to 40 | Exact match, ignoring case |
| `yearMin` | integer | none | 1950 to 2100 | Year is at least this |
| `yearMax` | integer | none | 1950 to 2100 | Year is at most this |
| `priceMin` | integer | none | 0 to 2000000000 | Price is at least this many **rupees (LKR)**, whole numbers |
| `priceMax` | integer | none | 0 to 2000000000 | Price is at most this many rupees |
| `mileageMax` | integer | none | 0 to 5000000 | Mileage in km is at most this |
| `q` | text | none | cut to 100 characters | Search text, see below |
| `sort` | one of the keys below | `newest` | | Order of the rows |

**Filters combine with AND.** A listing with no price never matches a `priceMin`/`priceMax` filter, and one with no year or mileage never matches a year or mileage filter.

**Values for the text filters** (`make`, `bodyType`, `fuel`, `transmission`) are free text typed by staff, so the website should not hard-code them. There is no endpoint that lists the available values; build your filter lists from the stock you have loaded, or ask the owner for the agreed vocabulary.

**`q` (search).** The value is trimmed and **cut to 100 characters** (longer input is accepted, not rejected). A blank value means no search. It matches listings whose `make` **or** `model` contains the text, ignoring case. It is plain text: `%`, `_` and `\` are treated as the literal characters they are, never as wildcards, so searching for `100%` finds only text containing `100%`. It does not search the description or the year.

**`sort` keys** (anything else is a 400):

| Key | Order |
|---|---|
| `newest` (default) | most recently published first |
| `priceAsc` | cheapest first |
| `priceDesc` | dearest first |
| `yearDesc` | newest model year first |
| `yearAsc` | oldest model year first |
| `mileageAsc` | lowest mileage first |

Ties are always broken by an internal id, so the order is stable and a vehicle never appears on two pages of the same sort. Listings with no price, year or mileage are ordered by the database's default handling of missing values (PostgreSQL: after the others when ascending, before them when descending). If the site must not show unpriced vehicles first on `priceDesc`/`yearDesc`, filter with `priceMin=0` / `yearMin=1950`, which excludes listings with no price / year.

### Pagination

Page-number pagination. The response carries the numbers; there is no `next` link or cursor:

- `total`: how many listings match all the filters (across all pages).
- `page`, `pageSize`: the values that were used (the defaults if you sent none).
- Another page exists when `page * pageSize < total`. The number of pages is `ceil(total / pageSize)`.
- A `page` past the end is **not** an error: it returns 200 with `rows: []` and the real `total`.

### Success response (200)

```json contract:stock-list
{
  "data": {
    "rows": [
      {
        "slug": "example-make-example-model-2020-a1b2c3",
        "make": "Example Make",
        "model": "Example Model",
        "year": 2020,
        "price": { "amount": 8500000, "currency": "LKR" },
        "mileageKm": 42000,
        "bodyType": "Sedan",
        "fuel": "Petrol",
        "transmission": "Automatic",
        "colour": "White",
        "publishedAt": "2026-01-15T09:30:00.000Z",
        "image": {
          "url": "https://img.example.test/stock/aaaaaaaaaaaaaaaa/11111111-1111-1111-1111-111111111111.jpg",
          "alt": "Front view"
        }
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 12
  }
}
```

**The stock card** has exactly these 12 keys, always present (a missing value is `null`, a key is never left out):

| Key | Type | Notes |
|---|---|---|
| `slug` | string | The address of the vehicle, see below |
| `make`, `model` | string | Never null |
| `year` | integer or null | |
| `price` | object or null | `{ "amount": number, "currency": "LKR" }`, see below |
| `mileageKm` | integer or null | Kilometres |
| `bodyType`, `fuel`, `transmission`, `colour` | string or null | Free text |
| `publishedAt` | string or null | ISO 8601 in UTC with milliseconds, e.g. `2026-01-15T09:30:00.000Z`. Set when the listing was published |
| `image` | object or null | The first (cover) image, `{ "url", "alt" }`; null if the vehicle has no image the API can address |

**`price`.** Always an object, never a bare number, or `null` when staff have not set a price (then show "Contact us", not 0). `currency` is always the string `"LKR"` (Sri Lankan rupees): there is no other currency, no conversion and no currency parameter. `amount` is a JSON **number holding whole rupees** (an integer, greater than 0, at most 2,000,000,000), exactly as staff entered it: the API does no rounding and sends no cents. Format it for display yourself (for example `Rs. 8,500,000`) and always show that it is LKR.

**`image` / `images[]` objects** have exactly the keys `url` (string) and `alt` (string or null):

- `url` is an absolute `https` address on the public image host (`<image host>/stock/<hash>/<id>.<jpg|png|webp>`). It is served straight from storage, not through the API: no CORS, rate limit or cookies are involved when a browser loads it in an `<img>`. The address of an image never changes and the file behind it is never replaced, so it can be cached for a long time.
- `alt` is the description staff typed, or `null`. When it is null, fall back to a text you build from make, model and year.
- There are **no size variants or thumbnails**: one original file per image (JPEG, PNG or WebP, at most 8 MB). Resize in the browser with CSS, or put an image CDN in front of the host.
- If the API has no public image host configured, no image has a URL: `image` is null and `images` is `[]` for every vehicle.

**Slug rules.** A slug is lower-case letters and digits separated by single hyphens, 1 to 120 characters (`^[a-z0-9]+(?:-[a-z0-9]+)*$`). The API generates it when the listing is created, from make, model and year plus six random hex characters (`example-make-example-model-2020-a1b2c3`). Treat it as an **opaque, stable identifier**: it does not change when staff edit the listing, and it is unique. It is the only identifier the public API exposes (no numeric or internal ids).

**What is in the list.** Only listings that staff have **published**. No status field is returned, because the only value that can ever appear is "published". A vehicle staff mark **sold**, move back to draft, or delete **disappears from the list** (and its detail page becomes a 404, section 3). Because successful GETs may be cached for 60 seconds (section 6), a vehicle can keep showing for up to a minute after that.

## 3. Stock detail

`GET /api/public/stock/:slug`

No query parameters (an unknown one is ignored on this route). `:slug` is a slug from the list.

### Success response (200)

The card, plus `description` and `images`:

```json contract:stock-detail
{
  "data": {
    "slug": "example-make-example-model-2020-a1b2c3",
    "make": "Example Make",
    "model": "Example Model",
    "year": 2020,
    "price": { "amount": 8500000, "currency": "LKR" },
    "mileageKm": 42000,
    "bodyType": "Sedan",
    "fuel": "Petrol",
    "transmission": "Automatic",
    "colour": "White",
    "publishedAt": "2026-01-15T09:30:00.000Z",
    "image": {
      "url": "https://img.example.test/stock/aaaaaaaaaaaaaaaa/11111111-1111-1111-1111-111111111111.jpg",
      "alt": "Front view"
    },
    "description": "A clean example with a full service history.",
    "images": [
      {
        "url": "https://img.example.test/stock/aaaaaaaaaaaaaaaa/11111111-1111-1111-1111-111111111111.jpg",
        "alt": "Front view"
      },
      {
        "url": "https://img.example.test/stock/aaaaaaaaaaaaaaaa/22222222-2222-2222-2222-222222222222.jpg",
        "alt": null
      }
    ]
  }
}
```

So the detail has 14 keys: the 12 card keys, `description` (string or null; plain text up to 5000 characters, line breaks are `\n`, render it as text and never as HTML) and `images` (array, possibly empty). `images` is in display order, the order staff arranged, and `image` is always the same object as `images[0]` (or null when `images` is empty). A published vehicle always has at least one image when it is published, so an empty `images` only happens when no image host is configured.

### Not found (404)

A slug that is unknown, malformed (not matching the slug rules, so no 400 here), belongs to a draft, a sold vehicle or a deleted one all give the **same** 404, so a visitor cannot tell a hidden vehicle from one that never existed:

```json contract:error-not-found
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Stock vehicle not found."
  }
}
```

Your site should show its own "no longer available" page for a 404 on a detail request, and may offer the list.

## 4. Enquiry submission

`POST /api/public/enquiries`, `Content-Type: application/json`.

### Body

The body is **strict**: an unknown field is a 400 (so a form cannot name an organisation, a staff member or a status). **Leave out an optional field that is blank**; sending `""` for `phone`, `stockSlug` or `turnstileToken` is a 400.

| Field | Type | Required | Rules |
|---|---|---|---|
| `name` | string | yes | Trimmed, 1 to 100 characters |
| `email` | string | yes | Trimmed, stored lower-case, a valid address, at most 150 characters |
| `phone` | string | no | 5 to 40 characters, only digits, spaces, `+ ( ) - .` |
| `message` | string | yes | Plain text, trimmed, 1 to 2000 characters. `\r\n` is turned into `\n`. Control characters other than line breaks and tabs are rejected. It is stored exactly as typed |
| `stockSlug` | string | no | A listing slug (up to 120 characters, slug rules above), so staff know which vehicle it is about. If it is not a currently published listing it is **silently dropped** and the enquiry is still accepted |
| `website` | string | no | The **honeypot** (below). Up to 300 characters |
| `turnstileToken` | string | see below | The Cloudflare Turnstile response token, 1 to 2048 characters |

The whole body may be at most **8 KB (8192 bytes)**. A larger body, or malformed JSON, or a content type other than JSON, is answered **400** `Invalid request.` (the API never sends 413 or 415 to the website).

```json
{
  "name": "Example Visitor",
  "email": "visitor@example.test",
  "phone": "+94 77 000 0000",
  "message": "Is this still available?",
  "stockSlug": "example-make-example-model-2020-a1b2c3",
  "turnstileToken": "token-from-the-turnstile-widget"
}
```

### The answer

When the request is valid the answer is **always `202 Accepted`** with the same body, whatever then happens to the enquiry:

```json contract:enquiry-accepted
{
  "data": {
    "accepted": true
  }
}
```

202 is returned when the enquiry was stored, when it was dropped as a bot (honeypot), and when its `stockSlug` was dropped. The website must show the same "Thank you, we will be in touch" message every time and must not try to tell these apart. Only an invalid body (400), a failed Turnstile check (400) or a rate limit (429) is ever reported.

### Honeypot (`website`)

Add a field named exactly `website` to the form that real visitors never see or fill in: hide it with CSS (not `type="hidden"`, which some bots skip), give it `tabindex="-1"` and `autocomplete="off"`, and either omit it or send `""` when it is empty. If a request arrives with a non-blank `website`, the API answers the normal **202**, stores nothing and tells nobody. Such a request still counts against the rate limits. (The check happens after body validation and before the Turnstile check, so a bot that fills it is never verified.)

### Turnstile (`turnstileToken`)

The API verifies the token with Cloudflare's siteverify service, passing the client IP it sees.

- **`TURNSTILE_SECRET` set on the API:** `turnstileToken` is required. A missing, wrong, expired or already-used token, or Cloudflare being unreachable, is a **400** `VALIDATION` with the message `Verification failed. Please try again.` and **no** `fieldErrors` (see the example in section 5). Get a fresh token from the widget and let the visitor try again; a token works once.
- **`TURNSTILE_SECRET` unset:** the check is skipped, no network call is made, and a `turnstileToken` is accepted and ignored.

The website cannot discover which mode the API is in, so always render the widget and always send the token when you have one; ask the operator which mode production uses.

### Rate limits

Counted per client IP address (and per email), see section 6 for which address that is. An enquiry that would be refused still uses up its place, and bots caught by the honeypot count too.

| Limit | Allowed | Window |
|---|---|---|
| Per IP, burst | 5 requests | 1 minute |
| Per IP | 10 requests | 1 hour |
| Per email address (trimmed, lower-case) | 3 requests | 1 hour |

Going over any of them is a **429** (section 5) with a `Retry-After` header in seconds (60 for the burst, 3600 for the hourly limits).

### What staff see afterwards

The enquiry is stored with the visitor's name, email, phone (if any), message and the vehicle slug (if it was a published listing), and starts as "open" in the staff enquiries inbox. Staff who can receive notifications get a notification titled "New website enquiry" saying who it is from (the name, cut at 60 characters), never the message text; they open the inbox to read it and mark it handled. **The API sends the visitor no email or confirmation**, and the website has no way to look an enquiry up afterwards. The message, email and phone are never written to a log.

## 5. Errors

Every error uses the envelope `{ "error": { "code", "message", "fieldErrors?" } }`. `fieldErrors` is present only on validation errors; it maps a field (or query parameter) name to one message for that field. Messages are for display or logging; **branch on the status code and `code`, never on message text** (the validation messages in particular come partly from a library and can change).

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION` | A bad query, a bad enquiry body, an unknown field or parameter, malformed JSON, a body over 8 KB, a failed Turnstile check |
| 404 | `NOT_FOUND` | Unknown, draft, sold or deleted slug; any route when the public API is switched off; any other unknown URL |
| 429 | `RATE_LIMITED` | A rate limit was exceeded |
| 500 | `INTERNAL` | Something unexpected broke server-side. The message is always the same and never explains why |

`202` is the enquiry success status (section 4). There is no 401 or 403 on these routes (they never ask who you are), and no 413 or 415 (those become 400).

**400 on a bad query** (`fieldErrors` is keyed by query parameter name):

```json contract:error-validation-query
{
  "error": {
    "code": "VALIDATION",
    "message": "Invalid query parameters.",
    "fieldErrors": {
      "pageSize": "Too big: expected number to be <=24",
      "sort": "Invalid option: expected one of \"newest\"|\"priceAsc\"|\"priceDesc\"|\"yearDesc\"|\"yearAsc\"|\"mileageAsc\""
    }
  }
}
```

**400 on a bad enquiry** (`fieldErrors` is keyed by body field name; show each message next to its field):

```json contract:error-validation-enquiry
{
  "error": {
    "code": "VALIDATION",
    "message": "Please fix the highlighted fields.",
    "fieldErrors": {
      "name": "Too small: expected string to have >=1 characters",
      "email": "Enter a valid email address",
      "message": "Message cannot be empty"
    }
  }
}
```

**400 on an unknown field or parameter** (the body or query contains something that is not allowed; `fieldErrors` is present but **empty**, so a form must not assume it names a field):

```json contract:error-validation-unknown-field
{
  "error": {
    "code": "VALIDATION",
    "message": "Please fix the highlighted fields.",
    "fieldErrors": {}
  }
}
```

**400 on malformed JSON, a wrong content type, or a body over 8 KB** (no `fieldErrors`):

```json contract:error-invalid-request
{
  "error": {
    "code": "VALIDATION",
    "message": "Invalid request."
  }
}
```

**400 when the Turnstile check fails** (no `fieldErrors`):

```json contract:error-verification-failed
{
  "error": {
    "code": "VALIDATION",
    "message": "Verification failed. Please try again."
  }
}
```

**429 when rate limited:**

```json contract:error-rate-limited
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests. Try again later."
  }
}
```

A 429 carries these headers: `Retry-After` (seconds to wait), `X-RateLimit-Limit` (the limit that applies to this route), `X-RateLimit-Remaining` (`0`) and `X-RateLimit-Reset` (seconds until the window resets). The same three `X-RateLimit-*` headers are on every successful response of a rate-limited route, so a client can slow down before it is refused. A 429 is never cached.

The 404 example is in section 3 and the "switched off" 404 in section 1.

## 6. Headers, caching, CORS and the client IP

### Caching

| Response | `Cache-Control` |
|---|---|
| Successful `GET /api/public/stock` and `GET /api/public/stock/:slug` (200) | `public, max-age=60` |
| The enquiry `POST` (202 and every other status) | `no-store` |
| Every error, on every route (400, 404, 429, 500) | `no-store` |

The only caching validator is the age: **there is no `ETag` and no `Last-Modified`**, so there are no conditional requests. Browsers and a CDN may reuse a successful GET for 60 seconds. Responses to different `Origin`s are kept apart by `Vary: Origin`. If the website caches these responses itself (a framework data cache, an ISR page), keep its lifetime short (60 seconds is the natural choice), because sold and unpublished vehicles only leave the API's answers, they are not announced.

### Security headers

Responses also carry the standard hardening headers (`X-Content-Type-Options: nosniff`, `Strict-Transport-Security`, and similar). They need no handling. The API is JSON only: call it with `fetch`, not from a `<script>`, `<img>` or `<iframe>` tag.

### CORS

Only relevant when a **browser** calls the API from a page. A server-to-server call from the website's backend has no CORS.

- The allowed origins are the exact list in the API's `PUBLIC_ALLOWED_ORIGINS` setting (scheme, host and port, no trailing slash, no path: `https://www.example.test`). The match is exact: `https://example.test` and `https://www.example.test` are different origins and both must be listed if both are used. The list can never be `*`: the API refuses to start with a wildcard. An origin that is not listed gets no `Access-Control-Allow-Origin` header, and the browser then blocks your code from reading the answer.
- The allowed origin is echoed back in `Access-Control-Allow-Origin` (with `Vary: Origin`). `Access-Control-Allow-Credentials` is **never** sent, so do not use `credentials: "include"`.
- **Preflight** (`OPTIONS`): answered `204` with `Access-Control-Allow-Methods: GET, POST, OPTIONS`, `Access-Control-Allow-Headers: Content-Type` and `Access-Control-Max-Age: 600` (browsers may remember the answer for 10 minutes). A preflight happens for the enquiry POST (a JSON body makes it non-simple); the plain GETs usually need none.
- Only the `Content-Type` request header is allowed. A request that adds anything else (`Authorization`, a custom header) fails the preflight. Do not add headers to these calls.
- The staff and customer apps' origins have no access to `/api/public`, and the website's origin has no CORS access to the rest of the API.

### Which client IP the rate limits see

The rate limits, and the `remoteip` sent to Turnstile, use the API's idea of the client address, controlled by its `CLIENT_IP_SOURCE` setting (set deliberately in production): `socket` (the TCP peer; every forwarding header is ignored), `hops` (the `X-Forwarded-For` entry added by exactly N trusted proxies) or `header` (one header that the hosting edge overwrites on every request).

- **The visitor's browser calls the API directly** (a `fetch` from your page): the API sees the visitor's own address, provided the operator configured `CLIENT_IP_SOURCE` to match the hosting in front of the API. Every visitor then has their own limits. This is the recommended way to send enquiries.
- **The website's server calls the API** (a server action, an API route, a server-side render): the API sees **the website server's address**, not the visitor's. A forwarding header you add (`X-Forwarded-For` and so on) is **ignored** in `socket` mode and cannot be trusted from you in the other modes. The effect: **all visitors share one set of limits**, so the whole site is limited to 5 enquiries a minute and 10 an hour in total, and one noisy visitor can block everyone. `GET`s are counted the same way (120 a minute per route for the whole server), which is why server-side rendering of the list should rely on caching (a short-lived cache, ideally 60 seconds, matches the API's own).
  If the website must send enquiries from its server, tell the operator so the limits and `CLIENT_IP_SOURCE` can be set up for it; do not try to forward addresses yourself.
- Requests answered from a browser or CDN cache never reach the API and use no limit.

## 7. Settings you need to know

Names only. The values are given by the operator; none is a secret except where stated, and a secret never goes into the website's front-end code.

| Setting | Where | What it means for the website |
|---|---|---|
| API base URL (placeholder `https://api.example.test`) | website | The origin your calls go to, followed by `/api/public/...`. Keep it in one setting. Never hard-code it |
| `PUBLIC_STOCK_ENABLED` | API | Must be `true` or every route is 404 (section 1) |
| `PUBLIC_ALLOWED_ORIGINS` | API | Your website's origin(s) must be listed, exactly, for browser calls (section 6) |
| `PUBLIC_STOCK_IMAGE_BASE_URL` (placeholder `https://img.example.test`) | API | The host image URLs point at. Allow this host in your site's content security policy (`img-src`) and in any image optimiser's allow-list. It is always `https` |
| `TURNSTILE_SECRET` | API (secret) | If set, the enquiry needs a valid `turnstileToken` (section 4) |
| Turnstile site key | website | The public key for the widget that produces the token. Not the secret |
| `CLIENT_IP_SOURCE` | API | Decides whether rate limits are per visitor or shared (section 6) |

## 8. What the website must never do

- **Never call `/api/v1`** (the staff API) **or `/api/customer/v1`** (the customer app API). They are not part of this contract, they need accounts, they are not open to your origin, and they can change or vanish without notice.
- **Never send credentials** to `/api/public`: no `Authorization` header (it also fails the CORS preflight), no cookies, no `credentials: "include"`. There is nothing to log in to.
- **Never store personal data from the enquiry form** beyond sending it: do not keep the name, email, phone or message in browser storage, cookies, analytics events, URLs, error reports or server logs, and do not write them to the website's own database. The API is the system of record. Keep the form in memory only, and do not log the request or response bodies of the enquiry call.
- Never put `TURNSTILE_SECRET` (or any API setting other than the public ones above) in the website's front-end code.
- Never build a vehicle's URL or identity from anything but its `slug`, and never assume a slug stays available: handle the 404.
- Never render `description`, `alt` or any other field as HTML. They are plain text.
- Never show a price without its currency, and never show `0` for a `null` price.
- Never rely on an exact error message, or on the order of keys in the JSON.
- Do not retry a 429 or a failed Turnstile check in a tight loop: wait for `Retry-After`.

A client should also tolerate **new keys** appearing in objects (see the next section): read the keys you need and ignore the rest.

## 9. Changes and versioning

The version at the top is `MAJOR.MINOR.PATCH`.

- **MAJOR (breaking):** removing or renaming a route, a query parameter, a body field or a response key; changing the type or meaning of a value (for example the shape of `price`); making an optional input required; tightening a limit (a smaller maximum page size, a lower rate limit); removing an allowed sort key, origin rule or header; changing a status code. Breaking changes are **announced to the website developer at least 30 days before** they reach production, with the new contract version and date, and where possible the old behaviour keeps working in parallel until the website has switched. An emergency security fix may be shorter notice, and is announced as soon as it is made.
- **MINOR (compatible):** a new optional query parameter, a new optional body field, a **new key in a response object**, a new sort key, a loosened limit, a new route under `/api/public`. These need no coordination, which is why a client must ignore keys it does not know.
- **PATCH:** wording and corrections in this document, with no change in behaviour.

How it is announced: the contract version and date in this file change, the change is described in the pull request that changes this file and the API (the doc, the code and `tests/website-contract.test.ts` always change together; CI fails if they drift), and the maintainer tells the website developer directly for MAJOR changes. Bumping the version is part of the same change.

The same numbers this document states are asserted in the test, as this machine-checked block (a change to any of them fails CI until this file is updated):

```json contract:limits
{
  "pagination": { "defaultPageSize": 12, "maxPageSize": 24, "maxPage": 10000 },
  "sorts": ["newest", "priceAsc", "priceDesc", "yearDesc", "yearAsc", "mileageAsc"],
  "cacheMaxAgeSeconds": 60,
  "searchMaxLength": 100,
  "bodyLimitBytes": 8192,
  "enquiry": {
    "nameMax": 100,
    "emailMax": 150,
    "phoneMin": 5,
    "phoneMax": 40,
    "messageMax": 2000,
    "stockSlugMax": 120,
    "websiteMax": 300,
    "turnstileTokenMax": 2048
  },
  "rateLimits": {
    "read": { "max": 120, "windowSeconds": 60 },
    "enquiryIpBurst": { "max": 5, "windowSeconds": 60 },
    "enquiryIpHour": { "max": 10, "windowSeconds": 3600 },
    "enquiryEmailHour": { "max": 3, "windowSeconds": 3600 }
  }
}
```

See also: [api-contract.md](api-contract.md) (the whole API, with a shorter summary of the public routes), [env.md](env.md) (the API's settings) and [launch-checklist-stock.md](launch-checklist-stock.md).
