# Architecture

## Layers

```
HTTP request
   |
routes/      thin: auth -> zod parse -> call service -> shape response
   |
services/    all business logic, framework-free, throws ServiceError
   |
Prisma       data access (PostgreSQL), always scoped by orgId
```

## Folder map

```
src/
  config/env.ts          validated environment (fails fast at startup)
  lib/errors.ts          ServiceError + error codes + HTTP status map
  lib/response.ts        { data } / { error } envelope helpers
  lib/error-handler.ts   one place turning any error into the envelope
  lib/events.ts          event bus interface + in-memory implementation
  lib/sse-hub.ts         owns every open notification stream
  scheduler/             in-process scheduler, advisory lock, daily job wrapper
  routes/                one file per resource (health, auth, vehicles, ...)
  services/              business logic (ported from CargoDev)
  app.ts                 builds the Fastify app (does not listen)
  server.ts              loads env, builds app, listens
```

`app.ts` builds, `server.ts` starts. Tests import `buildApp()` and use `app.inject()` with no open port.

## Request lifecycle

1. `onRequest` hook sets `Cache-Control: no-store`.
2. Auth hook verifies the access token and attaches `{ id, role, orgId, name, email }`.
3. Role allow-list for the route is checked (403 if not allowed).
4. Route parses input with zod.
5. Route calls a service with the user and parsed input.
6. Service runs the transaction: query (scoped by `orgId`), mutate, write `ActivityLog`.
7. Route returns `{ data }`. Any thrown error goes to the central handler.

## Live notifications and scheduled work

Pusher and external cron services are not used. This server is long-lived, so it does both itself.
It is built and tested for **one running instance**, and is written so that more than one cannot
cause duplicate work or duplicate events. See ADR 0003.

```
mutation (service)
  1. write rows + ActivityLog + Notification in ONE transaction   <- the truth
  2. transaction commits
  3. notifyRealtime(): publish one event per recipient on the bus, then send Expo push
                         |
            EventBus (src/lib/events.ts)   <- callers only know this interface
                         |
            SseHub (src/lib/sse-hub.ts) --> GET /notifications/stream  (one per open client)
```

- **Event bus.** `publish(event)` is called only AFTER the commit, never inside a transaction. It never
  throws and never blocks the caller; a failing subscriber cannot affect the publisher or other
  subscribers. Delivery is scoped to both `userId` and `orgId`.
- **SSE stream.** A convenience, not the truth: there is no replay. After (re)connecting, a client calls
  `GET /notifications` to catch up. A stream ends when its access token expires (the client reconnects
  with a fresh token), is capped per user and per instance, sends a heartbeat every 25 seconds, and is
  closed with `event: shutdown` when the server stops.
- **Scheduler.** One `setTimeout` per day (re-armed, never `setInterval`), `unref()`'d. On startup, if
  today's run time has already passed, the job runs once; that recovers a missed run without a
  bookkeeping table because the job is idempotent. Overlap is blocked in-process, and across instances by a
  Postgres advisory lock taken inside one transaction (`pg_try_advisory_xact_lock`, never the session-level
  lock, which a pooled connection can leak). The daily job iterates every org in the database.

### Single-instance assumption, and what would change for several

| Concern | Today (one instance) | With several instances |
|---|---|---|
| Notification events | In-memory bus: a stream sees events published in its own process | An event published on instance A would not reach a stream on instance B. Replace the bus with Postgres LISTEN/NOTIFY, which needs a **direct, non-pooled** connection (a transaction pooler drops LISTEN). Callers do not change. Not built. |
| Scheduled job | Runs in-process | The advisory lock already stops two instances running it at once. Sequential reruns (a deploy overlap) are safe only because the job is idempotent. Set `SCHEDULER_ENABLED=false` on instances that should not try. |
| Stream caps | Per instance | Per instance, so the effective cap multiplies by the instance count. |

## The customer read API (Phase 2, slice 3)

`routes/customer-data.ts` -> `customer-data.service.ts` / `customer-link-request.service.ts`. Everything starts from one filter, `customerVehicleWhere` (own id, same org, released, effective export track, not cancelled, not deleted). The customer-facing `status` is derived (shipping status overridden by the ARRIVED / DELIVERED milestones), so the status filter is SQL built on the existing effective-status clauses. Released photos and the milestones of a page of vehicles are loaded with one query each, never one per vehicle.

## Files, the customer file gateway and milestones (Phase 2, slice 2)

- **Store seam** (`src/lib/object-storage.ts`): one `ObjectStore` interface (`presignPut`, `getObject`, `deleteKey`). The implementation is `src/lib/r2-object-store.ts`, installed at startup when the four R2 credentials are set; tests install a recorder. Cloudflare R2 is reached through its S3-compatible API, so it uses the AWS SDK for JavaScript v3 with the endpoint `https://<account id>.r2.cloudflarestorage.com`, region `auto` and both checksum settings `WHEN_REQUIRED`.
- **Staff uploads** use a presigned PUT (300 s, exact size and content type, no checksum headers). The key is built by the server with the extension of the signed type. Staff downloads are unchanged: the stored public URL.
- **Customer downloads go through the API (the gateway).** The customer app asks for `/photos/:id/image` or `/documents/:id/file`; the API authorises (own vehicle, same org, export track, released; file released), reads the object with its own R2 credentials and streams it with safe headers (`nosniff`, private caching, ETag/304, inline for images and attachment for documents). The client never sees an R2 address, a key or a link.
- **Options considered.** (1) **API proxy, now:** simplest, one place for authorisation and logging, nothing private is exposed; costs API bandwidth and a connection per download. (2) **Cloudflare Worker gateway, later:** the same checks in front of a private bucket at the edge, with caching, offloading bytes from the API; it needs a signed token or a call back to the API for the decision and a separate deployment. (3) Presigned GET links for customers: rejected, because a link is a bearer secret that can be forwarded and cached. The API proxy is kept behind `openCustomerFile`, so a Worker can replace it without changing the authorisation rules.
- **Thumbnails:** made by `photo-thumbnail.service.ts` with `sharp` after a photo is added (best effort, never fatal), stored beside the photos folder. See ADR 0006 for how untrusted image bytes are handled.
- **Public stock images (slice 7)** will live in a SEPARATE public bucket served on a custom domain with long-cache headers and random ids, with nothing private in it, behind `PUBLIC_STOCK_ENABLED`. They are never mixed with the private bucket.
- **Milestones** (`milestone.service.ts`): a unique key on (vehicle, type); automation inserts with ON CONFLICT DO NOTHING inside the status-change transaction and, going down, removes only automatic milestones nobody touched (rule in ADR 0006).

## Planned: clean-up of expired rows (Phase 2, slice 5)

Nothing deletes expired rows yet: `OtpCode`, `CustomerSession` and the staff `RefreshToken` table only grow. They are
harmless (every read checks expiry and revocation) but unbounded. Slice 5 adds a second step to the daily job
(`src/scheduler/daily-checks-job.ts`, after the reminders, under the same advisory lock), planned as:

- `OtpCode`: delete rows whose `expiresAt` is more than 1 day old.
- `CustomerSession` and `RefreshToken`: delete rows whose `expiresAt` is more than 7 days old, or that were revoked more than 30 days ago (a short trail is kept so reuse detection still sees a recently rotated token).
- Batched (for example 1000 rows per statement) and idempotent; a failure is reported like any other check and does not stop the rest.
- Covered by a real-Postgres test (old rows go, recent and live rows stay).

## Customer zone

`/api/customer/v1` is a second API in the same process (ADR 0005): `routes/customer-auth.ts` -> `services/customer-*.service.ts`
-> Prisma, behind `plugins/customer-auth.ts` (`requireCustomer`). It shares the `User` table with staff but nothing else
on the request path: its own secret, token audience, session table and rate limits (`config/customer-rate-limits.ts`).
One-time codes live in `OtpCode`; email goes through `lib/email-queue.ts` after the response, so a request takes the same
time whether or not mail is sent.

## Key design choices

- Services are framework-free so they can be shared/ported and tested without HTTP.
- `orgId` always comes from the token, so a client cannot choose another tenant.
- This repo owns the schema and `prisma/migrations/` (ADR 0004). Migrations are additive-first because the old Next.js app may still be using the same database. They run through `npm run migrate`, which prints and scans the SQL before applying.
- Staff still read files through the stored public URLs. Customers never do: they go through the file gateway.
