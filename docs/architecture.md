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
- File URL generation is isolated behind one function so signed URLs can replace public ones later.
